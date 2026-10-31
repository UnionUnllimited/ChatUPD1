import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { upsertUser, loadUser } from '../server/auth.js';
import { setClock, DAY } from '../server/lib/time.js';
import { invalidate } from '../server/lib/catalog.js';
import { applyCard } from '../server/lib/moderation.js';
import { validateCard } from '../server/lib/validate.js';
import { recordVote, setVoteNetwork } from '../server/lib/health.js';
import { radar } from '../server/lib/radar.js';

const MIN = 60_000, HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 10, 2, 9);
let db, clock, uid = 1000;
const at = (ts) => { clock = ts; setClock(() => clock); };

function service(id) {
  db.run("INSERT INTO services (id, name, bot_url, created_at) VALUES (?, ?, 'https://t.me/x_bot', ?)", id, `VPN ${id}`, T0 - 40 * DAY);
  applyCard(db, id, validateCard({ name: `VPN ${id}`, bot_url: `@vpn${id}_bot`, devices: 1, tariffs: { 1: 200 }, protocols: ['vless'], countries: ['nl'], platforms: ['ios'], payments: ['sbp'] }));
}
// A fresh established client who went to the bot (weight 1), voting at `ago` minutes back.
function vote(sid, value, network, ago = 10, trust = 1) {
  const id = ++uid;
  const keep = clock;
  at(T0 - 3 * DAY);
  upsertUser(db, { id, first_name: `U${id}` });
  db.run('INSERT INTO clicks (service_id, user_id, created_at) VALUES (?, ?, ?)', sid, id, T0 - 2 * DAY);
  db.run('UPDATE users SET trust_score = ? WHERE id = ?', trust, id);
  at(T0 - ago * MIN);
  const u = loadUser(db, id, []);
  recordVote(db, u, sid, value);
  if (network) db.run('UPDATE status_votes SET network = ? WHERE user_id = ?', network, id);
  at(keep);
}
const net = (r, id) => r.networks.find((n) => n.id === id);

beforeEach(() => {
  at(T0);
  db = openDb(':memory:');
  invalidate();
  uid = 1000;
  for (const id of [1, 2, 3, 4, 5]) service(id);
});

test('several VPNs failing on one network looks like the operator; others stay calm', () => {
  for (const sid of [1, 2, 3]) { vote(sid, 'down', 'mts', 20); vote(sid, 'down', 'mts', 5); }
  vote(4, 'up', 'mts', 30); vote(4, 'up', 'mts', 90); vote(5, 'up', 'mts', 300);
  vote(4, 'up', 'beeline', 15);
  const r = radar(db, { ts: T0, fresh: true });
  const mts = net(r, 'mts');
  assert.equal(mts.level, 'operator');
  assert.deepEqual(mts.reported.map((s) => s.id).sort(), [1, 2, 3]);
  // Where to switch on МТС: VPNs people there say work, best first.
  assert.deepEqual(mts.working.map((s) => [s.id, s.up]), [[4, 2], [5, 1]]);
  assert.equal(net(r, 'beeline').level, 'calm');
  assert.equal(mts.down, 6);
  assert.equal(mts.trend.reduce((a, b) => a + b, 0), 6);
});

test('weak or outweighed signals do not put a VPN on the radar', () => {
  vote(1, 'down', 'tele2', 10); // a single vote
  vote(2, 'down', 'tele2', 10, 0.3); vote(2, 'down', 'tele2', 8, 0.3); vote(2, 'down', 'tele2', 6, 0.3); // low trust: weight 0.9
  vote(3, 'down', 'tele2', 10); vote(3, 'down', 'tele2', 9); vote(3, 'up', 'tele2', 8); vote(3, 'up', 'tele2', 7); vote(3, 'up', 'tele2', 6); // works outweighs
  vote(4, 'down', 'megafon', 200); vote(4, 'down', 'megafon', 190); // outside the 2 h window
  const r = radar(db, { ts: T0, fresh: true });
  assert.equal(net(r, 'tele2').level, 'calm');
  assert.equal(net(r, 'megafon').level, 'calm');
  assert.equal(net(r, 'megafon').trend.reduce((a, b) => a + b, 0), 2); // still visible in the 12 h trend
});

test('official statuses are listed with the networks they are reported on', () => {
  for (let i = 0; i < 3; i++) vote(1, 'down', i < 2 ? 'beeline' : null, 30 - i);
  vote(2, 'down', 'beeline', 12); vote(2, 'down', 'beeline', 11);
  const r = radar(db, { ts: T0, fresh: true });
  assert.deepEqual(r.incidents.map((s) => [s.id, s.status, s.networks]), [[1, 'issues', ['beeline']]]);
  assert.equal(net(r, 'beeline').level, 'some');
  assert.equal(r.down, 5); // votes without a network count in the total too
});
