import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { upsertUser, loadUser, authenticate, grantRole } from '../server/auth.js';
import { setClock } from '../server/lib/time.js';
import { invalidate, snapshot } from '../server/lib/catalog.js';
import { createLoginToken, exchangeLoginToken } from '../server/lib/sessions.js';
import { createService, editService, assignOwner, deleteService, setRole, broadcast, purgeDemo, toCsv } from '../server/lib/adminops.js';
import { validateCard } from '../server/lib/validate.js';

const T0 = Date.UTC(2026, 9, 15, 9);
const config = { adminIds: [1], botToken: 'x', allowDevAuth: false, initDataMaxAgeSec: 3600 };
let db, admin;
const card = (over = {}) => validateCard({
  name: 'Панельный VPN', bot_url: '@panel_vpn_bot', devices: 3, tariffs: { 1: 300 },
  protocols: ['vless_reality'], countries: ['nl'], platforms: ['ios'], payments: ['sbp'], ...over
});
const user = (id, extra = {}) => { upsertUser(db, { id, first_name: `U${id}`, ...extra }); return loadUser(db, id, config.adminIds); };

beforeEach(() => {
  setClock(() => T0);
  db = openDb(':memory:');
  invalidate();
  admin = user(1);
});

test('bot login link: one-time, expires, and only admins get a session', () => {
  const token = createLoginToken(db, 1);
  const { session } = exchangeLoginToken(db, token, 'test');
  assert.equal(authenticate(db, config, `Session ${session}`).id, 1);
  assert.throws(() => exchangeLoginToken(db, token, 'test'), /устарела/);

  const late = createLoginToken(db, 1);
  setClock(() => T0 + 11 * 60_000);
  assert.throws(() => exchangeLoginToken(db, late, 'test'), /устарела/);

  // A session stops working once admin rights are gone.
  user(2);
  grantRole(db, 2, 'admin');
  const s2 = exchangeLoginToken(db, createLoginToken(db, 2), 'test').session;
  assert.equal(authenticate(db, config, `Session ${s2}`).id, 2);
  setRole(db, admin, 2, 'admin', false, config.adminIds);
  assert.equal(authenticate(db, config, `Session ${s2}`), null);
  assert.equal(authenticate(db, config, 'Session not-a-real-token'), null);
});

test('admin creates, edits, hands over and deletes a service', () => {
  const id = createService(db, admin, card(), {});
  assert.equal(snapshot(db).byId.get(id).min_monthly, 300);
  user(50);
  db.run('INSERT INTO favorites (user_id, service_id, created_at) VALUES (50, ?, ?)', id, T0);
  const { changed } = editService(db, admin, id, card({ tariffs: { 1: 250 } }), {});
  assert.deepEqual(changed, ['tariffs']);
  assert.equal(snapshot(db).byId.get(id).min_monthly, 250);
  assert.equal(db.get("SELECT COUNT(*) n FROM notifications WHERE type = 'price_drop' AND user_id = 50").n, 1);

  assert.throws(() => assignOwner(db, admin, id, 777), /не открывал/);
  user(77);
  assignOwner(db, admin, id, 77);
  assert.ok(loadUser(db, 77).roles.includes('vpn_owner'));

  assert.throws(() => deleteService(db, admin, id, 'не то'), /точное название/);
  deleteService(db, admin, id, 'Панельный VPN');
  assert.equal(db.get('SELECT COUNT(*) n FROM services').n, 0);
  assert.deepEqual(db.all('SELECT action FROM audit_log ORDER BY id').map((a) => a.action),
    ['service.create', 'service.edit', 'service.owner', 'service.delete']);
});

test('roles: env admins and yourself cannot be demoted', () => {
  user(5);
  assert.throws(() => setRole(db, admin, 1, 'admin', false, config.adminIds), /ADMIN_IDS/);
  grantRole(db, 5, 'admin');
  const five = loadUser(db, 5, config.adminIds);
  assert.throws(() => setRole(db, five, 5, 'admin', false, config.adminIds), /с себя/);
  assert.deepEqual(setRole(db, admin, 5, 'vpn_owner', true, config.adminIds).sort(), ['admin', 'client', 'vpn_owner']);
});

test('broadcast respects audience, bot access and the news opt-out', () => {
  user(10, { allows_write_to_pm: true });
  user(11, { allows_write_to_pm: true });
  user(12);                               // bot cannot write to this one
  user(13, { allows_write_to_pm: true });
  grantRole(db, 13, 'vpn_owner');
  db.run("INSERT INTO user_notify (user_id, type, enabled) VALUES (11, 'news', 0)");
  assert.equal(broadcast(db, admin, { text: 'Привет всем', audience: 'all', dryRun: true }).recipients, 2);
  assert.equal(broadcast(db, admin, { text: 'Владельцам', audience: 'owners', dryRun: true }).recipients, 1);
  broadcast(db, admin, { text: 'Акции <b>недели</b>', audience: 'all' });
  const sent = db.all("SELECT user_id, text FROM notifications WHERE type = 'news' ORDER BY user_id");
  assert.deepEqual(sent.map((n) => n.user_id), [10, 13]);
  assert.match(sent[0].text, /&lt;b&gt;/); // admin text is escaped, not parsed as HTML
});

test('purge removes demo services and users, keeps real ones', () => {
  const real = createService(db, admin, card(), {});
  const demo = createService(db, admin, card({ name: 'Демо', bot_url: '@linza_demo_x_bot' }), {});
  const fake = 9_000_000_000_001;
  user(fake);
  db.run('INSERT INTO clicks (service_id, user_id, created_at) VALUES (?, ?, ?), (?, ?, ?)', real, fake, T0, demo, 1, T0);
  const r = purgeDemo(db, admin);
  assert.deepEqual(r, { services: 1, users: 1 });
  assert.deepEqual(db.all('SELECT id FROM services').map((s) => s.id), [real]);
  assert.equal(db.get('SELECT COUNT(*) n FROM users WHERE id = ?', fake).n, 0);
  assert.equal(db.get('SELECT COUNT(*) n FROM clicks').n, 0);
});

test('CSV is Excel-friendly and quotes awkward cells', () => {
  const csv = toCsv([{ a: 'x;y', b: 'say "hi"', c: null }], [['a', 'A'], ['b', 'B'], ['c', 'C']]);
  assert.equal(csv, '﻿A;B;C\r\n"x;y";"say ""hi""";');
});
