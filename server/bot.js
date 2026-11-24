// The Telegram bot: confirms sign-ins and saves files people send to it in chat.
import { config, isAllowedUser } from './config.js';
import { kvGet, kvSet, q } from './db.js';
import { beginTelegramLogin, finishTelegramLogin } from './auth.js';
import * as storage from './storage.js';
import * as tg from './telegram.js';
import { formatBytes, sleep } from './util.js';

const INBOX = 'Telegram Inbox';

let state = { status: config.botToken ? 'starting' : 'missing', username: null, error: null };

export function botState() {
  return {
    configured: !!config.botToken,
    status: state.status,
    username: state.username,
    error: state.status === 'missing' ? 'TELEGRAM_BOT_TOKEN is not set. Run "npm run setup" and restart the server.' : state.error,
  };
}

export async function startBot() {
  if (!config.botToken) {
    console.warn('! TELEGRAM_BOT_TOKEN is not set. Run "npm run setup" to connect a bot.');
    return;
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const me = await tg.call('getMe', {}, { retries: 1 });
      state = { status: 'ready', username: me.username, error: null };
      console.log(`✓ Telegram bot @${me.username} is connected`);
      break;
    } catch (err) {
      if (err.code === 401 || err.code === 404) {
        state = { status: 'error', username: null, error: 'Telegram rejected the bot token. Check TELEGRAM_BOT_TOKEN in .env.' };
        console.error(`✗ ${state.error}`);
        return;
      }
      state = { status: 'error', username: null, error: `Can't reach Telegram (${err.description || err.message}). Retrying…` };
      if (attempt === 0) console.error(`✗ ${state.error}`);
      await sleep(Math.min(5000 * (attempt + 1), 30000));
    }
  }

  if (config.storageChatId) {
    try {
      const chat = await tg.call('getChat', { chat_id: config.storageChatId });
      console.log(`✓ Files are stored in "${chat.title || chat.id}"`);
    } catch (err) {
      console.error(`✗ Can't open storage chat ${config.storageChatId}: ${err.description}. Is the bot an admin there?`);
    }
  } else {
    console.log('  Files are stored in each user\'s private chat with the bot (no TELEGRAM_STORAGE_CHAT_ID set)');
  }
  if (config.allowedUserIds.size === 0) {
    console.warn('! ALLOWED_TELEGRAM_USER_IDS is empty: any Telegram user who finds the bot can sign in and store files.');
  }

  await tg.call('deleteWebhook', {}).catch(() => {});
  tg.call('setMyCommands', { commands: [{ command: 'start', description: 'About this storage' }] }).catch(() => {});
  poll();
}

async function poll() {
  let offset = Number(kvGet('bot_offset') || 0);
  let conflictLogged = false;
  for (;;) {
    try {
      const updates = await tg.call(
        'getUpdates',
        { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] },
        { retries: 0, rateLimitRetries: 0 },
      );
      conflictLogged = false;
      for (const update of updates) {
        offset = update.update_id + 1;
        kvSet('bot_offset', offset);
        handleUpdate(update).catch((err) => console.error('Bot update failed:', err.message));
      }
    } catch (err) {
      if (err.code === 409 && !conflictLogged) {
        console.error('✗ Another program is reading this bot\'s updates (409). Stop it so sign-in can work.');
        conflictLogged = true;
      }
      await sleep(err.code === 409 ? 10000 : 3000);
    }
  }
}

const send = (chatId, text, extra = {}) =>
  tg.call('sendMessage', { chat_id: chatId, text, link_preview_options: { is_disabled: true }, ...extra });

async function handleUpdate(update) {
  if (update.callback_query) return onCallback(update.callback_query);
  const msg = update.message;
  if (!msg || msg.chat?.type !== 'private' || !msg.from) return;

  const text = msg.text?.trim() ?? '';
  if (text.startsWith('/start')) {
    const param = text.split(/\s+/)[1] ?? '';
    if (param.startsWith('login_')) return onLoginStart(msg, param.slice('login_'.length));
    return onWelcome(msg);
  }

  const media = extractMedia(msg);
  if (media) return onIncomingFile(msg, media);
  if (text) return onWelcome(msg);
}

async function onWelcome(msg) {
  const where = config.publicUrl ? `Open ${config.publicUrl} to manage your files.` : 'Open the Telegram Storage web app to manage your files.';
  await send(
    msg.chat.id,
    `Hi ${msg.from.first_name}. This bot keeps the files for Telegram Storage.\n\n${where}\n\n` +
      `You can also send me a file here and I'll save it to the "${INBOX}" folder.`,
  );
}

async function onLoginStart(msg, code) {
  const result = beginTelegramLogin(code, msg.from);
  if (!result.ok) return send(msg.chat.id, result.text);
  await send(msg.chat.id, result.text, {
    reply_markup: {
      inline_keyboard: [[
        { text: 'Approve sign-in', callback_data: `login:ok:${code}` },
        { text: 'Deny', callback_data: `login:no:${code}` },
      ]],
    },
  });
}

async function onCallback(cb) {
  const [ns, action, code] = String(cb.data || '').split(':');
  if (ns !== 'login' || !code) return tg.call('answerCallbackQuery', { callback_query_id: cb.id });

  const result = finishTelegramLogin(code, cb.from, action === 'ok');
  await tg.call('answerCallbackQuery', { callback_query_id: cb.id, text: result.ok ? undefined : result.text }).catch(() => {});
  if (cb.message) {
    await tg
      .call('editMessageText', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, text: result.text })
      .catch(() => {});
  }
  if (result.approved) saveProfilePhoto(cb.from.id).catch(() => {});
}

async function saveProfilePhoto(userId) {
  const photos = await tg.call('getUserProfilePhotos', { user_id: userId, limit: 1 });
  const sizes = photos.photos?.[0];
  if (!sizes?.length) return;
  const pick = sizes.find((s) => s.width >= 160) || sizes[sizes.length - 1];
  q('UPDATE users SET photo_file_id = ? WHERE id = ?').run(pick.file_id, userId);
}

function stamp(unix) {
  const d = new Date(unix * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

function extractMedia(msg) {
  const s = stamp(msg.date);
  const pick = (m, name, mimeType) => ({ fileId: m.file_id, fileUniqueId: m.file_unique_id, size: m.file_size, name, mimeType });
  if (msg.document) return pick(msg.document, msg.document.file_name || `Document ${s}`, msg.document.mime_type);
  if (msg.photo?.length) return pick(msg.photo[msg.photo.length - 1], `Photo ${s}.jpg`, 'image/jpeg');
  if (msg.video) return pick(msg.video, msg.video.file_name || `Video ${s}.mp4`, msg.video.mime_type || 'video/mp4');
  if (msg.audio) {
    const title = [msg.audio.performer, msg.audio.title].filter(Boolean).join(' - ');
    return pick(msg.audio, msg.audio.file_name || `${title || `Audio ${s}`}.mp3`, msg.audio.mime_type || 'audio/mpeg');
  }
  if (msg.voice) return pick(msg.voice, `Voice message ${s}.ogg`, msg.voice.mime_type || 'audio/ogg');
  if (msg.video_note) return pick(msg.video_note, `Video message ${s}.mp4`, 'video/mp4');
  if (msg.animation) return pick(msg.animation, msg.animation.file_name || `Animation ${s}.mp4`, msg.animation.mime_type || 'video/mp4');
  return null;
}

async function onIncomingFile(msg, media) {
  const reply = (text) => send(msg.chat.id, text, { reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } });
  const user = q('SELECT * FROM users WHERE id = ?').get(msg.from.id);
  if (!isAllowedUser(msg.from.id)) return reply("This storage is private, so I can't save files for you.");
  if (!user) return reply('Sign in to the Telegram Storage web app once, then send files here to save them.');

  if (media.size && media.size > config.botDownloadLimit) {
    return reply(
      `This file is ${formatBytes(media.size)}. Telegram only lets bots read files up to 20 MB, ` +
        'so upload it from the web app instead. Files uploaded there can be any size.',
    );
  }
  let size = media.size;
  try {
    const info = await tg.call('getFile', { file_id: media.fileId });
    size = info.file_size ?? size;
  } catch (err) {
    return reply(`I couldn't read this file from Telegram: ${err.description || err.message}`);
  }
  if (!Number.isFinite(size)) return reply("Telegram didn't tell me this file's size, so I couldn't save it.");

  const folderId = storage.ensureFolderPath(user.id, null, [INBOX]);
  const file = storage.saveTelegramFile(user.id, {
    folderId,
    name: media.name,
    mimeType: media.mimeType,
    size,
    fileId: media.fileId,
    fileUniqueId: media.fileUniqueId,
    chatId: msg.chat.id,
    messageId: msg.message_id,
  });
  await reply(`Saved to ${INBOX} as "${file.name}" (${formatBytes(file.size)}).`);
}
