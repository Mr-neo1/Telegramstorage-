// Minimal Telegram Bot API client: JSON calls, document uploads and ranged downloads.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { sleep } from './util.js';

export class TelegramError extends Error {
  constructor(method, code, description, parameters) {
    super(`Telegram ${method} failed (${code}): ${description}`);
    this.method = method;
    this.code = code;
    this.description = description;
    this.parameters = parameters;
  }
}

const apiUrl = (method) => `${config.apiBase}/bot${config.botToken}/${method}`;
const fileUrl = (filePath) => `${config.apiBase}/file/bot${config.botToken}/${filePath}`;

/**
 * Calls a Bot API method. `params` is a plain object (sent as JSON) or a function
 * returning a FormData (rebuilt on every retry because bodies can't be replayed).
 * Retries network errors, 5xx responses and 429 rate limits.
 */
export async function call(method, params = {}, { signal, retries = 3, rateLimitRetries = 12 } = {}) {
  let attempt = 0;
  let rateLimited = 0;
  for (;;) {
    let res;
    let data = null;
    try {
      const init = { method: 'POST', signal };
      if (typeof params === 'function') {
        init.body = params();
      } else {
        init.headers = { 'content-type': 'application/json' };
        init.body = JSON.stringify(params);
      }
      res = await fetch(apiUrl(method), init);
      data = await res.json().catch(() => null);
    } catch (err) {
      if (signal?.aborted) throw err;
      if (attempt++ >= retries) {
        throw new TelegramError(method, 0, `network error (${err.cause?.code || err.message})`);
      }
      await sleep(Math.min(1000 * 2 ** attempt, 15000), signal);
      continue;
    }

    if (data?.ok) return data.result;

    const code = data?.error_code ?? res.status;
    const description = data?.description ?? res.statusText;
    if (code === 429 && rateLimited++ < rateLimitRetries) {
      const wait = (data?.parameters?.retry_after ?? 3) * 1000 + 250;
      await sleep(wait, signal);
      continue;
    }
    if (code >= 500 && attempt++ < retries) {
      await sleep(Math.min(1000 * 2 ** attempt, 15000), signal);
      continue;
    }
    throw new TelegramError(method, code, description, data?.parameters);
  }
}

/** Uploads a buffer as a document. Returns where Telegram stored it. */
export async function sendDocument(chatId, buffer, filename, { caption, signal } = {}) {
  const msg = await call(
    'sendDocument',
    () => {
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append('document', new Blob([buffer]), filename);
      if (caption) form.append('caption', caption.slice(0, 1024));
      form.append('disable_notification', 'true');
      form.append('disable_content_type_detection', 'true');
      return form;
    },
    { signal, retries: 4 },
  );
  const media =
    msg.document || msg.video || msg.audio || msg.animation || msg.voice || (msg.photo && msg.photo[msg.photo.length - 1]);
  if (!media) throw new TelegramError('sendDocument', 0, 'Telegram did not return a file');
  return {
    chatId: msg.chat.id,
    messageId: msg.message_id,
    fileId: media.file_id,
    fileUniqueId: media.file_unique_id,
  };
}

export function deleteMessage(chatId, messageId) {
  return call('deleteMessage', { chat_id: chatId, message_id: messageId }, { retries: 1, rateLimitRetries: 2 });
}

// getFile results stay valid for at least an hour.
const pathCache = new Map();
const PATH_TTL = 50 * 60 * 1000;

async function resolveFilePath(fileId, fresh, signal) {
  const hit = pathCache.get(fileId);
  if (!fresh && hit && Date.now() - hit.at < PATH_TTL) return hit.path;
  const info = await call('getFile', { file_id: fileId }, { signal });
  if (!info.file_path) throw new TelegramError('getFile', 0, 'Telegram returned no file path');
  pathCache.set(fileId, { path: info.file_path, at: Date.now() });
  if (pathCache.size > 5000) pathCache.delete(pathCache.keys().next().value);
  return info.file_path;
}

/**
 * Streams bytes [start, end] (inclusive) of a Telegram file.
 * Uses an HTTP Range request when the file server honours it, and skips bytes otherwise.
 */
export async function* readFile(fileId, start, end, signal) {
  for (let attempt = 0; ; attempt++) {
    const filePath = await resolveFilePath(fileId, attempt > 0, signal);

    // A self-hosted Bot API server in --local mode returns absolute paths on its own disk.
    if (path.isAbsolute(filePath) && fs.existsSync(filePath)) {
      yield* fs.createReadStream(filePath, { start, end, signal });
      return;
    }

    let res;
    try {
      res = await fetch(fileUrl(filePath), { headers: { range: `bytes=${start}-${end}` }, signal });
    } catch (err) {
      if (signal?.aborted || attempt >= 2) throw err;
      await sleep(1000 * (attempt + 1), signal);
      continue;
    }
    if ((res.status === 404 || res.status >= 500) && attempt < 2) {
      await res.body?.cancel();
      pathCache.delete(fileId);
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new TelegramError('download', res.status, res.statusText || 'download failed');
    }

    let skip = res.status === 206 ? 0 : start;
    let remaining = end - start + 1;
    for await (const piece of res.body) {
      let buf = Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength);
      if (skip) {
        if (buf.length <= skip) {
          skip -= buf.length;
          continue;
        }
        buf = buf.subarray(skip);
        skip = 0;
      }
      if (buf.length > remaining) buf = buf.subarray(0, remaining);
      remaining -= buf.length;
      yield buf;
      if (remaining <= 0) break;
    }
    if (remaining > 0) throw new TelegramError('download', 0, 'the download ended early');
    return;
  }
}

/** Downloads a whole (small) Telegram file into memory. */
export async function downloadSmall(fileId, signal) {
  const filePath = await resolveFilePath(fileId, false, signal);
  if (path.isAbsolute(filePath) && fs.existsSync(filePath)) return fs.promises.readFile(filePath);
  const res = await fetch(fileUrl(filePath), { signal });
  if (!res.ok) throw new TelegramError('download', res.status, res.statusText);
  return Buffer.from(await res.arrayBuffer());
}
