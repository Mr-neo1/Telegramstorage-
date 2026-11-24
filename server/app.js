import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import './db.js';
import { apiRouter } from './api.js';
import { authRouter, keysRouter } from './auth.js';
import { startBot } from './bot.js';
import { startCleanupWorker } from './storage.js';
import { HttpError } from './util.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);
app.set('etag', false);

// Other apps may call the API from a browser with an API key. Cookies are never
// accepted cross-origin (SameSite=Lax + a required custom header), so a wildcard is safe here.
app.use('/api/v1', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, X-API-Key, Content-Type, Range, If-None-Match');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Range, Content-Length, ETag, Accept-Ranges');
  res.setHeader('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use('/api/auth', authRouter);
app.use('/api/keys', keysRouter);
app.use('/api/v1', apiRouter);
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api', (req, res) => {
  res.status(404).json({ error: { code: 'not_found', message: `No API route for ${req.method} ${req.originalUrl}` } });
});

// The web app.
const indexHtml = path.join(config.webDist, 'index.html');
if (fs.existsSync(indexHtml)) {
  app.use(express.static(config.webDist, { index: false, maxAge: '1h', setHeaders: noCacheHtml }));
  app.get('/{*path}', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexHtml);
  });
} else {
  app.get('/', (req, res) => {
    res
      .type('text/plain')
      .send('The web app has not been built yet. Run "npm run build" and restart, or use "npm run dev" while developing.');
  });
}

function noCacheHtml(res, filePath) {
  if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  else if (filePath.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
}

// Errors as JSON: { error: { code, message } }
app.use((err, req, res, next) => {
  if (res.headersSent) return res.destroy();
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, ...err.extra } });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'invalid_json', message: 'The request body is not valid JSON' } });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'too_large', message: 'The request body is too large' } });
  }
  console.error(err);
  res.status(500).json({ error: { code: 'internal', message: 'Something went wrong on the server. Check the server log for details.' } });
});

const server = app.listen(config.port, config.host, () => {
  const shown = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
  console.log(`\nTelegram Storage is running at http://${shown}:${config.port}`);
  if (config.publicUrl) console.log(`Public URL: ${config.publicUrl}`);
});
server.requestTimeout = 0; // large uploads can take a long time
server.headersTimeout = 60_000;

startBot();
startCleanupWorker();
