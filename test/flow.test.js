import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { upsertUser, loadUser } from '../server/auth.js';
import { setClock, DAY } from '../server/lib/time.js';
import { invalidate, snapshot, filterItems, parseFilters } from '../server/lib/catalog.js';
import {
  createApplication, approveApplication, submitRevision, approveRevision, rejectRevision,
  createPromo, approvePromo, expirePromos, upsertReview, moderateReview
} from '../server/lib/moderation.js';
import { validateCard } from '../server/lib/validate.js';
import { computeTop, publishTop } from '../server/lib/top.js';
import { autoPublishTop } from '../server/lib/scheduler.js';

const T0 = Date.UTC(2026, 9, 15, 9); // 15 Oct 2026, 12:00 MSK
let db, admin;

const card = (over = {}) => validateCard({
  name: 'Тест VPN', bot_url: '@test_vpn_bot', devices: 3,
  tariffs: { 1: 300, 3: 810, 12: 2400 },
  protocols: ['vless_reality'], countries: ['nl', 'de'], platforms: ['ios', 'android'], payments: ['card_ru', 'sbp'],
  ...over
});

function makeUser(id, name = 'User') {
  upsertUser(db, { id, first_name: name });
  return loadUser(db, id, [1]);
}

function publishedService(ownerId, over) {
  const owner = makeUser(ownerId, 'Owner');
  const app = createApplication(db, owner, { name: over?.name || `VPN ${ownerId}`, link: `https://t.me/vpn${ownerId}_bot`, contact: '@o' });
  const { service_id } = approveApplication(db, admin, app.id);
  const rev = submitRevision(db, loadUser(db, ownerId), service_id, card(over));
  approveRevision(db, admin, rev, {});
  return service_id;
}

beforeEach(() => {
  setClock(() => T0);
  db = openDb(':memory:');
  invalidate();
  admin = makeUser(1, 'Admin');
});

test('application approval opens the owner cabinet', () => {
  const owner = makeUser(10);
  const app = createApplication(db, owner, { name: 'Новый', link: 'https://t.me/new_vpn_bot', contact: '@me' });
  const { service_id } = approveApplication(db, admin, app.id);
  assert.ok(loadUser(db, 10).roles.includes('vpn_owner'));
  assert.equal(db.get('SELECT status FROM services WHERE id = ?', service_id).status, 'draft');
  assert.equal(db.get("SELECT COUNT(*) n FROM notifications WHERE user_id = 10 AND type = 'moderation'").n, 1);
  assert.equal(db.get("SELECT action FROM audit_log ORDER BY id DESC").action, 'application.approve');
  assert.throws(() => approveApplication(db, admin, app.id), /уже рассмотрена/);
});

test('edits stay invisible until approved; clients see the old version', () => {
  const id = publishedService(20);
  assert.equal(snapshot(db).byId.get(id).min_monthly, 200); // 2400 / 12
  submitRevision(db, loadUser(db, 20), id, card({ tariffs: { 1: 100 } }));
  invalidate();
  assert.equal(snapshot(db).byId.get(id).min_monthly, 200);
  const pending = db.get("SELECT id FROM service_revisions WHERE status = 'pending'").id;
  rejectRevision(db, admin, pending, 'Цена указана с ошибкой');
  assert.equal(snapshot(db).byId.get(id).min_monthly, 200);
});

test('a price drop notifies users who favorited the VPN, respecting settings', () => {
  const id = publishedService(30);
  makeUser(100); makeUser(101);
  db.run('INSERT INTO favorites (user_id, service_id, created_at) VALUES (100, ?, ?), (101, ?, ?)', id, T0, id, T0);
  db.run("INSERT INTO user_notify (user_id, type, enabled) VALUES (101, 'price_drop', 0)");
  const rev = submitRevision(db, loadUser(db, 30), id, card({ tariffs: { 1: 150 } }));
  approveRevision(db, admin, rev, {});
  const sent = db.all("SELECT user_id FROM notifications WHERE type = 'price_drop'").map((n) => n.user_id);
  assert.deepEqual(sent, [100]);
});

test('market label compares with the catalog average', () => {
  const cheap = publishedService(40, { name: 'Дешёвый', tariffs: { 1: 100 } });
  const mid = publishedService(41, { name: 'Средний', tariffs: { 1: 200 } });
  const pricey = publishedService(42, { name: 'Дорогой', tariffs: { 1: 300 } });
  const snap = snapshot(db);
  assert.equal(snap.avg, 200);
  assert.equal(snap.byId.get(cheap).market, 'below');
  assert.equal(snap.byId.get(mid).market, 'market');
  assert.equal(snap.byId.get(pricey).market, 'above');
  const below = filterItems(snap.items, parseFilters({ below_market: '1' }));
  assert.deepEqual(below.map((s) => s.id), [cheap]);
});

test('catalog filters: any-of for protocols, all-of for platforms', () => {
  const a = publishedService(50, { name: 'Альфа', protocols: ['wireguard'], platforms: ['ios', 'android', 'windows'] });
  const b = publishedService(51, { name: 'Бета', protocols: ['vless_reality'], platforms: ['ios'] });
  const items = snapshot(db).items;
  assert.deepEqual(filterItems(items, parseFilters({ protocols: 'wireguard,vless_reality' })).map((s) => s.id).sort(), [a, b]);
  assert.deepEqual(filterItems(items, parseFilters({ platforms: 'ios,windows' })).map((s) => s.id), [a]);
});

test('reviews require a click through the platform and go through moderation', () => {
  const id = publishedService(60);
  const client = makeUser(200);
  assert.throws(() => upsertReview(db, client, id, { rating: 5, text: 'Отличный сервис, всё работает' }), /после перехода/);
  db.run('INSERT INTO clicks (service_id, user_id, created_at) VALUES (?, ?, ?)', id, 200, T0);
  const r = upsertReview(db, client, id, { rating: 5, text: 'Отличный сервис, всё работает' });
  assert.equal(r.status, 'pending');
  invalidate();
  assert.equal(snapshot(db).byId.get(id).reviews, 0);
  moderateReview(db, admin, r.id, true);
  assert.equal(snapshot(db).byId.get(id).reviews, 1);
  // Editing sends it back to moderation.
  upsertReview(db, client, id, { rating: 3, text: 'Стало хуже по вечерам, но работает' });
  assert.equal(snapshot(db).byId.get(id).reviews, 0);
});

test('promotions: moderated, shown while active, expire automatically', () => {
  const id = publishedService(70);
  makeUser(300);
  db.run('INSERT INTO favorites (user_id, service_id, created_at) VALUES (300, ?, ?)', id, T0);
  const p = createPromo(db, loadUser(db, 70), id, { title: '−20%', discount_percent: 20, starts_at: T0 - DAY, ends_at: T0 + 3 * DAY });
  assert.equal(snapshot(db).byId.get(id).promo, null);
  approvePromo(db, admin, p.id);
  assert.equal(snapshot(db).byId.get(id).promo.discount_percent, 20);
  assert.equal(db.get("SELECT COUNT(*) n FROM notifications WHERE type = 'promo' AND user_id = 300").n, 1);
  setClock(() => T0 + 4 * DAY);
  assert.equal(expirePromos(db), 1);
  assert.equal(snapshot(db).byId.get(id).promo, null);
});

test('monthly top: composite score with configurable weights, archive badge', () => {
  setClock(() => Date.UTC(2026, 8, 2, 9)); // services published in early September
  const good = publishedService(80, { name: 'Хороший' });
  const busy = publishedService(81, { name: 'Популярный' });
  const sept = Date.UTC(2026, 8, 10, 9);
  for (let i = 0; i < 10; i++) { makeUser(1000 + i); db.run('INSERT INTO clicks (service_id, user_id, created_at) VALUES (?, ?, ?)', busy, 1000 + i, sept); }
  makeUser(2000);
  db.run('INSERT INTO clicks (service_id, user_id, created_at) VALUES (?, 2000, ?)', good, sept);
  db.run("INSERT INTO reviews (service_id, user_id, rating, text, status, created_at, updated_at) VALUES (?, 2000, 5, 'Отлично работает', 'approved', ?, ?)", good, sept, sept);
  db.run('INSERT INTO service_checks (service_id, admin_id, passed, checked_at) VALUES (?, 1, 1, ?), (?, 1, 0, ?)', good, sept, busy, sept);

  const byDefault = computeTop(db, '2026-09');
  assert.equal(byDefault.rows[0].service_id, good);
  const clientsOnly = computeTop(db, '2026-09', { rating: 0, clients: 1, stability: 0 });
  assert.equal(clientsOnly.rows[0].service_id, busy);
  assert.equal(clientsOnly.rows[0].score, 100);

  setClock(() => Date.UTC(2026, 9, 1, 10)); // 1 Oct, 13:00 MSK — after the auto-publish hour
  assert.equal(autoPublishTop(db, 12), true);
  assert.equal(autoPublishTop(db, 12), false); // only once
  invalidate();
  assert.deepEqual(snapshot(db).byId.get(good).top, { period: '2026-09', rank: 1 });
  publishTop(db, '2026-09', 1); // re-publish replaces the snapshot without a second broadcast
  assert.equal(db.get("SELECT COUNT(*) n FROM top_entries WHERE period = '2026-09'").n, 2);
});

test('card validation rejects bad input', () => {
  assert.throws(() => card({ tariffs: {} }), /хотя бы один тариф/);
  assert.throws(() => card({ protocols: ['magic'] }), /Неизвестное значение/);
  assert.throws(() => card({ bot_url: 'https://evil.example/bot' }), /t\.me/);
  assert.throws(() => card({ logo: 'javascript:alert(1)' }), /Логотип/);
  assert.equal(card({ bot_url: 't.me/Some_vpn_bot' }).bot_url, 'https://t.me/Some_vpn_bot');
});
