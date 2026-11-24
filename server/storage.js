// Files and folders: metadata lives in SQLite, file bytes live in Telegram.
import { createHash } from 'node:crypto';
import mime from 'mime-types';
import { config } from './config.js';
import { q, tx } from './db.js';
import * as tg from './telegram.js';
import { HttpError, badRequest, cleanName, conflict, formatBytes, newId, notFound, sleep } from './util.js';

const now = () => Date.now();

// ---------------------------------------------------------------- serialization

export function folderJson(f, extra) {
  return {
    kind: 'folder',
    id: f.id,
    name: f.name,
    parentId: f.parent_id ?? null,
    itemCount: f.item_count ?? undefined,
    createdAt: f.created_at,
    updatedAt: f.updated_at,
    deletedAt: f.deleted_at ?? null,
    ...extra,
  };
}

export function fileJson(f, extra) {
  return {
    kind: 'file',
    id: f.id,
    name: f.name,
    folderId: f.folder_id ?? null,
    size: f.size,
    mimeType: f.mime_type,
    sha256: f.sha256 ?? null,
    source: f.source,
    createdAt: f.created_at,
    updatedAt: f.updated_at,
    deletedAt: f.deleted_at ?? null,
    ...extra,
  };
}

// ---------------------------------------------------------------- folder helpers

export function normFolderId(value) {
  if (value === undefined || value === null) return null;
  const v = String(value).trim();
  return v === '' || v === 'root' || v === 'null' ? null : v;
}

const FOLDER_SELECT = `
  SELECT f.*,
    (SELECT count(*) FROM folders c WHERE c.parent_id = f.id AND c.deleted_at IS NULL) +
    (SELECT count(*) FROM files x WHERE x.folder_id = f.id AND x.deleted_at IS NULL) AS item_count
  FROM folders f`;

/** The folder and all its ancestors, root-most first. */
function folderChain(userId, folderId) {
  return q(`
    WITH RECURSIVE chain(id, parent_id, name, deleted_at, depth) AS (
      SELECT id, parent_id, name, deleted_at, 0 FROM folders WHERE id = ? AND user_id = ?
      UNION ALL
      SELECT f.id, f.parent_id, f.name, f.deleted_at, c.depth + 1
      FROM folders f JOIN chain c ON f.id = c.parent_id
      WHERE c.depth < 512
    )
    SELECT id, parent_id, name, deleted_at FROM chain ORDER BY depth DESC`).all(folderId, userId);
}

/**
 * Returns { folder, breadcrumbs } for a folder that is not in the trash, or null for the root.
 * Throws 404 when the folder doesn't exist, belongs to someone else or is trashed.
 */
export function getLiveFolder(userId, folderId) {
  folderId = normFolderId(folderId);
  if (!folderId) return null;
  const chain = folderChain(userId, folderId);
  if (!chain.length || chain.some((c) => c.deleted_at)) throw notFound('Folder not found');
  return {
    folder: q(`${FOLDER_SELECT} WHERE f.id = ?`).get(folderId),
    breadcrumbs: chain.map((c) => ({ id: c.id, name: c.name })),
  };
}

/** Loads all of a user's folders into a map, for path and "is it in the trash" lookups. */
function folderMap(userId) {
  const rows = q('SELECT id, parent_id, name, deleted_at FROM folders WHERE user_id = ?').all(userId);
  const map = new Map(rows.map((r) => [r.id, r]));
  const liveMemo = new Map();
  const isLive = (id) => {
    if (!id) return true;
    if (liveMemo.has(id)) return liveMemo.get(id);
    const row = map.get(id);
    const live = !!row && !row.deleted_at && isLive(row.parent_id);
    liveMemo.set(id, live);
    return live;
  };
  const pathOf = (id) => {
    const parts = [];
    let guard = 0;
    for (let cur = map.get(id); cur && guard++ < 512; cur = map.get(cur.parent_id)) parts.unshift(cur.name);
    return '/' + parts.join('/');
  };
  return { map, isLive, pathOf };
}

function findChild(userId, parentId, name) {
  const p = parentId ?? '';
  const folder = q(
    `${FOLDER_SELECT} WHERE f.user_id = ? AND ifnull(f.parent_id, '') = ? AND f.name = ? COLLATE NOCASE AND f.deleted_at IS NULL`,
  ).get(userId, p, name);
  if (folder) return { type: 'folder', row: folder };
  const file = q(
    `SELECT * FROM files WHERE user_id = ? AND ifnull(folder_id, '') = ? AND name = ? COLLATE NOCASE AND deleted_at IS NULL`,
  ).get(userId, p, name);
  if (file) return { type: 'file', row: file };
  return null;
}

function nameTaken(userId, parentId, name, exceptId) {
  const hit = findChild(userId, parentId, name);
  return hit && hit.row.id !== exceptId ? hit : null;
}

/** "report.pdf" -> "report (1).pdf" until the name is free. */
function uniqueName(userId, parentId, name, isFolder = false) {
  if (!nameTaken(userId, parentId, name)) return name;
  const dot = isFolder ? -1 : name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; i < 10000; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!nameTaken(userId, parentId, candidate)) return candidate;
  }
  throw conflict(`Couldn't find a free name for "${name}"`);
}

const takenMessage = (hit, name) =>
  `A ${hit.type} named "${hit.row.name ?? name}" already exists here`;

// ---------------------------------------------------------------- folders

export function listFolder(userId, folderId) {
  folderId = normFolderId(folderId);
  const info = getLiveFolder(userId, folderId);
  const p = folderId ?? '';
  const folders = q(
    `${FOLDER_SELECT} WHERE f.user_id = ? AND ifnull(f.parent_id, '') = ? AND f.deleted_at IS NULL ORDER BY f.name COLLATE NOCASE`,
  ).all(userId, p);
  const files = q(
    `SELECT * FROM files WHERE user_id = ? AND ifnull(folder_id, '') = ? AND deleted_at IS NULL ORDER BY name COLLATE NOCASE`,
  ).all(userId, p);
  return {
    folder: info ? folderJson(info.folder) : null,
    breadcrumbs: info?.breadcrumbs ?? [],
    folders: folders.map((f) => folderJson(f)),
    files: files.map((f) => fileJson(f)),
  };
}

export function getFolderInfo(userId, folderId) {
  const info = getLiveFolder(userId, folderId);
  if (!info) return { folder: null, breadcrumbs: [] };
  return { folder: folderJson(info.folder), breadcrumbs: info.breadcrumbs };
}

/** ifExists: 'fail' (409) | 'reuse' (return the existing folder) | 'rename' (pick "name (1)") */
export function createFolder(userId, parentId, name, ifExists = 'fail') {
  parentId = normFolderId(parentId);
  name = cleanName(name, 'Folder name');
  return tx(() => {
    getLiveFolder(userId, parentId);
    const hit = nameTaken(userId, parentId, name);
    if (hit) {
      if (ifExists === 'reuse' && hit.type === 'folder') return hit.row;
      if (ifExists === 'rename') name = uniqueName(userId, parentId, name, true);
      else throw conflict(takenMessage(hit, name), 'name_taken');
    }
    const id = newId();
    const t = now();
    q('INSERT INTO folders (id, user_id, parent_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      id, userId, parentId, name, t, t,
    );
    touchFolder(parentId);
    return q(`${FOLDER_SELECT} WHERE f.id = ?`).get(id);
  });
}

/** mkdir -p: walks/creates `segments` below `baseId` and returns the last folder id. */
export function ensureFolderPath(userId, baseId, segments) {
  let current = normFolderId(baseId);
  if (!segments.length) {
    getLiveFolder(userId, current);
    return current;
  }
  return tx(() => {
    getLiveFolder(userId, current);
    for (const seg of segments) {
      const name = cleanName(seg, 'Folder name');
      const hit = findChild(userId, current, name);
      if (hit?.type === 'file') throw conflict(`"${name}" is a file, not a folder`, 'not_a_folder');
      current = hit ? hit.row.id : createFolder(userId, current, name).id;
    }
    return current;
  });
}

function touchFolder(folderId) {
  if (folderId) q('UPDATE folders SET updated_at = ? WHERE id = ?').run(now(), folderId);
}

export function updateFolder(userId, id, { name, parentId } = {}) {
  return tx(() => {
    const info = getLiveFolder(userId, id);
    if (!info) throw badRequest("The root folder can't be changed");
    const f = info.folder;
    const newName = name !== undefined ? cleanName(name, 'Folder name') : f.name;
    const newParent = parentId !== undefined ? normFolderId(parentId) : f.parent_id ?? null;

    if (newParent !== (f.parent_id ?? null)) {
      const target = getLiveFolder(userId, newParent);
      if (newParent === id || target?.breadcrumbs.some((b) => b.id === id)) {
        throw badRequest("A folder can't be moved into itself", 'invalid_move');
      }
    }
    if (newName === f.name && newParent === (f.parent_id ?? null)) return f;
    const hit = nameTaken(userId, newParent, newName, id);
    if (hit) throw conflict(takenMessage(hit, newName), 'name_taken');
    q('UPDATE folders SET name = ?, parent_id = ?, updated_at = ? WHERE id = ?').run(newName, newParent, now(), id);
    touchFolder(newParent);
    return q(`${FOLDER_SELECT} WHERE f.id = ?`).get(id);
  });
}

// ---------------------------------------------------------------- files

export function getFile(userId, id, { allowTrashed = false } = {}) {
  const f = q('SELECT * FROM files WHERE id = ? AND user_id = ?').get(String(id), userId);
  if (!f) throw notFound('File not found');
  if (!allowTrashed) {
    if (f.deleted_at) throw notFound('File not found');
    if (f.folder_id) {
      const chain = folderChain(userId, f.folder_id);
      if (chain.some((c) => c.deleted_at)) throw notFound('File not found');
    }
  }
  return f;
}

export function getFileChunks(fileId) {
  return q('SELECT idx, size, tg_file_id, chat_id, message_id FROM chunks WHERE file_id = ? ORDER BY idx').all(fileId);
}

export function updateFile(userId, id, { name, folderId } = {}) {
  return tx(() => {
    const f = getFile(userId, id);
    const newName = name !== undefined ? cleanName(name, 'File name') : f.name;
    const newFolder = folderId !== undefined ? normFolderId(folderId) : f.folder_id ?? null;
    if (newFolder !== (f.folder_id ?? null)) getLiveFolder(userId, newFolder);
    if (newName === f.name && newFolder === (f.folder_id ?? null)) return f;
    const hit = nameTaken(userId, newFolder, newName, id);
    if (hit) throw conflict(takenMessage(hit, newName), 'name_taken');
    let mimeType = f.mime_type;
    if (newName !== f.name && (mimeType === 'application/octet-stream' || mimeType === mime.lookup(f.name))) {
      mimeType = mime.lookup(newName) || mimeType;
    }
    q('UPDATE files SET name = ?, folder_id = ?, mime_type = ?, updated_at = ? WHERE id = ?').run(
      newName, newFolder, mimeType, now(), id,
    );
    touchFolder(newFolder);
    return q('SELECT * FROM files WHERE id = ?').get(id);
  });
}

// ---------------------------------------------------------------- uploads

function storageChatFor(userId) {
  return config.storageChatId ?? userId;
}

function enqueueCleanup(chunks) {
  const t = now();
  const stmt = q('INSERT INTO tg_cleanup (chat_id, message_id, created_at) VALUES (?, ?, ?)');
  for (const c of chunks) stmt.run(c.chatId ?? c.chat_id, c.messageId ?? c.message_id, t);
}

function friendlyTelegramError(err) {
  if (!(err instanceof tg.TelegramError)) return err;
  const d = String(err.description || '').toLowerCase();
  let message = `Telegram rejected the upload: ${err.description}`;
  if (d.includes('chat not found')) {
    message = config.storageChatId
      ? 'Telegram couldn\'t find the storage chat. Check TELEGRAM_STORAGE_CHAT_ID and make sure the bot is an admin there.'
      : 'Telegram couldn\'t find your chat with the bot. Open the bot in Telegram, press Start, and try again.';
  } else if (d.includes('blocked by the user')) {
    message = 'You blocked the bot in Telegram. Unblock it to store files.';
  } else if (d.includes('not enough rights') || d.includes('need administrator')) {
    message = 'The bot isn\'t allowed to post in the storage channel. Make it an admin with permission to post messages.';
  } else if (err.code === 401) {
    message = 'Telegram rejected the bot token. Check TELEGRAM_BOT_TOKEN.';
  } else if (err.code === 0) {
    message = `Couldn't reach Telegram: ${err.description}`;
  }
  return new HttpError(502, 'telegram_error', message);
}

/**
 * Reads `source` (an async iterable of bytes), splits it into chunks and uploads each to Telegram.
 * The next chunk is read from the client while the previous one is being sent.
 */
async function pushChunks(userId, name, source, { signal } = {}) {
  const chatId = storageChatFor(userId);
  const chunkSize = config.chunkSize;
  const maxBytes = config.maxUploadBytes;
  const hash = createHash('sha256');
  const chunks = [];
  let parts = [];
  let partLen = 0;
  let size = 0;
  let nextIdx = 0;
  let inflight = null;

  const dispatch = async (isLast) => {
    const buffer = parts.length === 1 ? parts[0] : Buffer.concat(parts, partLen);
    parts = [];
    partLen = 0;
    const idx = nextIdx++;
    if (inflight) await inflight;
    const single = isLast && idx === 0;
    const filename = single ? name : `${name}.part${String(idx + 1).padStart(3, '0')}`;
    const caption = single ? name : `${name} (part ${idx + 1})`;
    inflight = tg.sendDocument(chatId, buffer, filename, { caption, signal }).then((sent) => {
      chunks.push({ idx, size: buffer.length, ...sent });
    });
    inflight.catch(() => {}); // surfaced by the next await
  };

  try {
    for await (const piece of source) {
      const data = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
      hash.update(data);
      size += data.length;
      if (maxBytes && size > maxBytes) {
        throw new HttpError(413, 'too_large', `Files can be at most ${formatBytes(maxBytes)} on this server`);
      }
      let off = 0;
      while (off < data.length) {
        const take = Math.min(chunkSize - partLen, data.length - off);
        parts.push(data.subarray(off, off + take));
        partLen += take;
        off += take;
        if (partLen === chunkSize) await dispatch(false);
      }
    }
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    if (partLen > 0) await dispatch(true);
    if (inflight) await inflight;
  } catch (err) {
    if (inflight) await inflight.catch(() => {});
    enqueueCleanup(chunks);
    throw friendlyTelegramError(err);
  }
  chunks.sort((a, b) => a.idx - b.idx);
  return { chunks, size, sha256: hash.digest('hex'), chunkSize };
}

function insertChunks(fileId, chunks) {
  const stmt = q(
    'INSERT INTO chunks (file_id, idx, size, tg_file_id, tg_file_unique_id, chat_id, message_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const c of chunks) stmt.run(fileId, c.idx, c.size, c.fileId, c.fileUniqueId ?? null, c.chatId, c.messageId);
}

function replaceContent(fileId, upload, mimeType) {
  enqueueCleanup(getFileChunks(fileId));
  q('DELETE FROM chunks WHERE file_id = ?').run(fileId);
  insertChunks(fileId, upload.chunks);
  q('UPDATE files SET size = ?, sha256 = ?, chunk_size = ?, mime_type = ?, updated_at = ? WHERE id = ?').run(
    upload.size, upload.sha256, upload.chunkSize, mimeType, now(), fileId,
  );
}

// Types that HTTP clients send by default (fetch with a string body, curl -d), which say nothing about the file.
const GENERIC_TYPES = new Set(['', 'application/octet-stream', 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']);

function pickMime(name, provided) {
  const p = String(provided || '').split(';')[0].trim().toLowerCase();
  const fromName = mime.lookup(name);
  if (GENERIC_TYPES.has(p) || !/^[\w.+-]+\/[\w.+-]+$/.test(p)) {
    return fromName || (p === 'text/plain' ? p : 'application/octet-stream');
  }
  return p;
}

/**
 * Stores a new file from a byte stream.
 * onConflict: 'rename' (default) | 'overwrite' (replace the existing file's content, keeping its id) | 'fail'
 * Returns { file, created }.
 */
export async function saveFile(userId, { folderId, name, mimeType, stream, onConflict = 'rename', source = 'web', signal }) {
  folderId = normFolderId(folderId);
  name = cleanName(name, 'File name');
  if (!['rename', 'overwrite', 'fail'].includes(onConflict)) onConflict = 'rename';
  getLiveFolder(userId, folderId);

  const early = nameTaken(userId, folderId, name);
  if (early && (onConflict === 'fail' || (onConflict === 'overwrite' && early.type === 'folder'))) {
    throw conflict(takenMessage(early, name), 'name_taken');
  }

  const type = pickMime(name, mimeType);
  const upload = await pushChunks(userId, name, stream, { signal });

  try {
    return tx(() => {
      getLiveFolder(userId, folderId);
      let finalName = name;
      const hit = nameTaken(userId, folderId, name);
      if (hit) {
        if (onConflict === 'overwrite' && hit.type === 'file') {
          replaceContent(hit.row.id, upload, type);
          touchFolder(folderId);
          return { file: q('SELECT * FROM files WHERE id = ?').get(hit.row.id), created: false };
        }
        if (onConflict === 'rename') finalName = uniqueName(userId, folderId, name);
        else throw conflict(takenMessage(hit, name), 'name_taken');
      }
      const id = newId();
      const t = now();
      q(`INSERT INTO files (id, user_id, folder_id, name, size, mime_type, sha256, chunk_size, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, userId, folderId, finalName, upload.size, type, upload.sha256, upload.chunkSize, source, t, t,
      );
      insertChunks(id, upload.chunks);
      touchFolder(folderId);
      return { file: q('SELECT * FROM files WHERE id = ?').get(id), created: true };
    });
  } catch (err) {
    enqueueCleanup(upload.chunks);
    throw err;
  }
}

/** Replaces the content of an existing file, keeping its id, name and location. */
export async function replaceFile(userId, id, { stream, mimeType, signal }) {
  const f = getFile(userId, id);
  const upload = await pushChunks(userId, f.name, stream, { signal });
  try {
    return tx(() => {
      getFile(userId, id);
      replaceContent(id, upload, mimeType ? pickMime(f.name, mimeType) : f.mime_type);
      return q('SELECT * FROM files WHERE id = ?').get(id);
    });
  } catch (err) {
    enqueueCleanup(upload.chunks);
    throw err;
  }
}

/** Registers a file that already exists in Telegram (sent to the bot in chat) without re-uploading it. */
export function saveTelegramFile(userId, { folderId, name, mimeType, size, fileId, fileUniqueId, chatId, messageId }) {
  name = cleanName(name, 'File name');
  return tx(() => {
    getLiveFolder(userId, folderId);
    const finalName = uniqueName(userId, folderId, name);
    const id = newId();
    const t = now();
    q(`INSERT INTO files (id, user_id, folder_id, name, size, mime_type, sha256, chunk_size, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'bot', ?, ?)`).run(
      id, userId, folderId, finalName, size, pickMime(finalName, mimeType), size, t, t,
    );
    if (size > 0) insertChunks(id, [{ idx: 0, size, fileId, fileUniqueId, chatId, messageId }]);
    touchFolder(folderId);
    return q('SELECT * FROM files WHERE id = ?').get(id);
  });
}

/** Streams bytes [start, end] of a stored file. */
export async function* readContent(fileId, start, end, signal) {
  let offset = 0;
  for (const c of getFileChunks(fileId)) {
    const cStart = offset;
    const cEnd = offset + c.size - 1;
    offset += c.size;
    if (cEnd < start) continue;
    if (cStart > end) break;
    yield* tg.readFile(c.tg_file_id, Math.max(start, cStart) - cStart, Math.min(end, cEnd) - cStart, signal);
  }
}

// ---------------------------------------------------------------- paths

/** Resolves "/a/b/c.txt" to { type: 'root' | 'folder' | 'file', row } or null. */
export function resolvePath(userId, segments) {
  if (!segments.length) return { type: 'root', row: null };
  let parent = null;
  for (let i = 0; i < segments.length; i++) {
    const hit = findChild(userId, parent, segments[i]);
    if (!hit) return null;
    if (i === segments.length - 1) return hit;
    if (hit.type !== 'folder') return null;
    parent = hit.row.id;
  }
  return null;
}

// ---------------------------------------------------------------- trash

function asIdList(v) {
  return Array.isArray(v) ? v.map(String) : [];
}

export function trashItems(userId, { files, folders }) {
  const t = now();
  return tx(() => {
    let count = 0;
    for (const id of asIdList(files)) {
      const f = getFile(userId, id);
      q('UPDATE files SET deleted_at = ? WHERE id = ?').run(t, f.id);
      touchFolder(f.folder_id);
      count++;
    }
    for (const id of asIdList(folders)) {
      const info = getLiveFolder(userId, id);
      if (!info) continue;
      q('UPDATE folders SET deleted_at = ? WHERE id = ?').run(t, id);
      touchFolder(info.folder.parent_id);
      count++;
    }
    return count;
  });
}

export function listTrash(userId) {
  const { isLive, pathOf } = folderMap(userId);
  const folders = q(`${FOLDER_SELECT} WHERE f.user_id = ? AND f.deleted_at IS NOT NULL ORDER BY f.deleted_at DESC`)
    .all(userId)
    .filter((f) => isLive(f.parent_id))
    .map((f) => folderJson(f, { location: f.parent_id ? pathOf(f.parent_id) : '/' }));
  const files = q('SELECT * FROM files WHERE user_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC')
    .all(userId)
    .filter((f) => isLive(f.folder_id))
    .map((f) => fileJson(f, { location: f.folder_id ? pathOf(f.folder_id) : '/' }));
  return { folders, files };
}

export function restoreItems(userId, { files, folders }) {
  return tx(() => {
    const { isLive } = folderMap(userId);
    let count = 0;
    for (const id of asIdList(folders)) {
      const f = q('SELECT * FROM folders WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL').get(id, userId);
      if (!f) continue;
      const parent = isLive(f.parent_id) ? f.parent_id : null;
      const name = uniqueName(userId, parent, f.name, true);
      q('UPDATE folders SET deleted_at = NULL, parent_id = ?, name = ? WHERE id = ?').run(parent, name, id);
      count++;
    }
    for (const id of asIdList(files)) {
      const f = q('SELECT * FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL').get(id, userId);
      if (!f) continue;
      const parent = isLive(f.folder_id) ? f.folder_id : null;
      const name = uniqueName(userId, parent, f.name);
      q('UPDATE files SET deleted_at = NULL, folder_id = ?, name = ? WHERE id = ?').run(parent, name, id);
      count++;
    }
    return count;
  });
}

/** Permanently deletes files and folders (with everything inside) and queues their Telegram messages for removal. */
export function purgeItems(userId, { files, folders }) {
  return tx(() => {
    const fileIds = new Set();
    const folderIds = [];
    for (const id of asIdList(files)) {
      if (q('SELECT 1 FROM files WHERE id = ? AND user_id = ?').get(id, userId)) fileIds.add(id);
    }
    const stack = asIdList(folders).filter((id) => q('SELECT 1 FROM folders WHERE id = ? AND user_id = ?').get(id, userId));
    while (stack.length) {
      const id = stack.pop();
      folderIds.push(id);
      for (const f of q('SELECT id FROM files WHERE folder_id = ?').all(id)) fileIds.add(f.id);
      for (const c of q('SELECT id FROM folders WHERE parent_id = ?').all(id)) stack.push(c.id);
    }
    for (const id of fileIds) {
      enqueueCleanup(getFileChunks(id));
      q('DELETE FROM files WHERE id = ?').run(id);
    }
    for (const id of folderIds.reverse()) q('DELETE FROM folders WHERE id = ?').run(id);
    return fileIds.size + folderIds.length;
  });
}

export function emptyTrash(userId) {
  const { folders, files } = listTrash(userId);
  return purgeItems(userId, { folders: folders.map((f) => f.id), files: files.map((f) => f.id) });
}

// ---------------------------------------------------------------- search, recent, usage

export function search(userId, query, limit = 200) {
  const term = String(query ?? '').trim();
  if (!term) return { folders: [], files: [] };
  const like = `%${term.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
  const { isLive, pathOf } = folderMap(userId);
  const folders = q(
    `${FOLDER_SELECT} WHERE f.user_id = ? AND f.deleted_at IS NULL AND f.name LIKE ? ESCAPE '\\' ORDER BY f.name COLLATE NOCASE LIMIT ?`,
  )
    .all(userId, like, limit)
    .filter((f) => isLive(f.parent_id))
    .map((f) => folderJson(f, { location: f.parent_id ? pathOf(f.parent_id) : '/' }));
  const files = q(
    `SELECT * FROM files WHERE user_id = ? AND deleted_at IS NULL AND name LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT ?`,
  )
    .all(userId, like, limit)
    .filter((f) => isLive(f.folder_id))
    .map((f) => fileJson(f, { location: f.folder_id ? pathOf(f.folder_id) : '/' }));
  return { folders, files };
}

export function recent(userId, limit = 60) {
  const { isLive, pathOf } = folderMap(userId);
  const files = q('SELECT * FROM files WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?')
    .all(userId, limit * 2)
    .filter((f) => isLive(f.folder_id))
    .slice(0, limit)
    .map((f) => fileJson(f, { location: f.folder_id ? pathOf(f.folder_id) : '/' }));
  return { folders: [], files };
}

export function usage(userId) {
  const live = q('SELECT count(*) AS n, coalesce(sum(size), 0) AS bytes FROM files WHERE user_id = ? AND deleted_at IS NULL').get(userId);
  const trashed = q('SELECT count(*) AS n, coalesce(sum(size), 0) AS bytes FROM files WHERE user_id = ? AND deleted_at IS NOT NULL').get(userId);
  const folders = q('SELECT count(*) AS n FROM folders WHERE user_id = ? AND deleted_at IS NULL').get(userId);
  return { files: live.n, bytes: live.bytes, folders: folders.n, trashFiles: trashed.n, trashBytes: trashed.bytes };
}

// ---------------------------------------------------------------- background cleanup

let cleaning = false;

async function cleanupTick() {
  if (cleaning || !config.botToken) return;
  cleaning = true;
  try {
    const rows = q('SELECT rowid, chat_id, message_id, attempts FROM tg_cleanup ORDER BY rowid LIMIT 25').all();
    for (const r of rows) {
      try {
        await tg.deleteMessage(r.chat_id, r.message_id);
        q('DELETE FROM tg_cleanup WHERE rowid = ?').run(r.rowid);
      } catch (err) {
        // 400/403: already gone or too old to delete. Either way there's nothing more to do.
        if (err.code === 400 || err.code === 403 || r.attempts >= 5) q('DELETE FROM tg_cleanup WHERE rowid = ?').run(r.rowid);
        else q('UPDATE tg_cleanup SET attempts = attempts + 1 WHERE rowid = ?').run(r.rowid);
      }
      await sleep(400);
    }
    const t = now();
    q('DELETE FROM sessions WHERE expires_at < ?').run(t);
    q('DELETE FROM login_requests WHERE expires_at < ?').run(t - 60 * 60 * 1000);
  } catch (err) {
    console.error('Cleanup failed:', err.message);
  } finally {
    cleaning = false;
  }
}

export function startCleanupWorker() {
  setInterval(cleanupTick, 20_000).unref();
  setTimeout(cleanupTick, 5_000).unref();
}
