import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const badRequest = (message, code = 'bad_request') => new HttpError(400, code, message);
export const notFound = (message = 'Not found') => new HttpError(404, 'not_found', message);
export const conflict = (message, code = 'conflict') => new HttpError(409, code, message);

export const newId = () => crypto.randomBytes(9).toString('base64url');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** Validates a single file or folder name. */
export function cleanName(name, what = 'Name') {
  if (typeof name !== 'string') throw badRequest(`${what} is required`, 'invalid_name');
  const n = name.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!n) throw badRequest(`${what} can't be empty`, 'invalid_name');
  if (n.length > 255) throw badRequest(`${what} must be 255 characters or fewer`, 'invalid_name');
  if (/[/\\]/.test(n)) throw badRequest(`${what} can't contain / or \\`, 'invalid_name');
  if (n === '.' || n === '..') throw badRequest(`${what} can't be "${n}"`, 'invalid_name');
  return n;
}

/** Splits "a/b\\c" into validated segments. Empty input gives []. */
export function splitPath(value) {
  if (value == null) return [];
  const raw = Array.isArray(value) ? value.join('/') : String(value);
  return raw
    .split(/[/\\]+/)
    .map((s) => s.trim())
    .filter((s) => s && s !== '.')
    .map((s) => cleanName(s, 'Path segment'));
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[key] = part.slice(i + 1).trim();
    }
  }
  return out;
}

/** Short human description of a browser user agent, for the Telegram sign-in prompt. */
export function describeUserAgent(ua = '') {
  const browser =
    (/Edg\//.test(ua) && 'Edge') ||
    (/OPR\//.test(ua) && 'Opera') ||
    (/Firefox\//.test(ua) && 'Firefox') ||
    (/Chrome\//.test(ua) && 'Chrome') ||
    (/Safari\//.test(ua) && 'Safari') ||
    (/curl\//i.test(ua) && 'curl') ||
    'Unknown browser';
  const os =
    (/Windows/.test(ua) && 'Windows') ||
    (/Android/.test(ua) && 'Android') ||
    (/iPhone|iPad|iPod/.test(ua) && 'iOS') ||
    (/Mac OS X/.test(ua) && 'macOS') ||
    (/Linux/.test(ua) && 'Linux') ||
    'unknown OS';
  return `${browser} on ${os}`;
}
