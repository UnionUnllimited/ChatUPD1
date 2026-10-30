import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { signInitData } from '../server/auth.js';
import { invalidate } from '../server/lib/catalog.js';
import { setClock } from '../server/lib/time.js';

const TOKEN = '123456:TEST-token';
const config = {
  botToken: TOKEN, adminIds: [1], allowDevAuth: false, initDataMaxAgeSec: 3600,
  uploadsDir: '/tmp/linza-test-uploads', webhookSecret: 's3cret'
};
let server, base;
const bot = { enabled: false, handleUpdate: async () => {} };
const silent = { info() {}, warn() {}, error() {} };

const tma = (id, name = 'Test') => 'tma ' + signInitData({ user: JSON.stringify({ id, first_name: name }), auth_date: String(Math.floor(Date.now() / 1000)) }, TOKEN);
const call = async (path, { method = 'GET', body, auth } = {}) => {
  const res = await fetch(base + path, { method, headers: { ...(auth ? { authorization: auth } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};

before(async () => {
  setClock(null);
  invalidate();
  const db = openDb(':memory:');
  server = createServer(createApp({ db, config, bot, log: silent }));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('public catalog works without auth; personal routes need Telegram', async () => {
  assert.equal((await call('/api/catalog')).status, 200);
  assert.equal((await call('/api/me')).status, 401);
  assert.equal((await call('/api/me', { auth: 'dev 1' })).status, 401); // dev auth is off
  const me = await call('/api/me', { auth: tma(5, 'Клиент') });
  assert.equal(me.status, 200);
  assert.equal(me.body.first_name, 'Клиент');
});

test('admin routes are closed to regular users', async () => {
  assert.equal((await call('/api/admin/summary', { auth: tma(5) })).status, 403);
  assert.equal((await call('/api/admin/summary', { auth: tma(1, 'Admin') })).status, 200);
});

test('full path: apply -> approve -> submit card -> approve -> visible in catalog', async () => {
  const owner = tma(7, 'Owner');
  const adm = tma(1, 'Admin');
  const app = await call('/api/owner/applications', { method: 'POST', auth: owner, body: { name: 'Линзовый VPN', link: '@lens_vpn_bot', contact: '@owner' } });
  assert.equal(app.status, 200, JSON.stringify(app.body));
  const ok = await call(`/api/admin/applications/${app.body.application.id}/approve`, { method: 'POST', auth: adm });
  const sid = ok.body.service_id;
  const rev = await call(`/api/owner/services/${sid}/revisions`, {
    method: 'POST', auth: owner,
    body: { name: 'Линзовый VPN', bot_url: '@lens_vpn_bot', devices: 5, tariffs: { 1: 199 }, protocols: ['vless_reality'], countries: ['nl'], platforms: ['ios'], payments: ['sbp'] }
  });
  assert.equal(rev.status, 200, JSON.stringify(rev.body));
  assert.equal((await call('/api/catalog')).body.items.length, 0);
  const queue = await call('/api/admin/moderation?kind=revisions', { auth: adm });
  assert.equal(queue.body.items[0].diff.is_new, true);
  await call(`/api/admin/revisions/${rev.body.revision_id}/approve`, { method: 'POST', auth: adm });
  const cat = await call('/api/catalog');
  assert.equal(cat.body.items[0].name, 'Линзовый VPN');
  assert.equal(cat.body.items[0].min_monthly, 199);
  // Another user cannot edit someone else's card.
  assert.equal((await call(`/api/owner/services/${sid}/revisions`, { method: 'POST', auth: tma(8), body: {} })).status, 403);
  // Click logging unlocks reviews.
  const client = tma(9, 'Client');
  assert.equal((await call(`/api/services/${sid}/reviews`, { method: 'POST', auth: client, body: { rating: 5, text: 'Работает отлично и быстро' } })).status, 403);
  assert.equal((await call(`/api/services/${sid}/click`, { method: 'POST', auth: client, body: { source: 'card' } })).body.url, 'https://t.me/lens_vpn_bot');
  assert.equal((await call(`/api/services/${sid}/reviews`, { method: 'POST', auth: client, body: { rating: 5, text: 'Работает отлично и быстро' } })).status, 200);
});

test('webhook requires the secret token', async () => {
  assert.equal((await call('/bot/webhook', { method: 'POST', body: {} })).status, 401);
});

test('static files and SPA fallback', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /telegram\.org/);
  // Files outside public/ are never served; unknown paths get the SPA shell.
  const leak = await (await fetch(base + '/%2e%2e/package.json')).text();
  assert.doesNotMatch(leak, /"scripts"/);
});
