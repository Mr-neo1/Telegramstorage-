// Backs the SQLite database up to Telegram and restores it on a fresh disk.
//
// Free hosts like Render wipe the disk on every restart and deploy. The database is the
// index of folders, names and where each file's parts live, so it is kept as a pinned
// document in Telegram: one message, whose file is replaced after every batch of changes.
// When the server starts without a database, it downloads the pinned copy first.
//
// This module must not import db.js at the top level: restoring happens before the database opens.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { config } from './config.js';
import * as tg from './telegram.js';
import { formatBytes, sleep } from './util.js';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export const DB_FILE = path.join(config.dataDir, 'storage.db');
const BACKUP_NAME = 'telegram-storage-backup.db.gz';
const SQLITE_HEADER = 'SQLite format 3\u0000';

const isBackup = (msg) => typeof msg?.document?.file_name === 'string' && msg.document.file_name.startsWith('telegram-storage-backup');

class FatalRestoreError extends Error {}

let restoredMessageId = null;

/** Downloads the latest backup if there is no database on disk yet. */
export async function restoreIfMissing() {
  if (fs.existsSync(DB_FILE) && fs.statSync(DB_FILE).size > 0) return;

  if (!config.backupChatId) {
    if (config.onRender) {
      console.warn(
        '! Backups are off (set ALLOWED_TELEGRAM_USER_IDS or TELEGRAM_STORAGE_CHAT_ID). ' +
          'Render wipes the disk on restart, so your folder list will be lost each time.',
      );
    }
    return;
  }

  for (let attempt = 1; ; attempt++) {
    try {
      const chat = await tg.call('getChat', { chat_id: config.backupChatId });
      const pinned = chat.pinned_message;
      if (!pinned) {
        console.log('  No database backup in Telegram yet, starting with an empty database.');
        return;
      }
      if (!isBackup(pinned)) {
        throw new FatalRestoreError(
          `The most recently pinned message in chat ${config.backupChatId} isn't a Telegram Storage backup, ` +
            'so the database can\'t be restored. Unpin that message in Telegram (the backup is the pinned ' +
            `"${BACKUP_NAME}" file) and restart. To start with an empty database instead, set BACKUP_SKIP_RESTORE=1.`,
        );
      }
      const packed = await tg.downloadSmall(pinned.document.file_id);
      const raw = await gunzip(packed);
      if (raw.subarray(0, 16).toString('latin1') !== SQLITE_HEADER) {
        throw new FatalRestoreError('The pinned backup file is damaged (it isn\'t a SQLite database).');
      }
      fs.mkdirSync(config.dataDir, { recursive: true });
      for (const suffix of ['-wal', '-shm', '-journal']) fs.rmSync(DB_FILE + suffix, { force: true });
      fs.writeFileSync(`${DB_FILE}.restoring`, raw);
      fs.renameSync(`${DB_FILE}.restoring`, DB_FILE);
      restoredMessageId = pinned.message_id;
      const when = new Date((pinned.edit_date ?? pinned.date) * 1000).toISOString().replace('T', ' ').slice(0, 16);
      console.log(`✓ Restored the database from Telegram (backup from ${when} UTC, ${formatBytes(raw.length)})`);
      return;
    } catch (err) {
      if (process.env.BACKUP_SKIP_RESTORE === '1') {
        console.warn(`! Restore skipped (BACKUP_SKIP_RESTORE=1): ${err.message}`);
        return;
      }
      if (err instanceof FatalRestoreError) {
        console.error(`✗ ${err.message}`);
        process.exit(1);
      }
      // 400/403: the chat doesn't exist for this bot yet (for example, you never pressed Start), so there is no backup.
      if (err instanceof tg.TelegramError && (err.code === 400 || err.code === 403)) {
        console.warn(`! Can't read backups from chat ${config.backupChatId} (${err.description}). Starting with an empty database.`);
        return;
      }
      if (attempt >= 5) {
        // Never start empty while a backup might exist: an empty database would replace it.
        console.error(`✗ Couldn't reach Telegram to restore the database (${err.message}). Exiting so the host restarts the app.`);
        process.exit(1);
      }
      console.warn(`  Couldn't reach Telegram to restore the database, retrying (${attempt}/5)…`);
      await sleep(3000 * attempt);
    }
  }
}

/** Watches the database for changes and keeps the pinned backup up to date. */
export async function startBackups() {
  if (!config.backupChatId) return;
  const { db, kvGet, kvSet } = await import('./db.js');

  if (restoredMessageId) kvSet('backup_message_id', restoredMessageId);
  const totalChanges = () => db.prepare('SELECT total_changes() AS n').get().n;

  // -1 forces a first backup when this database has never been backed up.
  let saved = kvGet('backup_message_id') ? totalChanges() : -1;
  let lastSeen = totalChanges();
  let lastChangeAt = Date.now();
  let dirtySince = saved === -1 ? Date.now() - config.backupMaxDelayMs : null;
  let running = false;
  let failures = 0;

  const backup = async () => {
    const tmp = path.join(os.tmpdir(), `telegram-storage-${process.pid}-${Date.now()}.db`);
    try {
      db.exec(`VACUUM INTO '${tmp.replaceAll("'", "''")}'`);
      const packed = await gzip(fs.readFileSync(tmp), { level: 9 });
      const caption =
        `Telegram Storage database backup, ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC.\n` +
        'Keep this message pinned: after a restart the app restores your folders and file list from it.';
      if (config.usesOfficialApi && packed.length > 19.5 * 1000 * 1000) {
        console.warn(`! The database backup is ${formatBytes(packed.length)}, over the 20 MB a bot can download, so it couldn't be restored.`);
      }

      const chatId = config.backupChatId;
      const existing = Number(kvGet('backup_message_id')) || null;
      let updated = false;
      if (existing) {
        try {
          await tg.call('editMessageMedia', () => {
            const form = new FormData();
            form.append('chat_id', String(chatId));
            form.append('message_id', String(existing));
            form.append('media', JSON.stringify({ type: 'document', media: 'attach://backup', caption, disable_content_type_detection: true }));
            form.append('backup', new Blob([packed]), BACKUP_NAME);
            return form;
          });
          updated = true;
        } catch (err) {
          if (/not modified/i.test(err.description || '')) updated = true;
        }
      }
      if (!updated) {
        const sent = await tg.sendDocument(chatId, packed, BACKUP_NAME, { caption });
        try {
          await tg.call('pinChatMessage', { chat_id: chatId, message_id: sent.messageId, disable_notification: true });
        } catch (err) {
          console.warn(
            `! Couldn't pin the backup message (${err.description || err.message}). Pin it in Telegram yourself, ` +
              'otherwise the app can\'t find it after a restart. In a channel, the bot needs permission to edit messages.',
          );
        }
        if (existing) {
          await tg.call('unpinChatMessage', { chat_id: chatId, message_id: existing }).catch(() => {});
          await tg.deleteMessage(chatId, existing).catch(() => {});
        }
        kvSet('backup_message_id', sent.messageId);
        console.log(`✓ Database backed up to Telegram (pinned in chat ${chatId})`);
      }
      kvSet('backup_at', Date.now());
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  };

  const tick = async (final = false) => {
    if (running) return;
    const n = totalChanges();
    if (n !== lastSeen) {
      lastSeen = n;
      lastChangeAt = Date.now();
      dirtySince ??= Date.now();
    }
    if (n === saved) return;
    const quiet = Date.now() - lastChangeAt >= config.backupQuietMs;
    const overdue = dirtySince !== null && Date.now() - dirtySince >= config.backupMaxDelayMs;
    if (!final && !quiet && !overdue) return;
    // After a failure, wait a little longer before trying again.
    if (!final && failures && Date.now() - lastChangeAt < Math.min(failures * 30_000, 300_000)) return;
    running = true;
    try {
      await backup();
      saved = totalChanges();
      lastSeen = saved;
      dirtySince = null;
      failures = 0;
    } catch (err) {
      failures++;
      console.error(`✗ Database backup failed: ${err.message}`);
    } finally {
      running = false;
    }
  };

  setInterval(() => tick(), 5000).unref();

  // Hosts send SIGTERM before stopping the app (Render: on every deploy and restart).
  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    const force = setTimeout(() => process.exit(0), 9000);
    try {
      while (running) await sleep(200);
      if (totalChanges() !== saved) {
        console.log(`${signal}: saving the latest changes to Telegram before stopping…`);
        await tick(true);
      }
    } finally {
      clearTimeout(force);
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

/** Requests our own public URL every few minutes so free hosts don't put the app to sleep. */
export function startKeepAlive() {
  const url = config.keepAliveUrl;
  if (!url) return;
  const ping = () =>
    fetch(`${url}/api/health`, { signal: AbortSignal.timeout(30_000), headers: { 'user-agent': 'telegram-storage-keepalive' } })
      .then((r) => {
        if (!r.ok) console.warn(`! Keep-alive ping got HTTP ${r.status}`);
      })
      .catch((err) => console.warn(`! Keep-alive ping failed: ${err.cause?.code || err.message}`));
  setTimeout(ping, 30_000);
  setInterval(ping, config.keepAliveMs);
  console.log(`  Keep-alive: visiting ${url} every ${Math.round(config.keepAliveMs / 60000) || '<1'} minutes so it doesn't sleep`);
}
