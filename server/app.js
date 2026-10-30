import { createReadStream, readFileSync, statSync } from 'node:fs';
import { join, normalize, extname, resolve } from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { ROOT } from './config.js';
import { authenticate } from './auth.js';
import { createRouter, HttpError, RawResponse } from './lib/http.js';
import { publicRoutes } from './routes/public.js';
import { meRoutes } from './routes/me.js';
import { ownerRoutes } from './routes/owner.js';
import { adminRoutes } from './routes/admin.js';
import { panelRoutes } from './routes/panel.js';
import { healthRoutes } from './routes/health.js';
import { adsRoutes } from './routes/ads.js';

const PUBLIC_DIR = resolve(ROOT, 'public');
const MAX_BODY = 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json'
};

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  // Telegram embeds the Mini App in an iframe on web clients, so framing stays allowed.
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self' https://telegram.org",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "connect-src 'self'",
    "frame-ancestors *"
  ].join('; ')
};

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS, ...headers });
  res.end(data);
}

function readBody(req) {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { fail(new HttpError(413, 'Слишком большой запрос')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return ok(null);
      try { ok(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { fail(new HttpError(400, 'Неверный JSON')); }
    });
    req.on('error', fail);
  });
}

// Code and pages revalidate on every load (a cheap 304 by ETag): a deploy reaches everyone
// at once, and Telegram's webview never mixes old and new modules. Images are short-cached.
const REVALIDATE = new Set(['.html', '.js', '.css', '.json', '.webmanifest']);
// ETag from the content (not only mtime, which a Docker build may not keep), hashed once per version.
const etags = new Map();
function etagOf(file, st) {
  const key = `${file}|${st.size}|${st.mtimeMs}`;
  let tag = etags.get(key);
  if (!tag) {
    tag = `W/"${createHash('sha1').update(readFileSync(file)).digest('base64url').slice(0, 16)}"`;
    etags.set(key, tag);
  }
  return tag;
}

function serveFile(res, root, relPath, { fallback, cache, ifNoneMatch } = {}) {
  const file = normalize(join(root, relPath));
  if (!file.startsWith(root)) return send(res, 403, { error: 'forbidden' });
  let st;
  try { st = statSync(file); } catch { st = null; }
  // A directory serves its index.html (e.g. /admin/ — the admin panel). Without the
  // trailing slash, redirect relatively so it also works under a path prefix like /linza.
  if (st?.isDirectory()) {
    if (!relPath.endsWith('/')) {
      res.writeHead(301, { location: `${relPath.split('/').filter(Boolean).pop()}/`, ...SECURITY_HEADERS });
      return res.end();
    }
    return serveFile(res, root, join(relPath, 'index.html'), { fallback, cache: false, ifNoneMatch });
  }
  if (!st || !st.isFile()) {
    if (fallback) return serveFile(res, root, fallback, { cache: false, ifNoneMatch });
    return send(res, 404, { error: 'Не найдено' });
  }
  const ext = extname(file);
  const etag = etagOf(file, st);
  const headers = {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': typeof cache === 'string' ? cache : cache === false || REVALIDATE.has(ext) ? 'no-cache' : 'public, max-age=300',
    etag,
    'last-modified': st.mtime.toUTCString(),
    ...SECURITY_HEADERS
  };
  if (ifNoneMatch && ifNoneMatch.split(/\s*,\s*/).includes(etag)) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, { ...headers, 'content-length': st.size });
  createReadStream(file).pipe(res);
}

export function createApp({ db, config, bot, log = console }) {
  const router = createRouter();
  const deps = { db, config, bot };
  publicRoutes(router, deps);
  meRoutes(router, deps);
  ownerRoutes(router, deps);
  adminRoutes(router, deps);
  panelRoutes(router, deps);
  healthRoutes(router, deps);
  adsRoutes(router, deps);
  router.get('/api/health', () => ({ ok: true }));

  async function handleWebhook(req, res) {
    const secret = Buffer.from(String(req.headers['x-telegram-bot-api-secret-token'] || ''));
    const expected = Buffer.from(config.webhookSecret);
    if (!config.webhookSecret || secret.length !== expected.length || !timingSafeEqual(secret, expected)) return send(res, 401, { ok: false });
    const update = await readBody(req).catch(() => null);
    send(res, 200, { ok: true });
    if (update) bot.handleUpdate(db, update).catch((e) => log.error('webhook update failed:', e.message));
  }

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    try {
      if (path === '/bot/webhook' && req.method === 'POST') return await handleWebhook(req, res);
      if (path.startsWith('/api/')) {
        const match = router.match(req.method, path);
        if (!match) throw new HttpError(404, 'Метод не найден');
        const ctx = {
          params: match.params,
          query: Object.fromEntries(url.searchParams),
          body: ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req) : null,
          user: authenticate(db, config, req.headers.authorization),
          authorization: req.headers.authorization || '',
          userAgent: req.headers['user-agent'] || ''
        };
        const out = await match.handler(ctx);
        if (out instanceof RawResponse) return send(res, 200, out.body, out.headers);
        return send(res, 200, out ?? { ok: true });
      }
      const ifNoneMatch = req.headers['if-none-match'];
      if (path.startsWith('/uploads/')) return serveFile(res, config.uploadsDir, path.slice('/uploads/'.length), { cache: 'public, max-age=31536000, immutable', ifNoneMatch });
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      // SPA: unknown paths fall back to index.html.
      return serveFile(res, PUBLIC_DIR, path === '/' ? 'index.html' : decodeURIComponent(path), { fallback: 'index.html', ifNoneMatch });
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, code: e.code });
      log.error(req.method, path, e);
      return send(res, 500, { error: 'Внутренняя ошибка сервера' });
    }
  };
}
