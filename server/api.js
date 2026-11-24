// REST API used by the web app and by other apps (with an API key).
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import busboy from 'busboy';
import express from 'express';
import { config } from './config.js';
import { requireAuth, userJson } from './auth.js';
import * as storage from './storage.js';
import { HttpError, badRequest, notFound, splitPath } from './util.js';

export const apiRouter = express.Router();

const read = requireAuth('read');
const write = requireAuth('write');
const json = express.json({ limit: '1mb' });

const uid = (req) => req.user.id;
const sourceOf = (req) => (req.auth?.type === 'key' ? 'api' : 'web');
const body = (req) => (req.body && typeof req.body === 'object' ? req.body : {});

/** Aborts when the client disconnects before the response is finished. */
function clientSignal(res) {
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) ac.abort(new HttpError(499, 'client_closed', 'The client disconnected'));
  });
  return ac.signal;
}

const listing = (r) => ({
  folder: r.folder,
  breadcrumbs: r.breadcrumbs,
  folders: r.folders,
  files: r.files,
});

// ---------------------------------------------------------------- account

apiRouter.get('/me', read, (req, res) => {
  res.json({
    user: userJson(req.user),
    usage: storage.usage(uid(req)),
    limits: { chunkSize: config.chunkSize, maxUploadBytes: config.maxUploadBytes || null },
    auth: { type: req.auth.type, scopes: req.auth.scopes },
  });
});

// ---------------------------------------------------------------- folders

apiRouter.get('/folders/:id', read, (req, res) => {
  res.json(storage.getFolderInfo(uid(req), req.params.id));
});

apiRouter.get('/folders/:id/children', read, (req, res) => {
  res.json(listing(storage.listFolder(uid(req), req.params.id)));
});

apiRouter.post('/folders', write, json, (req, res) => {
  const { name, parentId, path, ifExists } = body(req);
  if (path !== undefined) {
    const id = storage.ensureFolderPath(uid(req), parentId, splitPath(path));
    return res.status(201).json(storage.getFolderInfo(uid(req), id));
  }
  const folder = storage.createFolder(uid(req), parentId, name, ifExists);
  res.status(201).json({ folder: storage.folderJson(folder) });
});

apiRouter.patch('/folders/:id', write, json, (req, res) => {
  const { name, parentId } = body(req);
  res.json({ folder: storage.folderJson(storage.updateFolder(uid(req), req.params.id, { name, parentId })) });
});

apiRouter.delete('/folders/:id', write, (req, res) => {
  const items = { folders: [req.params.id] };
  const permanent = req.query.permanent === 'true' || req.query.permanent === '1';
  if (!permanent) storage.getLiveFolder(uid(req), req.params.id);
  const count = permanent ? storage.purgeItems(uid(req), items) : storage.trashItems(uid(req), items);
  if (!count) throw notFound('Folder not found');
  res.json({ ok: true, permanent });
});

// ---------------------------------------------------------------- files

apiRouter.post('/files', write, (req, res) => handleUpload(req, res));

apiRouter.get('/files/:id', read, (req, res) => {
  const f = storage.getFile(uid(req), req.params.id, { allowTrashed: true });
  res.json({ file: storage.fileJson(f, { chunks: storage.getFileChunks(f.id).length }) });
});

apiRouter.get('/files/:id/content', read, async (req, res) => {
  const f = storage.getFile(uid(req), req.params.id, { allowTrashed: true });
  await sendContent(req, res, f);
});

apiRouter.put('/files/:id/content', write, async (req, res) => {
  const f = await storage.replaceFile(uid(req), req.params.id, {
    stream: limitedBody(req),
    mimeType: req.get('content-type'),
    signal: clientSignal(res),
  });
  res.json({ file: storage.fileJson(f) });
});

apiRouter.patch('/files/:id', write, json, (req, res) => {
  const { name, folderId } = body(req);
  res.json({ file: storage.fileJson(storage.updateFile(uid(req), req.params.id, { name, folderId })) });
});

apiRouter.delete('/files/:id', write, (req, res) => {
  const items = { files: [req.params.id] };
  const permanent = req.query.permanent === 'true' || req.query.permanent === '1';
  if (!permanent) storage.getFile(uid(req), req.params.id);
  const count = permanent ? storage.purgeItems(uid(req), items) : storage.trashItems(uid(req), items);
  if (!count) throw notFound('File not found');
  res.json({ ok: true, permanent });
});

// ---------------------------------------------------------------- several items at once

apiRouter.post('/items/move', write, json, (req, res) => {
  const { files = [], folders = [], folderId } = body(req);
  const target = storage.normFolderId(folderId);
  const moved = [];
  const errors = [];
  for (const id of folders) {
    try {
      moved.push(storage.folderJson(storage.updateFolder(uid(req), id, { parentId: target })));
    } catch (err) {
      errors.push({ id, kind: 'folder', code: err.code, message: err.message });
    }
  }
  for (const id of files) {
    try {
      moved.push(storage.fileJson(storage.updateFile(uid(req), id, { folderId: target })));
    } catch (err) {
      errors.push({ id, kind: 'file', code: err.code, message: err.message });
    }
  }
  res.json({ moved, errors });
});

apiRouter.post('/items/trash', write, json, (req, res) => {
  const { files = [], folders = [] } = body(req);
  res.json({ count: storage.trashItems(uid(req), { files, folders }) });
});

// ---------------------------------------------------------------- views

apiRouter.get('/recent', read, (req, res) => res.json(storage.recent(uid(req))));

apiRouter.get('/search', read, (req, res) => res.json(storage.search(uid(req), req.query.q)));

apiRouter.get('/trash', read, (req, res) => res.json(storage.listTrash(uid(req))));

apiRouter.post('/trash/restore', write, json, (req, res) => {
  const { files = [], folders = [] } = body(req);
  res.json({ count: storage.restoreItems(uid(req), { files, folders }) });
});

apiRouter.post('/trash/delete', write, json, (req, res) => {
  const { files = [], folders = [] } = body(req);
  res.json({ count: storage.purgeItems(uid(req), { files, folders }) });
});

apiRouter.delete('/trash', write, (req, res) => {
  res.json({ count: storage.emptyTrash(uid(req)) });
});

// ---------------------------------------------------------------- path-based API: /fs/folder/sub/file.txt

const fsSegments = (req) => splitPath(req.params.path ?? []);

apiRouter.get('/fs{/*path}', read, async (req, res) => {
  const segs = fsSegments(req);
  const hit = storage.resolvePath(uid(req), segs);
  if (!hit) throw notFound(`Nothing found at /${segs.join('/')}`);
  if (hit.type === 'file') {
    if (req.query.meta === '1' || req.query.meta === 'true') return res.json({ type: 'file', file: storage.fileJson(hit.row) });
    return sendContent(req, res, hit.row);
  }
  res.json({ type: 'folder', ...listing(storage.listFolder(uid(req), hit.row?.id ?? null)) });
});

apiRouter.put('/fs/*path', write, async (req, res) => {
  const segs = fsSegments(req);
  const name = segs.pop();
  if (!name) throw badRequest('The path must end with a file name');
  const folderId = storage.ensureFolderPath(uid(req), null, segs);
  const { file, created } = await storage.saveFile(uid(req), {
    folderId,
    name,
    mimeType: req.get('content-type'),
    stream: limitedBody(req),
    onConflict: req.query.overwrite === 'false' ? 'fail' : 'overwrite',
    source: sourceOf(req),
    signal: clientSignal(res),
  });
  res.status(created ? 201 : 200).json({ file: storage.fileJson(file) });
});

apiRouter.patch('/fs/*path', write, json, (req, res) => {
  const segs = fsSegments(req);
  const hit = storage.resolvePath(uid(req), segs);
  if (!hit || hit.type === 'root') throw notFound(`Nothing found at /${segs.join('/')}`);
  const { name, moveTo } = body(req);
  const target = moveTo !== undefined ? storage.ensureFolderPath(uid(req), null, splitPath(moveTo)) : undefined;
  if (hit.type === 'file') {
    return res.json({ file: storage.fileJson(storage.updateFile(uid(req), hit.row.id, { name, folderId: target })) });
  }
  res.json({ folder: storage.folderJson(storage.updateFolder(uid(req), hit.row.id, { name, parentId: target })) });
});

apiRouter.delete('/fs/*path', write, (req, res) => {
  const segs = fsSegments(req);
  const hit = storage.resolvePath(uid(req), segs);
  if (!hit || hit.type === 'root') throw notFound(`Nothing found at /${segs.join('/')}`);
  const items = hit.type === 'file' ? { files: [hit.row.id] } : { folders: [hit.row.id] };
  const permanent = req.query.permanent === 'true' || req.query.permanent === '1';
  if (permanent) storage.purgeItems(uid(req), items);
  else storage.trashItems(uid(req), items);
  res.json({ ok: true, permanent });
});

// ---------------------------------------------------------------- helpers

/** The raw request body, checked against Content-Length so a cut-off upload is never saved. */
async function* limitedBody(req) {
  const expected = req.get('content-length') ? Number(req.get('content-length')) : null;
  let received = 0;
  for await (const chunk of req) {
    received += chunk.length;
    yield chunk;
  }
  if (expected !== null && received !== expected) {
    throw new HttpError(400, 'incomplete_upload', `Expected ${expected} bytes but received ${received}`);
  }
}

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return null; // ignore unsupported (e.g. multi-range) requests
  let start;
  let end;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return -1;
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return -1;
  return { start, end };
}

function contentDisposition(name, type) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// Types that could run scripts if opened directly in the browser.
const ACTIVE_CONTENT = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|text\/javascript|application\/javascript)/i;

async function sendContent(req, res, file) {
  const size = file.size;
  const etag = file.sha256 ? `"${file.sha256}"` : `"${file.id}-${file.updated_at}"`;
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', new Date(file.updated_at).toUTCString());
  res.setHeader('Cache-Control', 'private, no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.headers['if-none-match'] === etag) return res.status(304).end();

  let start = 0;
  let end = size - 1;
  let status = 200;
  if (req.headers.range && size > 0) {
    const range = parseRange(req.headers.range, size);
    if (range === -1) {
      res.setHeader('Content-Range', `bytes */${size}`);
      return res.status(416).end();
    }
    if (range) {
      ({ start, end } = range);
      status = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    }
  }

  const download = req.query.download === '1' || req.query.download === 'true';
  res.status(status);
  res.setHeader('Content-Type', file.mime_type.startsWith('text/') ? `${file.mime_type}; charset=utf-8` : file.mime_type);
  res.setHeader('Content-Length', size === 0 ? 0 : end - start + 1);
  res.setHeader('Content-Disposition', contentDisposition(file.name, download ? 'attachment' : 'inline'));
  if (ACTIVE_CONTENT.test(file.mime_type)) res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  if (req.method === 'HEAD' || size === 0) return res.end();

  const signal = clientSignal(res);
  try {
    await pipeline(Readable.from(storage.readContent(file.id, start, end, signal), { objectMode: false }), res);
  } catch (err) {
    if (!signal.aborted) console.error(`Download of ${file.id} failed:`, err.message);
    res.destroy();
  }
}

/** multipart/form-data upload. Several files per request are allowed. */
async function handleUpload(req, res) {
  if (!String(req.get('content-type') || '').toLowerCase().startsWith('multipart/form-data')) {
    throw badRequest('Send files as multipart/form-data in a field named "file"');
  }
  const userId = uid(req);
  const signal = clientSignal(res);
  const fields = {
    folderId: req.query.folderId,
    path: req.query.path,
    onConflict: req.query.onConflict,
    relativePath: req.query.relativePath,
  };
  const saved = [];
  const errors = [];

  await new Promise((resolve, reject) => {
    let bb;
    try {
      bb = busboy({
        headers: req.headers,
        preservePath: true,
        defParamCharset: 'utf8',
        limits: { fields: 100, fieldSize: 64 * 1024, files: 1000 },
      });
    } catch (err) {
      return reject(badRequest(`Malformed upload: ${err.message}`));
    }
    let chain = Promise.resolve();
    let active = null;

    bb.on('field', (key, value) => {
      if (key in fields) fields[key] = value;
    });
    bb.on('file', (_field, stream, info) => {
      const opts = { ...fields };
      fields.relativePath = req.query.relativePath; // a relativePath field applies to the next file only
      chain = chain.then(async () => {
        active = stream;
        try {
          const segs = splitPath(info.filename || 'untitled');
          const name = segs.pop() || 'untitled';
          let folderId = storage.normFolderId(opts.folderId);
          if (opts.path) folderId = storage.ensureFolderPath(userId, folderId, splitPath(opts.path));
          const extra = [...splitPath(opts.relativePath), ...segs];
          if (extra.length) folderId = storage.ensureFolderPath(userId, folderId, extra);
          const { file } = await storage.saveFile(userId, {
            folderId,
            name,
            mimeType: info.mimeType,
            stream,
            onConflict: opts.onConflict,
            source: sourceOf(req),
            signal,
          });
          saved.push(storage.fileJson(file));
        } catch (err) {
          stream.resume();
          errors.push({ name: info.filename, status: err.status ?? 500, code: err.code ?? 'upload_failed', message: err.message });
        } finally {
          active = null;
        }
      });
    });
    bb.on('close', () => chain.then(resolve, reject));
    bb.on('error', (err) => {
      active?.destroy(err);
      reject(badRequest(`Malformed upload: ${err.message}`));
    });
    signal.addEventListener('abort', () => {
      active?.destroy(new Error('The client disconnected'));
      reject(signal.reason);
    });
    req.pipe(bb);
  });

  if (!saved.length) {
    const first = errors[0];
    if (!first) throw badRequest('No file was received. Send it in a multipart field named "file".');
    throw new HttpError(first.status, first.code, first.message, errors.length > 1 ? { errors } : undefined);
  }
  res.status(201).json({ file: saved[0], files: saved, errors });
}
