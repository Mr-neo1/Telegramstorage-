// Sign-in with Telegram (via the bot), browser sessions, and API keys.
import express from 'express';
import QRCode from 'qrcode';
import { config, isAllowedUser } from './config.js';
import { q, tx } from './db.js';
import { botState } from './bot.js';
import * as tg from './telegram.js';
import { HttpError, badRequest, describeUserAgent, newId, notFound, parseCookies, randomToken, sha256 } from './util.js';

const SESSION_COOKIE = 'tgs_session';
const LOGIN_COOKIE = 'tgs_login';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const SCOPES = ['read', 'write'];

const cookieOptions = (maxAge, path = '/') => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: config.secureCookies,
  maxAge,
  path,
});

export function userJson(u) {
  return {
    id: u.id,
    firstName: u.first_name,
    lastName: u.last_name ?? null,
    username: u.username ?? null,
    hasPhoto: !!u.photo_file_id,
    createdAt: u.created_at,
  };
}

// ---------------------------------------------------------------- request authentication

function authenticate(req) {
  if (req.auth !== undefined) return req.auth;
  req.auth = null;

  const header = req.get('authorization') || '';
  const bearer = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim();
  const apiKey = bearer || req.get('x-api-key')?.trim();
  if (apiKey) {
    const key = q('SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL').get(sha256(apiKey));
    if (!key) throw new HttpError(401, 'invalid_api_key', 'This API key is invalid or has been revoked');
    const user = q('SELECT * FROM users WHERE id = ?').get(key.user_id);
    if (!user) throw new HttpError(401, 'invalid_api_key', 'This API key is invalid or has been revoked');
    const t = Date.now();
    if (!key.last_used_at || t - key.last_used_at > 60_000) {
      q('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(t, key.id);
    }
    req.user = user;
    req.auth = { type: 'key', keyId: key.id, scopes: key.scopes.split(',') };
    return req.auth;
  }

  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) {
    const session = q('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?').get(sha256(token), Date.now());
    const user = session && q('SELECT * FROM users WHERE id = ?').get(session.user_id);
    if (user) {
      req.user = user;
      req.auth = { type: 'session', scopes: SCOPES };
    }
  }
  return req.auth;
}

/** Middleware: requires a signed-in session or an API key with `scope`. */
export function requireAuth(scope = 'read') {
  return (req, res, next) => {
    const auth = authenticate(req);
    if (!auth) {
      throw new HttpError(401, 'unauthorized', 'Sign in, or send an API key in the Authorization header');
    }
    if (!isAllowedUser(req.user.id)) {
      throw new HttpError(403, 'forbidden', 'Your Telegram account no longer has access to this storage');
    }
    if (auth.type === 'session' && !SAFE_METHODS.has(req.method) && req.get('x-requested-with') !== 'telegram-storage') {
      throw new HttpError(403, 'csrf', 'Missing X-Requested-With: telegram-storage header');
    }
    if (!auth.scopes.includes(scope)) {
      throw new HttpError(403, 'insufficient_scope', `This API key doesn't have ${scope} access`);
    }
    next();
  };
}

/** Middleware: only browser sessions (API keys can't manage API keys). */
export function requireSession(req, res, next) {
  requireAuth('write')(req, res, () => {
    if (req.auth.type !== 'session') throw new HttpError(403, 'session_required', 'Manage API keys from the web app');
    next();
  });
}

// ---------------------------------------------------------------- login rate limit

const loginHits = new Map();
function loginRateLimit(req, res, next) {
  const key = req.ip || 'unknown';
  const t = Date.now();
  const hits = (loginHits.get(key) || []).filter((x) => t - x < 5 * 60_000);
  if (hits.length >= 20) throw new HttpError(429, 'rate_limited', 'Too many sign-in attempts. Wait a few minutes and try again.');
  hits.push(t);
  loginHits.set(key, hits);
  if (loginHits.size > 10_000) loginHits.clear();
  next();
}

// ---------------------------------------------------------------- routes

export const authRouter = express.Router();
const json = express.json({ limit: '64kb' });

authRouter.get('/config', (req, res) => {
  res.json({
    bot: botState(),
    restricted: config.allowedUserIds.size > 0,
    storage: config.storageChatId ? 'channel' : 'bot-chat',
  });
});

authRouter.post('/login', loginRateLimit, async (req, res) => {
  const bot = botState();
  if (bot.status !== 'ready') {
    throw new HttpError(503, 'bot_unavailable', bot.error || 'The Telegram bot is still starting. Try again in a moment.');
  }
  const code = randomToken(16);
  const secret = randomToken(32);
  const t = Date.now();
  const expiresAt = t + config.loginTtlMs;
  q(`INSERT INTO login_requests (code, secret_hash, status, created_at, expires_at, user_agent, ip)
     VALUES (?, ?, 'pending', ?, ?, ?, ?)`).run(code, sha256(secret), t, expiresAt, req.get('user-agent') || '', req.ip || '');

  res.cookie(LOGIN_COOKIE, `${code}.${secret}`, cookieOptions(config.loginTtlMs, '/api/auth'));
  const link = `https://t.me/${bot.username}?start=login_${code}`;
  const qr = await QRCode.toString(link, {
    type: 'svg',
    margin: 0,
    errorCorrectionLevel: 'M',
    color: { dark: '#000000', light: '#00000000' },
  });
  res.json({ link, appLink: `tg://resolve?domain=${bot.username}&start=login_${code}`, qr, expiresAt, botUsername: bot.username });
});

authRouter.get('/login/status', (req, res) => {
  const raw = parseCookies(req.headers.cookie)[LOGIN_COOKIE] || '';
  const [code, secret] = raw.split('.');
  const r = code && secret ? q('SELECT * FROM login_requests WHERE code = ?').get(code) : null;
  if (!r || r.secret_hash !== sha256(secret)) return res.json({ status: 'expired' });
  if (r.expires_at < Date.now() && r.status !== 'denied') return res.json({ status: 'expired' });

  if (r.status === 'approved') {
    const token = randomToken(32);
    const user = tx(() => {
      q("UPDATE login_requests SET status = 'consumed' WHERE code = ?").run(code);
      q('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?)').run(
        sha256(token), r.user_id, Date.now(), Date.now() + config.sessionTtlMs, req.get('user-agent') || '', req.ip || '',
      );
      return q('SELECT * FROM users WHERE id = ?').get(r.user_id);
    });
    res.clearCookie(LOGIN_COOKIE, { path: '/api/auth' });
    res.cookie(SESSION_COOKIE, token, cookieOptions(config.sessionTtlMs));
    return res.json({ status: 'approved', user: userJson(user) });
  }

  const tgUser = r.user_json ? JSON.parse(r.user_json) : null;
  res.json({ status: r.status === 'consumed' ? 'expired' : r.status, telegramName: tgUser?.first_name ?? null });
});

authRouter.get('/me', requireAuth('read'), (req, res) => {
  res.json({ user: userJson(req.user), via: req.auth.type });
});

authRouter.post('/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) q('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

authRouter.get('/avatar', requireAuth('read'), async (req, res) => {
  if (!req.user.photo_file_id) throw notFound('No profile photo');
  const buf = await tg.downloadSmall(req.user.photo_file_id);
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.end(buf);
});

// ---------------------------------------------------------------- API keys

export const keysRouter = express.Router();

function keyJson(k) {
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    scopes: k.scopes.split(','),
    createdAt: k.created_at,
    lastUsedAt: k.last_used_at ?? null,
  };
}

keysRouter.get('/', requireSession, (req, res) => {
  const keys = q('SELECT * FROM api_keys WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC').all(req.user.id);
  res.json({ keys: keys.map(keyJson) });
});

keysRouter.post('/', requireSession, json, (req, res) => {
  const name = String(req.body?.name ?? '').trim().slice(0, 80);
  if (!name) throw badRequest('Give the key a name so you can recognise it later');
  const scopes = Array.isArray(req.body?.scopes) ? SCOPES.filter((s) => req.body.scopes.includes(s)) : SCOPES;
  if (!scopes.length) throw badRequest('Pick at least one permission');
  const secret = `tgs_${randomToken(30)}`;
  const id = newId();
  q('INSERT INTO api_keys (id, user_id, name, prefix, key_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id, req.user.id, name, secret.slice(0, 10), sha256(secret), scopes.join(','), Date.now(),
  );
  res.status(201).json({ key: keyJson(q('SELECT * FROM api_keys WHERE id = ?').get(id)), secret });
});

keysRouter.delete('/:id', requireSession, (req, res) => {
  const r = q('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL').run(
    Date.now(), req.params.id, req.user.id,
  );
  if (!r.changes) throw notFound('API key not found');
  res.json({ ok: true });
});

// ---------------------------------------------------------------- used by the bot

/** Called when someone opens the t.me sign-in link. Returns what the bot should reply. */
export function beginTelegramLogin(code, from) {
  const r = q('SELECT * FROM login_requests WHERE code = ?').get(code);
  const t = Date.now();
  if (!r || r.expires_at < t || !['pending', 'awaiting'].includes(r.status) || (r.user_id && r.user_id !== from.id)) {
    return { ok: false, text: 'This sign-in link has expired. Go back to your browser and start again.' };
  }
  if (!isAllowedUser(from.id)) {
    q("UPDATE login_requests SET status = 'denied' WHERE code = ?").run(code);
    return {
      ok: false,
      text:
        "This storage is private, and your Telegram account isn't on its allowed list.\n\n" +
        `Your Telegram user ID is ${from.id}. The owner can add it to ALLOWED_TELEGRAM_USER_IDS.`,
    };
  }
  q("UPDATE login_requests SET status = 'awaiting', user_id = ?, user_json = ? WHERE code = ?").run(from.id, JSON.stringify(from), code);
  const when = new Date(r.created_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  return {
    ok: true,
    text:
      'Sign in to Telegram Storage?\n\n' +
      `Device: ${describeUserAgent(r.user_agent)}\n` +
      `IP address: ${r.ip || 'unknown'}\n` +
      `Requested: ${when}\n\n` +
      'Only approve if you started this sign-in yourself.',
  };
}

/** Called when the Approve / Deny button is pressed. */
export function finishTelegramLogin(code, from, approve) {
  const r = q('SELECT * FROM login_requests WHERE code = ?').get(code);
  if (!r || r.user_id !== from.id || r.status !== 'awaiting' || r.expires_at < Date.now()) {
    return { ok: false, text: 'This sign-in request is no longer valid.' };
  }
  if (!approve) {
    q("UPDATE login_requests SET status = 'denied' WHERE code = ?").run(code);
    return { ok: true, text: 'Sign-in denied. Nobody was signed in.' };
  }
  const t = Date.now();
  tx(() => {
    q(`INSERT INTO users (id, first_name, last_name, username, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET first_name = excluded.first_name, last_name = excluded.last_name,
         username = excluded.username, last_login_at = excluded.last_login_at`).run(
      from.id, from.first_name || '', from.last_name ?? null, from.username ?? null, t, t,
    );
    q("UPDATE login_requests SET status = 'approved' WHERE code = ?").run(code);
  });
  return { ok: true, approved: true, text: 'Signed in. You can go back to your browser.' };
}
