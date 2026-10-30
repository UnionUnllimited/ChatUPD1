import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { upsertUser, loadUser, grantRole } from '../server/auth.js';
import { setClock, DAY } from '../server/lib/time.js';
import { invalidate, snapshot } from '../server/lib/catalog.js';
import { applyCard } from '../server/lib/moderation.js';
import { validateCard } from '../server/lib/validate.js';
import {
  recordVote, setVoteNetwork, recomputeActive, evaluateTrust, statusRow, serviceHealth,
  openDispute, clearStatus, confirmStatus, keepAnomaly, validateStatusConfig, statusConfig
} from '../server/lib/health.js';
import { computeTop } from '../server/lib/top.js';

const MIN = 60_000, HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 9, 15, 9);
let db, clock;
const at = (ts) => { clock = ts; setClock(() => clock); };
const env = { envAdmins: [1] };

function service(id, ownerId = null) {
  db.run("INSERT INTO services (id, owner_id, name, bot_url, created_at) VALUES (?, ?, ?, 'https://t.me/x_bot', ?)", id, ownerId, `VPN ${id}`, T0 - 40 * DAY);
  applyCard(db, id, validateCard({ name: `VPN ${id}`, bot_url: '@x_bot', devices: 1, tariffs: { 1: 200 }, protocols: ['vless'], countries: ['nl'], platforms: ['ios'], payments: ['sbp'] }));
  db.run('UPDATE services SET published_at = ? WHERE id = ?', T0 - 40 * DAY, id);
}
// An established account (older than 24 h); clicked = went to the bot through Линза.
function voter(id, { clicked = true, service: sid = 10, trust = 1, createdAgo = 3 * DAY } = {}) {
  const keep = clock;
  at(keep - createdAgo);
  upsertUser(db, { id, first_name: `U${id}`, allows_write_to_pm: true });
  at(keep);
  db.run('UPDATE users SET trust_score = ? WHERE id = ?', trust, id);
  if (clicked) db.run('INSERT INTO clicks (service_id, user_id, created_at) VALUES (?, ?, ?)', sid, id, keep - DAY);
  return loadUser(db, id, [1]);
}
const vote = (u, value, sid = 10) => recordVote(db, u, sid, value, env);
const status = (sid = 10) => statusRow(db, sid).status;

beforeEach(() => {
  at(T0);
  db = openDb(':memory:');
  invalidate();
  upsertUser(db, { id: 1, first_name: 'Admin', allows_write_to_pm: true });
  voter(500, { clicked: false });
  service(10, 500);
  service(11);
});

test('three weighted "down" votes raise «Есть сообщения о сбоях», eight raise «Массовый сбой»', () => {
  const users = Array.from({ length: 8 }, (_, i) => voter(100 + i));
  vote(users[0], 'down'); vote(users[1], 'down');
  assert.equal(status(), 'operational');
  vote(users[2], 'down');
  assert.equal(status(), 'issues');
  // The owner hears about it, with the network breakdown.
  const msg = db.get("SELECT text FROM notifications WHERE user_id = 500 ORDER BY id DESC");
  assert.match(msg.text, /Есть сообщения о сбоях/);
  for (const u of users.slice(3)) vote(u, 'down');
  assert.equal(status(), 'outage');
  assert.deepEqual(db.all('SELECT status, reason FROM status_changes ORDER BY id').map((c) => c.status), ['issues', 'outage']);
  assert.equal(snapshot(db).byId.get(10).health, 'outage');
});

test('weights: without a click-through a vote weighs 0.3, and trust scales it', () => {
  for (let i = 0; i < 4; i++) vote(voter(200 + i, { clicked: false }), 'down'); // 4 × 0.3 = 1.2 < 2
  assert.equal(status(), 'operational');
  for (let i = 0; i < 3; i++) vote(voter(210 + i, { trust: 0.5 }), 'down');   // + 3 × 0.5 → 2.7
  assert.equal(status(), 'issues');
});

test('"works" that outweighs keeps or brings the status back to «Работает»', () => {
  for (let i = 0; i < 4; i++) vote(voter(300 + i), 'up');
  for (let i = 0; i < 3; i++) vote(voter(310 + i), 'down');
  assert.equal(status(), 'operational');           // 3 down vs 4 up
  for (let i = 0; i < 3; i++) vote(voter(320 + i), 'down');
  assert.equal(status(), 'issues');                // 6 down vs 4 up
  for (let i = 0; i < 3; i++) vote(voter(330 + i), 'up');
  assert.equal(status(), 'operational');           // 6 down vs 7 up
  assert.equal(db.get('SELECT reason FROM status_changes ORDER BY id DESC').reason, 'recovered');
});

test('a failure status sticks after the window and ends 6 h after the last "down" vote', () => {
  for (let i = 0; i < 3; i++) vote(voter(400 + i), 'down');
  at(T0 + 3 * HOUR);
  recomputeActive(db);
  assert.equal(status(), 'issues');                // window is empty, but no 6 h yet
  at(T0 + 6 * HOUR + MIN);
  recomputeActive(db);
  assert.equal(status(), 'operational');
  assert.equal(db.get('SELECT reason FROM status_changes ORDER BY id DESC').reason, 'timeout');
});

test('new accounts and VPN owners are stored but never counted', () => {
  const fresh = Array.from({ length: 5 }, (_, i) => voter(600 + i, { createdAgo: 2 * HOUR }));
  fresh.forEach((u) => vote(u, 'down'));
  assert.equal(status(), 'operational');
  assert.equal(db.get("SELECT COUNT(*) n FROM status_votes WHERE excluded = 'new_account'").n, 5);
  const rival = voter(700);
  db.run('UPDATE services SET owner_id = 700 WHERE id = 11');
  vote(rival, 'down');
  assert.equal(db.get('SELECT excluded FROM status_votes WHERE user_id = 700').excluded, 'owner');
});

test('one vote per service per 12 h (a new one replaces it), at most 5 services a day', () => {
  const u = voter(800);
  vote(u, 'up');
  at(T0 + HOUR);
  vote(u, 'up');                                   // same opinion: not refreshed
  assert.equal(db.get('SELECT created_at FROM status_votes WHERE user_id = 800').created_at, T0);
  vote(u, 'down');                                 // changed mind: replaced
  assert.deepEqual({ ...db.get('SELECT COUNT(*) n, value, created_at FROM status_votes WHERE user_id = 800') }, { n: 1, value: 0, created_at: T0 + HOUR });
  setVoteNetwork(db, u, 10, 'mts');
  assert.equal(db.get('SELECT network FROM status_votes WHERE user_id = 800').network, 'mts');
  at(T0 + 13 * HOUR);
  vote(u, 'down');                                 // after the cooldown: a new vote
  assert.equal(db.get('SELECT COUNT(*) n FROM status_votes WHERE user_id = 800').n, 2);

  for (let i = 20; i < 24; i++) service(i);
  for (let i = 20; i < 24; i++) vote(u, 'up', i);  // 10 + 4 more = 5 services in 24 h
  service(25);
  assert.throws(() => vote(u, 'up', 25), (e) => e.status === 429);
});

test('trust drifts with agreement after 2 h and stays within 0.1–2.0', () => {
  const liar = voter(900);
  const honest = Array.from({ length: 3 }, (_, i) => voter(910 + i));
  honest.forEach((u) => vote(u, 'up'));
  vote(liar, 'down');
  at(T0 + HOUR);
  evaluateTrust(db);
  assert.equal(loadUser(db, 900).trust_score, 1);  // too early
  at(T0 + 2 * HOUR + MIN);
  evaluateTrust(db);
  assert.equal(loadUser(db, 900).trust_score, 0.85);
  assert.equal(loadUser(db, 910).trust_score, 1.05);
  db.run('UPDATE users SET trust_score = 0.12 WHERE id = 900');
  db.run('UPDATE status_votes SET trust_checked_at = NULL WHERE user_id = 900');
  evaluateTrust(db);
  assert.equal(loadUser(db, 900).trust_score, 0.1);
  // A lone vote has nothing to be compared with.
  const lone = voter(950, { service: 11 });
  vote(lone, 'down', 11);
  at(T0 + 5 * HOUR);
  evaluateTrust(db);
  assert.equal(loadUser(db, 950).trust_score, 1);
});

test('anomalies notify admins: low-trust majority and vote spikes', () => {
  for (let i = 0; i < 3; i++) vote(voter(1000 + i, { trust: 2 }), 'down');   // high trust: fine
  assert.equal(db.get('SELECT COUNT(*) n FROM status_anomalies').n, 0);
  for (let i = 0; i < 4; i++) vote(voter(1010 + i, { trust: 0.3 }), 'down');
  assert.equal(db.get("SELECT COUNT(*) n FROM status_anomalies WHERE kind = 'low_trust'").n, 1);
  assert.equal(db.get("SELECT COUNT(*) n FROM notifications WHERE type = 'admin' AND user_id = 1").n, 1);
  for (let i = 0; i < 6; i++) vote(voter(1100 + i, { clicked: false, createdAgo: HOUR }), 'up', 11);
  assert.equal(db.get("SELECT COUNT(*) n FROM status_anomalies WHERE kind = 'spike'").n, 0);
  for (let i = 0; i < 4; i++) vote(voter(1110 + i, { clicked: false, createdAgo: HOUR }), 'up', 11);
  assert.equal(db.get("SELECT COUNT(*) n FROM status_anomalies WHERE kind = 'spike'").n, 1);
  // Admin finds the spike genuine: it closes, the votes stay.
  const spike = db.get("SELECT id FROM status_anomalies WHERE kind = 'spike'");
  const admin = loadUser(db, 1, [1]);
  keepAnomaly(db, admin, spike.id);
  assert.equal(db.get('SELECT state FROM status_anomalies WHERE id = ?', spike.id).state, 'confirmed');
  assert.equal(db.get('SELECT COUNT(*) n FROM status_votes WHERE service_id = 11').n, 10);
  assert.throws(() => keepAnomaly(db, admin, spike.id), /уже закрыта/);
});

test('owner disputes; admin clears (old votes stop counting) or confirms', () => {
  const owner = loadUser(db, 500);
  grantRole(db, 500, 'vpn_owner');
  assert.throws(() => openDispute(db, owner, 10, 'всё работает', env), /Оспаривать нечего/);
  for (let i = 0; i < 3; i++) vote(voter(1200 + i), 'down');
  openDispute(db, owner, 10, 'у нас всё работает', env);
  assert.match(db.get("SELECT text FROM notifications WHERE type = 'admin' ORDER BY id DESC").text, /оспорил/);
  assert.throws(() => openDispute(db, owner, 10, 'ещё раз', env), /уже на рассмотрении/);

  confirmStatus(db, loadUser(db, 1, [1]), 10);
  assert.equal(db.get('SELECT state FROM status_disputes').state, 'confirmed');
  assert.equal(status(), 'issues');

  clearStatus(db, loadUser(db, 1, [1]), 10, 'проверил сам');
  assert.equal(status(), 'operational');
  vote(voter(1210), 'up');                         // any recompute: the old "down" votes no longer count
  assert.equal(status(), 'operational');
  assert.equal(db.get('SELECT reason FROM status_changes ORDER BY id DESC').reason, 'admin_clear');
});

test('availability: 30-day bar and monthly top stability = share of time without failures', () => {
  // October: 3 days of «Массовый сбой» on service 10.
  db.run("INSERT INTO status_changes (service_id, status, changed_at, reason) VALUES (10, 'outage', ?, 'votes'), (10, 'operational', ?, 'timeout')",
    Date.UTC(2026, 9, 3), Date.UTC(2026, 9, 6));
  at(Date.UTC(2026, 10, 2, 9));                    // 2 November: October is over
  const top = computeTop(db, '2026-10');
  const row = (id) => top.rows.find((r) => r.service_id === id).components;
  assert.equal(row(11).stability, 1);
  assert.ok(Math.abs(row(10).stability - (1 - 3 / 31)) < 0.001, `stability ${row(10).stability}`);
  assert.equal(row(10).downtime_min, 3 * 24 * 60);

  at(Date.UTC(2026, 9, 20, 9));
  const h = serviceHealth(db, 10);
  assert.equal(h.days.length, 30);
  assert.ok(h.days.some((d) => d.outage_min > 0));
  assert.ok(h.uptime30 < 100 && h.uptime30 > 85);
});

test('network breakdown appears once enough votes name a network', () => {
  const users = Array.from({ length: 5 }, (_, i) => voter(1300 + i));
  users.forEach((u, i) => { vote(u, i < 3 ? 'down' : 'up'); });
  users.slice(0, 4).forEach((u) => setVoteNetwork(db, u, 10, 'mts'));
  assert.equal(serviceHealth(db, 10).networks, null);
  setVoteNetwork(db, users[4], 10, 'wifi');
  const h = serviceHealth(db, 10, 1300);
  assert.deepEqual(h.networks.items.map((n) => [n.network, n.up, n.down]), [['mts', 1, 3], ['wifi', 1, 0]]);
  assert.equal(h.my_vote.value, 'down');
});

test('settings are validated against the shared field list', () => {
  const cfg = statusConfig(db);
  assert.deepEqual(validateStatusConfig(cfg), cfg);
  assert.throws(() => validateStatusConfig({ ...cfg, issues_votes: 0 }), /от 1/);
  assert.throws(() => validateStatusConfig({ ...cfg, outage_votes: 2 }), /не может быть ниже/);
});
