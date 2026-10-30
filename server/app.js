import { createReadStream, statSync } from 'node:fs';
import { join, normalize, extname, resolve } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { ROOT } from './config.js';
import { authenticate } from './auth.js';
import { createRouter, HttpError } from './lib/http.js';
import { publicRoutes } from './routes/public.js';
import { meRoutes } from './routes/me.js';
import { ownerRoutes } from './routes/owner.js';
import { adminRoutes } from './routes/admin.js';

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
    "img-src 'self' data: blob: https://t.me https://*.telegram.org https://*.t.me",
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

function serveFile(res, root, relPath, { fallback, cache } = {}) {
  const file = normalize(join(root, relPath));
  if (!file.startsWith(root)) return send(res, 403, { error: 'forbidden' });
  let st;
  try { st = statSync(file); } catch { st = null; }
  if (!st || !st.isFile()) {
    if (fallback) return serveFile(res, root, fallback, { cache: false });
    return send(res, 404, { error: 'Не найдено' });
  }
  const ext = extname(file);
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': st.size,
    // HTML always revalidates so a deploy reaches users right away; assets are short-cached.
    'cache-control': ext === '.html' || cache === false ? 'no-cache' : cache || 'public, max-age=300',
    ...SECURITY_HEADERS
  });
  createReadStream(file).pipe(res);
}

export function createApp({ db, config, bot, log = console }) {
  const router = createRouter();
  const deps = { db, config, bot };
  publicRoutes(router, deps);
  meRoutes(router, deps);
  ownerRoutes(router, deps);
  adminRoutes(router, deps);
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
          user: authenticate(db, config, req.headers.authorization)
        };
        const out = await match.handler(ctx);
        return send(res, 200, out ?? { ok: true });
      }
      if (path.startsWith('/uploads/')) return serveFile(res, config.uploadsDir, path.slice('/uploads/'.length), { cache: 'public, max-age=31536000, immutable' });
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      // SPA: unknown paths fall back to index.html.
      return serveFile(res, PUBLIC_DIR, path === '/' ? 'index.html' : decodeURIComponent(path), { fallback: 'index.html' });
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, code: e.code });
      log.error(req.method, path, e);
      return send(res, 500, { error: 'Внутренняя ошибка сервера' });
    }
  };
}
