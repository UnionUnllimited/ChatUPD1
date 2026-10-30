import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { signInitData, grantRole } from '../server/auth.js';
import { createLoginToken, exchangeLoginToken } from '../server/lib/sessions.js';
import { invalidate } from '../server/lib/catalog.js';
import { setClock } from '../server/lib/time.js';

const TOKEN = '123456:TEST-token';
const config = {
  botToken: TOKEN, adminIds: [1], allowDevAuth: false, initDataMaxAgeSec: 3600,
  uploadsDir: '/tmp/linza-test-uploads', webhookSecret: 's3cret'
};
let server, base, db;
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
  db = openDb(':memory:');
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
  // The card carries a deep link that opens it straight in the Mini App.
  assert.match((await call(`/api/services/${sid}`)).body.share_url, new RegExp(`^https://t\\.me/\\w+/\\w+\\?startapp=s_${sid}$`));
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
  // Code always revalidates, so a deploy is picked up on the next open; unchanged files cost a 304.
  const js = await fetch(base + '/js/app.js');
  assert.equal(js.headers.get('cache-control'), 'no-cache');
  const again = await fetch(base + '/js/app.js', { headers: { 'if-none-match': js.headers.get('etag') } });
  assert.equal(again.status, 304);
  assert.equal((await fetch(base + '/img/logo.svg')).headers.get('cache-control'), 'public, max-age=300');
});

test('admin panel page, redirect and CSV export', async () => {
  const redirect = await fetch(base + '/admin', { redirect: 'manual' });
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.get('location'), 'admin/'); // relative, so it survives a /linza prefix
  assert.match(await (await fetch(base + '/admin/')).text(), /Админ-панель/);
  const csv = await fetch(base + '/api/admin/export/services.csv', { headers: { authorization: tma(1, 'Admin') } });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const bytes = new Uint8Array(await csv.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]); // BOM, so Excel reads UTF-8
  assert.match(new TextDecoder().decode(bytes), /^ID;Название/);
  assert.equal((await fetch(base + '/api/admin/export/services.csv', { headers: { authorization: tma(5) } })).status, 403);
});

test('status votes are accepted only from Telegram-signed requests', async () => {
  const sid = (await call('/api/catalog')).body.items[0].id;
  const ok = await call(`/api/services/${sid}/vote`, { method: 'POST', auth: tma(21, 'Voter'), body: { value: 'down' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.health.my_vote.value, 'down');
  assert.equal(ok.body.health.status, 'operational'); // a brand-new account is not counted
  const net = await call(`/api/services/${sid}/vote`, { method: 'PATCH', auth: tma(21, 'Voter'), body: { network: 'beeline' } });
  assert.equal(net.body.health.my_vote.network, 'beeline');
  const { session } = exchangeLoginToken(db, createLoginToken(db, 1), 'test');
  assert.equal((await call(`/api/services/${sid}/vote`, { method: 'POST', auth: `Session ${session}`, body: { value: 'up' } })).status, 403);
  assert.equal((await call(`/api/services/${sid}/vote`, { method: 'POST', body: { value: 'up' } })).status, 401);
});

test('ad exchange over HTTP: a seller lists a channel, a VPN owner books it, contacts open after agreement', async () => {
  const seller = tma(60, 'Seller');
  const created = await call('/api/ads/my', { method: 'POST', auth: seller, body: {
    link: '@http_channel', title: 'HTTP канал', topic: 'news', subscribers: 10000, reach_24: 4000, reach_48: 5000,
    formats: { '1/24': 1000 }, free_dates: [], contact: '@http_seller'
  } });
  assert.equal(created.status, 200);
  const ch = created.body.id;
  const feed = await call('/api/ads/channels?topics=news', { auth: tma(61) });
  const card = feed.body.items.find((c) => c.id === ch);
  assert.equal(card.best.cpm, 250);
  assert.equal(card.best.light, 'good');
  assert.equal(card.contact, undefined);
  const date = new Date(Date.now() + 3 * 86400_000 + 3 * 3600_000).toISOString().slice(0, 10);
  // A client without a VPN can't book; a VPN owner can.
  assert.equal((await call(`/api/ads/channels/${ch}/deals`, { method: 'POST', auth: tma(61), body: { format: '1/24', date } })).status, 403);
  await call('/api/me', { auth: tma(62, 'Buyer') }); // the account appears on first sign-in
  grantRole(db, 62, 'vpn_owner');
  const booked = await call(`/api/ads/channels/${ch}/deals`, { method: 'POST', auth: tma(62, 'Buyer'), body: { format: '1/24', date } });
  assert.equal(booked.status, 200);
  const deal = booked.body.id;
  assert.equal((await call(`/api/ads/deals/${deal}`, { auth: tma(62) })).body.seller_contact, null);
  assert.equal((await call(`/api/ads/deals/${deal}/agree`, { method: 'POST', auth: tma(62) })).status, 403);
  const agreed = await call(`/api/ads/deals/${deal}/agree`, { method: 'POST', auth: seller });
  assert.equal(agreed.body.status, 'agreed');
  assert.equal((await call(`/api/ads/deals/${deal}`, { auth: tma(62) })).body.seller_contact, '@http_seller');
  assert.equal((await call(`/api/ads/deals/${deal}`, { auth: tma(63) })).status, 403);
  const me = await call('/api/me', { auth: seller });
  assert.ok(me.body.roles.includes('ad_seller'));
  assert.equal((await call('/api/me', { method: 'PATCH', auth: seller, body: { active_role: 'ad_seller' } })).status, 200);
});
