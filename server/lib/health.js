// Service health from client signals: «Работает у меня» / «Не работает у меня».
//
// Each vote has a base weight (1 after a click-through to the VPN's bot via Линза, 0.3
// otherwise) multiplied by the voter's trust_score, which drifts up or down as their past
// votes agree or disagree with the outcome. Over the last window (2 h by default):
//   issues — >= 3 counted "down" votes with weight >= 2 that outweigh "works";
//   outage — >= 8 "down" votes with weight >= 5 that outweigh "works".
// A failure status sticks until "works" outweighs again, or no new "down" vote arrives for
// 6 h. Every change is stored in status_changes; availability and the monthly top use it.
// All numbers live in settings.status_config.
import { now, DAY } from './time.js';
import { badRequest, forbidden, notFound, HttpError } from './http.js';
import { DEFAULT_SETTINGS } from '../db.js';
import { STATUS_CONFIG_FIELDS, NETWORK, HEALTH } from '../../public/js/dict.js';
import { enqueue, notifyAdmins } from './notify.js';
import { audit, html, canReview, ownedService } from './moderation.js';
import { invalidate } from './catalog.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const MSK = 3 * HOUR;
const LEVEL = { operational: 0, issues: 1, outage: 2 };
const BY_LEVEL = ['operational', 'issues', 'outage'];

/* ---------------- Settings ---------------- */

export function statusConfig(db) {
  return { ...DEFAULT_SETTINGS.status_config, ...(db.setting('status_config') || {}) };
}

export function validateStatusConfig(input) {
  const out = {};
  for (const [key, label, min, max] of STATUS_CONFIG_FIELDS) {
    const v = Number(input?.[key]);
    if (!Number.isFinite(v) || v < min || v > max) throw badRequest(`«${label}»: число от ${min} до ${max}`);
    out[key] = v;
  }
  if (out.trust_min > out.trust_max) throw badRequest('Минимум доверия больше максимума');
  if (out.outage_votes < out.issues_votes) throw badRequest('Порог «Массового сбоя» не может быть ниже порога «Сообщений о сбоях»');
  return out;
}

/* ---------------- Notifications ---------------- */

export { notifyAdmins }; // lives in notify.js; re-exported for existing imports

const networksText = (byNet) => Object.entries(byNet).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${NETWORK[n]?.name || n} — ${c}`).join(', ');

/* ---------------- Current status ---------------- */

export function statusRow(db, serviceId) {
  return db.get('SELECT * FROM service_status WHERE service_id = ?', serviceId)
    || { service_id: serviceId, status: 'operational', since: null, cleared_at: null, confirmed_by: null, confirmed_at: null };
}

// Counted votes for a service since `from`, with their effective weight.
function countedVotes(db, serviceId, from) {
  return db.all(
    `SELECT v.user_id, v.value, v.network, v.created_at, v.base_weight, u.trust_score, v.base_weight * u.trust_score weight
     FROM status_votes v JOIN users u ON u.id = v.user_id
     WHERE v.service_id = ? AND v.excluded IS NULL AND u.is_blocked = 0 AND v.created_at > ?`, serviceId, from);
}

export function windowStats(db, serviceId, ts = now()) {
  const cfg = statusConfig(db);
  const row = statusRow(db, serviceId);
  const votes = countedVotes(db, serviceId, Math.max(ts - cfg.window_min * MIN, row.cleared_at || 0));
  const s = { up_n: 0, up_w: 0, down_n: 0, down_w: 0, down_networks: {} };
  for (const v of votes) {
    if (v.value) { s.up_n++; s.up_w += v.weight; } else {
      s.down_n++; s.down_w += v.weight;
      if (v.network) s.down_networks[v.network] = (s.down_networks[v.network] || 0) + 1;
    }
  }
  s.up_w = Math.round(s.up_w * 100) / 100;
  s.down_w = Math.round(s.down_w * 100) / 100;
  return s;
}

function writeStatus(db, serviceId, status, ts, reason, adminId = null, extra = {}) {
  const row = statusRow(db, serviceId);
  db.run(
    `INSERT INTO service_status (service_id, status, since, cleared_at, confirmed_by, confirmed_at, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, ?)
     ON CONFLICT(service_id) DO UPDATE SET status = excluded.status, since = excluded.since,
       cleared_at = COALESCE(excluded.cleared_at, service_status.cleared_at), confirmed_by = NULL, confirmed_at = NULL, updated_at = excluded.updated_at`,
    serviceId, status, ts, extra.cleared_at ?? null, ts);
  if (row.status !== status) db.run('INSERT INTO status_changes (service_id, status, changed_at, reason, admin_id) VALUES (?, ?, ?, ?, ?)', serviceId, status, ts, reason, adminId);
  invalidate();
}

export function recomputeStatus(db, serviceId, { ts = now() } = {}) {
  const cfg = statusConfig(db);
  const row = statusRow(db, serviceId);
  const s = windowStats(db, serviceId, ts);
  const lastDown = db.get(
    `SELECT MAX(v.created_at) t FROM status_votes v JOIN users u ON u.id = v.user_id
     WHERE v.service_id = ? AND v.value = 0 AND v.excluded IS NULL AND u.is_blocked = 0 AND v.created_at > ?`, serviceId, row.cleared_at || 0).t;

  let level = 0;
  if (s.down_w > s.up_w) {
    if (s.down_n >= cfg.outage_votes && s.down_w >= cfg.outage_weight) level = 2;
    else if (s.down_n >= cfg.issues_votes && s.down_w >= cfg.issues_weight) level = 1;
  }
  const cur = LEVEL[row.status];
  let next = level;
  let reason = 'votes';
  if (level === 0 && cur > 0) {
    // Failure statuses stick until "works" outweighs again or "down" votes stop for a while.
    const recovered = s.up_w > s.down_w && s.up_w > 0;
    const quiet = !lastDown || ts - lastDown >= cfg.clear_after_min * MIN;
    next = recovered || quiet ? 0 : cur;
    reason = recovered ? 'recovered' : 'timeout';
  } else if (level > 0) {
    next = Math.max(level, cur);
  }
  if (next === cur) return { status: row.status, changed: false, stats: s };

  const status = BY_LEVEL[next];
  db.tx(() => {
    writeStatus(db, serviceId, status, ts, reason);
    if (next > cur) {
      const svc = db.get('SELECT owner_id, name FROM services WHERE id = ?', serviceId);
      if (svc?.owner_id) {
        const nets = networksText(s.down_networks);
        enqueue(db, svc.owner_id, 'moderation',
          `⚠️ У «${html(svc.name)}» статус «${HEALTH[status].name}».\n\nЗа ${Math.round(cfg.window_min / 60 * 10) / 10} ч: ${s.down_n} ${plural(s.down_n, 'сигнал', 'сигнала', 'сигналов')} о сбоях, ${s.up_n} — что работает.` +
          (nets ? `\nПо сетям: ${nets}.` : '') + '\n\nЕсли это ошибка, оспорьте статус в кабинете — администратор проверит.', `owner_${serviceId}`);
      }
    }
  });
  return { status, changed: true, stats: s };
}

const plural = (n, a, b, c) => { const m10 = n % 10, m100 = n % 100; if (m10 === 1 && m100 !== 11) return a; if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return b; return c; };

// Background job: failure statuses can only end by a timer when nobody votes.
export function recomputeActive(db, opts = {}) {
  const ids = db.all("SELECT service_id FROM service_status WHERE status != 'operational'").map((r) => r.service_id);
  let changed = 0;
  for (const id of ids) if (recomputeStatus(db, id, opts).changed) changed++;
  return changed;
}

/* ---------------- Voting ---------------- */

export function recordVote(db, user, serviceId, value, { envAdmins = [], ts = now() } = {}) {
  if (value !== 'up' && value !== 'down') throw badRequest('Неверный голос');
  const svc = db.get("SELECT id, owner_id FROM services WHERE id = ? AND status = 'published' AND hidden = 0", serviceId);
  if (!svc) throw notFound('VPN не найден');
  const cfg = statusConfig(db);
  const v = value === 'up' ? 1 : 0;
  const existing = db.get('SELECT * FROM status_votes WHERE user_id = ? AND service_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1',
    user.id, serviceId, ts - cfg.cooldown_h * HOUR);
  if (!existing) {
    const services = db.get('SELECT COUNT(DISTINCT service_id) n FROM status_votes WHERE user_id = ? AND created_at > ? AND service_id != ?', user.id, ts - DAY, serviceId).n;
    if (services >= cfg.daily_services) throw new HttpError(429, `За сутки можно отметить не больше ${cfg.daily_services} ${plural(cfg.daily_services, 'сервиса', 'сервисов', 'сервисов')}`, 'rate_limited');
  }
  // Invisible to the voter: weights and exclusions only change how much a vote counts.
  const base = canReview(db, user.id, serviceId) ? cfg.weight_clicked : cfg.weight_other;
  const owner = db.get('SELECT 1 FROM services WHERE owner_id = ? LIMIT 1', user.id);
  const excluded = ts - user.created_at < cfg.new_account_h * HOUR ? 'new_account' : owner ? 'owner' : null;

  let id;
  db.tx(() => {
    if (existing && existing.value === v) {
      // Same opinion again: nothing new, so the vote's time is not refreshed
      // (re-tapping must not keep an incident alive).
      id = existing.id;
    } else if (existing) {
      db.run('UPDATE status_votes SET value = ?, network = NULL, base_weight = ?, excluded = ?, created_at = ?, trust_checked_at = NULL WHERE id = ?',
        v, base, excluded, ts, existing.id);
      id = existing.id;
    } else {
      id = Number(db.run('INSERT INTO status_votes (user_id, service_id, value, base_weight, excluded, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        user.id, serviceId, v, base, excluded, ts).lastInsertRowid);
    }
  });
  recomputeStatus(db, serviceId, { ts });
  detectAnomalies(db, serviceId, { envAdmins, ts });
  return { id, repeated: Boolean(existing && existing.value === v) };
}

export function setVoteNetwork(db, user, serviceId, network) {
  if (network !== null && !NETWORK[network]) throw badRequest('Неизвестная сеть');
  const cfg = statusConfig(db);
  const r = db.run(
    `UPDATE status_votes SET network = ? WHERE id = (SELECT id FROM status_votes WHERE user_id = ? AND service_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1)`,
    network, user.id, serviceId, now() - cfg.cooldown_h * HOUR);
  if (!r.changes) throw notFound('Сначала отметьте, работает ли VPN');
}

/* ---------------- Trust ---------------- */

// Background job: a vote is compared with the majority of other counted votes around it
// once trust_delay_min has passed. Agreeing raises the voter's trust, disagreeing lowers it.
export function evaluateTrust(db, { ts = now() } = {}) {
  const cfg = statusConfig(db);
  const due = db.all(
    `SELECT * FROM status_votes WHERE trust_checked_at IS NULL AND (excluded IS NULL OR excluded = 'new_account') AND created_at <= ? ORDER BY created_at LIMIT 500`,
    ts - cfg.trust_delay_min * MIN);
  let updated = 0;
  for (const vote of due) {
    const w = cfg.window_min * MIN;
    const others = db.all(
      `SELECT v.value, v.base_weight * u.trust_score weight FROM status_votes v JOIN users u ON u.id = v.user_id
       WHERE v.service_id = ? AND v.user_id != ? AND v.excluded IS NULL AND u.is_blocked = 0 AND v.created_at BETWEEN ? AND ?`,
      vote.service_id, vote.user_id, vote.created_at - w, vote.created_at + w);
    const up = others.filter((o) => o.value).reduce((a, o) => a + o.weight, 0);
    const down = others.filter((o) => !o.value).reduce((a, o) => a + o.weight, 0);
    db.tx(() => {
      if (up + down >= cfg.trust_quorum && up !== down) {
        const majority = up > down ? 1 : 0;
        const delta = vote.value === majority ? cfg.trust_up : -cfg.trust_down;
        db.run('UPDATE users SET trust_score = MIN(?, MAX(?, trust_score + ?)) WHERE id = ?', cfg.trust_max, cfg.trust_min, delta, vote.user_id);
        updated++;
      }
      db.run('UPDATE status_votes SET trust_checked_at = ? WHERE id = ?', ts, vote.id);
    });
  }
  return updated;
}

/* ---------------- Anomalies & disputes ---------------- */

function raiseAnomaly(db, serviceId, kind, details, text, envAdmins, ts) {
  const cfg = statusConfig(db);
  const recent = db.get("SELECT 1 FROM status_anomalies WHERE service_id = ? AND kind = ? AND (state = 'open' OR created_at > ?)", serviceId, kind, ts - cfg.window_min * MIN);
  if (recent) return false;
  db.run('INSERT INTO status_anomalies (service_id, kind, details, created_at) VALUES (?, ?, ?, ?)', serviceId, kind, JSON.stringify(details), ts);
  notifyAdmins(db, envAdmins, text);
  return true;
}

export function detectAnomalies(db, serviceId, { envAdmins = [], ts = now() } = {}) {
  const cfg = statusConfig(db);
  const name = db.get('SELECT name FROM services WHERE id = ?', serviceId)?.name || `#${serviceId}`;
  const row = statusRow(db, serviceId);
  const down = countedVotes(db, serviceId, Math.max(ts - cfg.window_min * MIN, row.cleared_at || 0)).filter((v) => !v.value);
  const low = down.filter((v) => v.trust_score < cfg.anomaly_trust).length;
  if (down.length >= cfg.issues_votes && low / down.length > cfg.anomaly_share) {
    raiseAnomaly(db, serviceId, 'low_trust', { down: down.length, low },
      `🚨 Аномалия у «${html(name)}»: ${low} из ${down.length} сигналов о сбоях за окно — от аккаунтов с низким доверием. Проверьте статус.`, envAdmins, ts);
  }
  // Every vote counts for a spike, including ones that are not counted for the status.
  const burst = db.get('SELECT COUNT(*) n FROM status_votes WHERE service_id = ? AND created_at > ?', serviceId, ts - cfg.spike_min * MIN).n;
  if (burst >= cfg.spike_votes) {
    raiseAnomaly(db, serviceId, 'spike', { votes: burst, minutes: cfg.spike_min },
      `🚨 Всплеск сигналов у «${html(name)}»: ${burst} ${plural(burst, 'голос', 'голоса', 'голосов')} за ${cfg.spike_min} мин. Возможна накрутка.`, envAdmins, ts);
  }
}

export function openDispute(db, owner, serviceId, comment, { envAdmins = [] } = {}) {
  const svc = ownedService(db, owner, serviceId);
  const row = statusRow(db, serviceId);
  if (row.status === 'operational') throw badRequest('Оспаривать нечего: у сервиса статус «Работает»');
  if (db.get("SELECT 1 FROM status_disputes WHERE service_id = ? AND state = 'open'", serviceId)) throw badRequest('Спор уже на рассмотрении');
  const text = typeof comment === 'string' ? comment.trim().slice(0, 500) : '';
  db.tx(() => {
    db.run('INSERT INTO status_disputes (service_id, owner_id, status, comment, created_at) VALUES (?, ?, ?, ?, ?)', serviceId, owner.id, row.status, text || null, now());
    notifyAdmins(db, envAdmins, `🛡 Владелец «${html(svc.name)}» оспорил статус «${HEALTH[row.status].name}».${text ? `\n\n«${html(text)}»` : ''}`);
  });
}

function resolveOpen(db, admin, serviceId, state) {
  const ts = now();
  const disputes = db.all("SELECT owner_id FROM status_disputes WHERE service_id = ? AND state = 'open'", serviceId);
  db.run("UPDATE status_disputes SET state = ?, resolved_by = ?, resolved_at = ? WHERE service_id = ? AND state = 'open'", state, admin.id, ts, serviceId);
  db.run("UPDATE status_anomalies SET state = ?, resolved_by = ?, resolved_at = ? WHERE service_id = ? AND state = 'open'", state, admin.id, ts, serviceId);
  return disputes;
}

// Admin: drop the status now. Votes cast before this moment stop counting, so the
// same signals cannot bring it straight back.
export function clearStatus(db, admin, serviceId, note = null) {
  const svc = db.get('SELECT id, name, owner_id FROM services WHERE id = ?', serviceId);
  if (!svc) throw notFound('Сервис не найден');
  return db.tx(() => {
    const ts = now();
    const was = statusRow(db, serviceId).status;
    writeStatus(db, serviceId, 'operational', ts, 'admin_clear', admin.id, { cleared_at: ts });
    const disputes = resolveOpen(db, admin, serviceId, 'cleared');
    audit(db, admin.id, 'status.clear', 'service', serviceId, { name: svc.name, was, note });
    if (svc.owner_id && was !== 'operational') {
      enqueue(db, svc.owner_id, 'moderation', `✅ Администратор снял статус «${HEALTH[was].name}» у «${html(svc.name)}».`, `owner_${serviceId}`);
    }
    return { disputes: disputes.length };
  });
}

export function confirmStatus(db, admin, serviceId) {
  const svc = db.get('SELECT id, name, owner_id FROM services WHERE id = ?', serviceId);
  if (!svc) throw notFound('Сервис не найден');
  return db.tx(() => {
    const row = statusRow(db, serviceId);
    if (row.status === 'operational') throw badRequest('Подтверждать нечего: статус «Работает»');
    db.run('UPDATE service_status SET confirmed_by = ?, confirmed_at = ? WHERE service_id = ?', admin.id, now(), serviceId);
    const disputes = resolveOpen(db, admin, serviceId, 'confirmed');
    audit(db, admin.id, 'status.confirm', 'service', serviceId, { name: svc.name, status: row.status });
    if (svc.owner_id && disputes.length) {
      enqueue(db, svc.owner_id, 'moderation', `ℹ️ Администратор проверил спор и подтвердил статус «${HEALTH[row.status].name}» у «${html(svc.name)}». Статус снимется сам, когда клиенты отметят, что всё работает.`, `owner_${serviceId}`);
    }
  });
}

// Admin looked at an anomaly and found the signals genuine: close it, keep the votes.
export function keepAnomaly(db, admin, anomalyId) {
  const a = db.get("SELECT a.id, a.service_id, a.kind, s.name FROM status_anomalies a JOIN services s ON s.id = a.service_id WHERE a.id = ? AND a.state = 'open'", anomalyId);
  if (!a) throw notFound('Аномалия не найдена или уже закрыта');
  db.tx(() => {
    db.run("UPDATE status_anomalies SET state = 'confirmed', resolved_by = ?, resolved_at = ? WHERE id = ?", admin.id, now(), a.id);
    audit(db, admin.id, 'status.anomaly_keep', 'service', a.service_id, { name: a.name, kind: a.kind });
  });
}

/* ---------------- Availability ---------------- */

// Failure intervals per service, clipped to [from, to], derived from status_changes.
export function incidentIntervals(db, from, to, serviceIds = null) {
  const filter = serviceIds ? `AND service_id IN (${serviceIds.map(Number).join(',') || 0})` : '';
  const rows = db.all(`SELECT service_id, status, changed_at FROM status_changes WHERE changed_at < ? ${filter} ORDER BY service_id, changed_at, id`, to);
  const out = new Map();
  let sid = null, cur = 'operational', start = 0;
  const close = (end) => {
    if (sid === null || cur === 'operational') return;
    const s = Math.max(start, from), e = Math.min(end, to);
    if (e > s) { if (!out.has(sid)) out.set(sid, []); out.get(sid).push({ status: cur, start: s, end: e }); }
  };
  for (const r of rows) {
    if (r.service_id !== sid) { close(to); sid = r.service_id; cur = 'operational'; start = 0; }
    if (r.status !== cur) { close(r.changed_at); cur = r.status; start = r.changed_at; }
  }
  close(to);
  return out;
}

export function uptimeShare(intervals = [], from, to) {
  if (to <= from) return 1;
  const down = intervals.reduce((sum, i) => sum + Math.max(0, Math.min(i.end, to) - Math.max(i.start, from)), 0);
  return Math.max(0, 1 - down / (to - from));
}

const dayStart = (ts) => Math.floor((ts + MSK) / DAY) * DAY - MSK;

// What the card shows: status, last signal, 30-day bar, network breakdown, my vote.
export function serviceHealth(db, serviceId, userId = null, ts = now()) {
  const cfg = statusConfig(db);
  const row = statusRow(db, serviceId);
  const svc = db.get('SELECT published_at FROM services WHERE id = ?', serviceId);
  const today = dayStart(ts);
  const from = today - 29 * DAY;
  const intervals = incidentIntervals(db, from, ts, [serviceId]).get(serviceId) || [];
  const days = [];
  for (let d = from; d <= today; d += DAY) {
    const end = Math.min(d + DAY, ts);
    let issues = 0, outage = 0;
    for (const i of intervals) {
      const o = Math.max(0, Math.min(i.end, end) - Math.max(i.start, d));
      if (i.status === 'outage') outage += o; else issues += o;
    }
    days.push({ day: d, issues_min: Math.round(issues / MIN), outage_min: Math.round(outage / MIN), nodata: Boolean(svc?.published_at && d + DAY <= svc.published_at) });
  }
  const spanFrom = Math.max(from, svc?.published_at || from);

  const nets = db.all(
    `SELECT v.network, SUM(v.value = 1) up, SUM(v.value = 0) down FROM status_votes v JOIN users u ON u.id = v.user_id
     WHERE v.service_id = ? AND v.excluded IS NULL AND u.is_blocked = 0 AND v.network IS NOT NULL AND v.created_at > ? GROUP BY v.network`,
    serviceId, ts - cfg.networks_h * HOUR);
  const netVotes = nets.reduce((a, n) => a + n.up + n.down, 0);
  const mine = userId ? db.get('SELECT value, network, created_at FROM status_votes WHERE user_id = ? AND service_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1',
    userId, serviceId, ts - cfg.cooldown_h * HOUR) : null;

  return {
    status: row.status,
    since: row.since,
    confirmed_at: row.confirmed_at,
    last_signal_at: db.get('SELECT MAX(created_at) t FROM status_votes WHERE service_id = ? AND excluded IS NULL', serviceId).t,
    uptime30: Math.round(uptimeShare(intervals, spanFrom, ts) * 10000) / 100,
    days,
    networks: netVotes >= cfg.networks_min_votes ? { hours: cfg.networks_h, items: nets.sort((a, b) => b.up + b.down - a.up - a.down) } : null,
    my_vote: mine ? { value: mine.value ? 'up' : 'down', network: mine.network, created_at: mine.created_at } : null
  };
}
