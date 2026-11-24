import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = path.join(ROOT_DIR, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const MiB = 1024 * 1024;

function int(value, fallback) {
  const n = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

function list(value) {
  return String(value ?? '')
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const apiBase = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').trim().replace(/\/+$/, '');
const usesOfficialApi = /^https:\/\/api\.telegram\.org$/i.test(apiBase);

// The public Bot API lets bots download files up to 20 MB, so files are split
// into parts below that. A self-hosted Bot API server allows up to 2000 MB.
const maxChunkMb = usesOfficialApi ? 19 : 1990;
let chunkMb = int(process.env.CHUNK_SIZE_MB, usesOfficialApi ? 18 : 1900);
if (chunkMb > maxChunkMb || chunkMb < 1) {
  console.warn(`CHUNK_SIZE_MB=${chunkMb} is outside 1..${maxChunkMb}; using ${Math.min(Math.max(chunkMb, 1), maxChunkMb)}.`);
  chunkMb = Math.min(Math.max(chunkMb, 1), maxChunkMb);
}

// Render (render.com) sets RENDER and RENDER_EXTERNAL_URL for every web service.
const onRender = !!process.env.RENDER;
const renderUrl = (process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/+$/, '');
const publicUrl = ((process.env.PUBLIC_URL || '').trim() || renderUrl).replace(/\/+$/, '');
const flag = (value, fallback) => (value === undefined || value === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase()));

const botToken = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const storageChatId = (process.env.TELEGRAM_STORAGE_CHAT_ID || '').trim() || null;
const allowedUserIds = list(process.env.ALLOWED_TELEGRAM_USER_IDS).map(Number).filter(Number.isFinite);
// Database backups go to the storage channel, or else to the first allowed user's chat with the bot.
const backupChatId = (process.env.BACKUP_CHAT_ID || '').trim() || storageChatId || (allowedUserIds[0] ? String(allowedUserIds[0]) : null);
const keepAliveUrl = flag(process.env.KEEP_ALIVE, true) ? ((process.env.KEEP_ALIVE_URL || '').trim() || renderUrl || null) : null;

export const config = {
  port: int(process.env.PORT, 8080),
  host: (process.env.HOST || (onRender ? '0.0.0.0' : '127.0.0.1')).trim(),
  publicUrl,
  secureCookies: publicUrl.startsWith('https://'),
  trustProxy: flag(process.env.TRUST_PROXY, onRender),
  onRender,
  dataDir: path.resolve(ROOT_DIR, process.env.DATA_DIR || 'data'),
  webDist: path.join(ROOT_DIR, 'web', 'dist'),

  botToken,
  storageChatId,
  allowedUserIds: new Set(allowedUserIds),
  apiBase,
  usesOfficialApi,
  /** Largest file the bot can download from Telegram (files sent to the bot in chat). */
  botDownloadLimit: usesOfficialApi ? 20 * 1000 * 1000 : 2000 * MiB,
  chunkSize: chunkMb * MiB,
  maxUploadBytes: int(process.env.MAX_UPLOAD_MB, 0) * MiB,

  /** Where the database is backed up in Telegram (null = no backups). */
  backupChatId: flag(process.env.BACKUP, true) && botToken ? backupChatId : null,
  backupQuietMs: int(process.env.BACKUP_QUIET_SECONDS, 15) * 1000,
  backupMaxDelayMs: int(process.env.BACKUP_MAX_DELAY_SECONDS, 120) * 1000,
  /** Pings this URL so free hosts that sleep when idle (Render) stay awake. */
  keepAliveUrl,
  keepAliveMs: Math.max(Number(process.env.KEEP_ALIVE_MINUTES) || 10, 0.05) * 60 * 1000,

  sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
  loginTtlMs: 10 * 60 * 1000,
};

export function isAllowedUser(telegramUserId) {
  return config.allowedUserIds.size === 0 || config.allowedUserIds.has(Number(telegramUserId));
}
