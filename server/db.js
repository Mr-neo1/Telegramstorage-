import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(config.dataDir, 'storage.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,          -- Telegram user id
    first_name    TEXT NOT NULL DEFAULT '',
    last_name     TEXT,
    username      TEXT,
    photo_file_id TEXT,
    created_at    INTEGER NOT NULL,
    last_login_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    user_agent TEXT,
    ip         TEXT
  );

  CREATE TABLE IF NOT EXISTS login_requests (
    code        TEXT PRIMARY KEY,               -- public, travels in the t.me link
    secret_hash TEXT NOT NULL,                  -- private, kept in the browser cookie
    status      TEXT NOT NULL DEFAULT 'pending',-- pending | awaiting | approved | denied | consumed
    user_id     INTEGER,
    user_json   TEXT,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    user_agent  TEXT,
    ip          TEXT
  );

  CREATE TABLE IF NOT EXISTS folders (
    id         TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_id  TEXT REFERENCES folders(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS folders_unique_name
    ON folders(user_id, ifnull(parent_id, ''), name COLLATE NOCASE) WHERE deleted_at IS NULL;
  CREATE INDEX IF NOT EXISTS folders_parent ON folders(parent_id);

  CREATE TABLE IF NOT EXISTS files (
    id         TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    folder_id  TEXT REFERENCES folders(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    mime_type  TEXT NOT NULL,
    sha256     TEXT,
    chunk_size INTEGER NOT NULL,
    source     TEXT NOT NULL DEFAULT 'web',     -- web | api | bot
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS files_unique_name
    ON files(user_id, ifnull(folder_id, ''), name COLLATE NOCASE) WHERE deleted_at IS NULL;
  CREATE INDEX IF NOT EXISTS files_folder ON files(folder_id);
  CREATE INDEX IF NOT EXISTS files_recent ON files(user_id, updated_at);

  -- Each file is stored as one or more Telegram documents ("chunks").
  CREATE TABLE IF NOT EXISTS chunks (
    file_id           TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    idx               INTEGER NOT NULL,
    size              INTEGER NOT NULL,
    tg_file_id        TEXT NOT NULL,
    tg_file_unique_id TEXT,
    chat_id           INTEGER NOT NULL,
    message_id        INTEGER NOT NULL,
    PRIMARY KEY (file_id, idx)
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id           TEXT PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    prefix       TEXT NOT NULL,
    key_hash     TEXT NOT NULL UNIQUE,
    scopes       TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at   INTEGER
  );

  -- Telegram messages that are no longer referenced and should be deleted.
  CREATE TABLE IF NOT EXISTS tg_cleanup (
    chat_id    INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

const statements = new Map();

/** Returns a cached prepared statement. */
export function q(sql) {
  let stmt = statements.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    statements.set(sql, stmt);
  }
  return stmt;
}

let depth = 0;

/** Runs fn inside a transaction (nested calls use savepoints). fn must be synchronous. */
export function tx(fn) {
  const sp = `sp${depth}`;
  db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
  depth++;
  try {
    const result = fn();
    depth--;
    db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
    return result;
  } catch (err) {
    depth--;
    db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw err;
  }
}

export function kvGet(key) {
  return q('SELECT value FROM kv WHERE key = ?').get(key)?.value ?? null;
}

export function kvSet(key, value) {
  q('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}
