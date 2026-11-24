// Interactive setup: connects a Telegram bot, picks where files are stored, and writes .env.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = process.env.SETUP_ENV_FILE || path.join(ROOT, '.env');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

function readEnv() {
  const env = {};
  if (!fs.existsSync(ENV_FILE)) return env;
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

async function tg(token, method, params = {}) {
  const base = (process.env.TELEGRAM_API_BASE || env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
  const res = await fetch(`${base}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json().catch(() => ({ ok: false, description: res.statusText, error_code: res.status }));
  if (!data.ok) {
    const err = new Error(data.description || 'Telegram request failed');
    err.code = data.error_code;
    throw err;
  }
  return data.result;
}

/** Long-polls getUpdates until `match` returns something. */
async function waitFor(token, allowed, match, seconds = 180) {
  let offset = 0;
  const deadline = Date.now() + seconds * 1000;
  // Skip anything that arrived before we started waiting.
  const old = await tg(token, 'getUpdates', { offset: -1, timeout: 0, allowed_updates: allowed });
  if (old.length) offset = old[old.length - 1].update_id + 1;
  while (Date.now() < deadline) {
    const updates = await tg(token, 'getUpdates', { offset, timeout: 20, allowed_updates: allowed });
    for (const u of updates) {
      offset = u.update_id + 1;
      const hit = match(u);
      if (hit) {
        await tg(token, 'getUpdates', { offset, timeout: 0, allowed_updates: allowed }).catch(() => {});
        return hit;
      }
    }
  }
  return null;
}

async function choose(question, options, fallback = 1) {
  console.log(`\n${bold(question)}`);
  options.forEach((o, i) => console.log(`  ${i + 1}) ${o}`));
  for (;;) {
    const a = (await rl.question(`Choose 1-${options.length} [${fallback}]: `)).trim();
    const n = a === '' ? fallback : Number(a);
    if (n >= 1 && n <= options.length) return n;
  }
}

const env = readEnv();

console.log(`\n${bold('Telegram Storage setup')}`);
console.log(dim('This connects a Telegram bot and writes your settings to .env. Stop the server before running it.\n'));

// ---------------------------------------------------------------- bot token
let token = env.TELEGRAM_BOT_TOKEN || '';
let me = null;
for (;;) {
  if (!token) {
    console.log(`1. In Telegram, open ${bold('@BotFather')} and send ${bold('/newbot')}.`);
    console.log('2. Pick a name and a username for the bot.');
    console.log('3. Copy the token it sends you (it looks like 123456789:AA...).\n');
  }
  const answer = (await rl.question(token ? `Bot token [keep current ${token.slice(0, 6)}…]: ` : 'Bot token: ')).trim();
  if (answer) token = answer;
  if (!token) continue;
  try {
    me = await tg(token, 'getMe');
    console.log(green(`✓ Connected to @${me.username}`));
    break;
  } catch (err) {
    console.log(red(`✗ ${err.code === 401 || err.code === 404 ? 'Telegram rejected that token.' : `Couldn't reach Telegram: ${err.message}`}`));
    token = '';
  }
}
try {
  await tg(token, 'deleteWebhook', {});
} catch {
  /* not fatal */
}

// ---------------------------------------------------------------- storage chat
let storageChatId = env.TELEGRAM_STORAGE_CHAT_ID || '';
const storeChoice = await choose('Where should your files be kept in Telegram?', [
  `In a private channel ${dim('(recommended: one tidy place, and your chat with the bot stays clean)')}`,
  `In each person's private chat with @${me.username} ${dim('(no setup)')}`,
  ...(storageChatId ? [`Keep the current setting (${storageChatId})`] : []),
]);
if (storeChoice === 1) {
  console.log(`\n1. In Telegram, create a new ${bold('private channel')} (for example "My storage").`);
  console.log(`2. Open the channel's administrators and add ${bold('@' + me.username)}.`);
  console.log('   Allow it to post messages and delete messages.');
  console.log('3. Post any message in the channel, like "hello".\n');
  console.log(dim('Waiting for the channel… (up to 3 minutes)'));
  try {
    const chat = await waitFor(token, ['channel_post', 'my_chat_member', 'message'], (u) => {
      const c = u.channel_post?.chat || u.my_chat_member?.chat || u.message?.chat;
      return c && (c.type === 'channel' || c.type === 'supergroup') ? c : null;
    });
    if (chat) {
      storageChatId = String(chat.id);
      console.log(green(`✓ Found "${chat.title}" (${chat.id}). Files will be stored there.`));
    } else {
      console.log(red('✗ No channel showed up. Files will go to the private chat with the bot; run setup again to change this.'));
      storageChatId = '';
    }
  } catch (err) {
    if (err.code === 409) console.log(red('✗ The server is running and reading the bot. Stop it, then run setup again.'));
    else console.log(red(`✗ ${err.message}`));
    process.exit(1);
  }
} else if (storeChoice === 2) {
  storageChatId = '';
}

// ---------------------------------------------------------------- who can sign in
let allowed = env.ALLOWED_TELEGRAM_USER_IDS || '';
const whoChoice = await choose('Who can sign in?', [
  `Only me ${dim('(recommended)')}`,
  'Anyone who finds the bot (each person gets their own private files)',
  ...(allowed ? [`Keep the current list (${allowed})`] : []),
]);
if (whoChoice === 1) {
  console.log(`\nIn Telegram, open ${bold('@' + me.username)} and press ${bold('Start')} (or send it any message).`);
  console.log(dim('Waiting for your message… (up to 3 minutes)'));
  try {
    const from = await waitFor(token, ['message'], (u) => (u.message?.chat?.type === 'private' ? u.message.from : null));
    if (from) {
      allowed = String(from.id);
      console.log(green(`✓ Only ${from.first_name}${from.username ? ` (@${from.username})` : ''}, ID ${from.id}, can sign in.`));
      await tg(token, 'sendMessage', { chat_id: from.id, text: 'Setup is done. Only you can sign in to this storage.' }).catch(() => {});
    } else {
      console.log(red('✗ No message arrived. Anyone will be able to sign in until you run setup again.'));
      allowed = '';
    }
  } catch (err) {
    if (err.code === 409) console.log(red('✗ The server is running and reading the bot. Stop it, then run setup again.'));
    else console.log(red(`✗ ${err.message}`));
    process.exit(1);
  }
} else if (whoChoice === 2) {
  allowed = '';
}

// ---------------------------------------------------------------- port
const portAnswer = (await rl.question(`\nPort for the web app [${env.PORT || 8080}]: `)).trim();
const port = portAnswer || env.PORT || '8080';

// ---------------------------------------------------------------- write .env
const values = {
  ...env,
  TELEGRAM_BOT_TOKEN: token,
  TELEGRAM_STORAGE_CHAT_ID: storageChatId,
  ALLOWED_TELEGRAM_USER_IDS: allowed,
  PORT: port,
};
const known = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_STORAGE_CHAT_ID', 'ALLOWED_TELEGRAM_USER_IDS', 'PORT', 'HOST', 'PUBLIC_URL'];
const lines = [
  '# Written by "npm run setup". See .env.example for every option.',
  `TELEGRAM_BOT_TOKEN=${values.TELEGRAM_BOT_TOKEN}`,
  `TELEGRAM_STORAGE_CHAT_ID=${values.TELEGRAM_STORAGE_CHAT_ID}`,
  `ALLOWED_TELEGRAM_USER_IDS=${values.ALLOWED_TELEGRAM_USER_IDS}`,
  `PORT=${values.PORT}`,
  `HOST=${values.HOST || '127.0.0.1'}`,
  `PUBLIC_URL=${values.PUBLIC_URL || ''}`,
  ...Object.entries(values)
    .filter(([k]) => !known.includes(k))
    .map(([k, v]) => `${k}=${v}`),
  '',
];
fs.writeFileSync(ENV_FILE, lines.join('\n'));
console.log(green(`\n✓ Saved settings to ${ENV_FILE}`));
console.log(`\nNext:\n  ${bold('npm run build')}   ${dim('(once, and after updating the code)')}\n  ${bold('npm start')}\n  Open ${bold(`http://localhost:${port}`)}\n`);
rl.close();
