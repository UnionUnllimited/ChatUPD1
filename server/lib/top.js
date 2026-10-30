import { now, periodRange } from './time.js';
import { badRequest } from './http.js';
import { invalidate } from './catalog.js';
import { audit } from './moderation.js';
import { notifyEveryone } from './notify.js';
import { monthLabel } from '../../public/js/dict.js';

export const TOP_SIZE = 10;

export function normalizeWeights(w) {
  const out = {};
  for (const k of ['rating', 'clients', 'stability']) {
    const v = Number(w?.[k]);
    if (!Number.isFinite(v) || v < 0 || v > 1) throw badRequest('Веса — числа от 0 до 1');
    out[k] = v;
  }
  const sum = out.rating + out.clients + out.stability;
  if (sum <= 0) throw badRequest('Хотя бы один вес должен быть больше нуля');
  for (const k in out) out[k] = Math.round((out[k] / sum) * 1000) / 1000;
  return out;
}

// Composite score for a month (all components in 0..1, score in 0..100):
//   rating    — Bayesian-smoothed average of approved reviews written that month, / 5
//   clients   — unique Telegram users who went to the bot that month, / best in catalog
//   stability — share of passed manual checks that month
export function computeTop(db, period, weights = db.setting('top_weights')) {
  const [start, end] = periodRange(period);
  const prior = db.setting('top_rating_prior');
  const services = db.all(
    "SELECT id, name, logo_url FROM services WHERE status = 'published' AND hidden = 0 AND published_at < ?", end);
  const map = (sql) => new Map(db.all(sql, start, end).map((r) => [r.service_id, r]));
  const ratings = map("SELECT service_id, AVG(rating) avg, COUNT(*) n FROM reviews WHERE status = 'approved' AND created_at >= ? AND created_at < ? GROUP BY service_id");
  const clients = map('SELECT service_id, COUNT(DISTINCT user_id) n FROM clicks WHERE created_at >= ? AND created_at < ? GROUP BY service_id');
  const checks = map('SELECT service_id, SUM(passed) passed, COUNT(*) n FROM service_checks WHERE checked_at >= ? AND checked_at < ? GROUP BY service_id');

  const rated = [...ratings.values()];
  const mean = rated.length ? rated.reduce((s, r) => s + r.avg * r.n, 0) / rated.reduce((s, r) => s + r.n, 0) : 4;
  const maxClients = Math.max(1, ...[...clients.values()].map((c) => c.n));

  const rows = services.map((s) => {
    const r = ratings.get(s.id);
    const c = clients.get(s.id);
    const k = checks.get(s.id);
    const ratingComp = r ? (r.avg * r.n + mean * prior) / (r.n + prior) / 5 : 0;
    const clientsComp = c ? c.n / maxClients : 0;
    const stabilityComp = k ? k.passed / k.n : 0;
    const score = 100 * (weights.rating * ratingComp + weights.clients * clientsComp + weights.stability * stabilityComp);
    return {
      service_id: s.id,
      name: s.name,
      logo_url: s.logo_url,
      score: Math.round(score * 10) / 10,
      components: {
        rating: Math.round(ratingComp * 1000) / 1000,
        rating_avg: r ? Math.round(r.avg * 100) / 100 : null,
        rating_n: r ? r.n : 0,
        clients: Math.round(clientsComp * 1000) / 1000,
        clients_n: c ? c.n : 0,
        stability: Math.round(stabilityComp * 1000) / 1000,
        checks_passed: k ? k.passed : 0,
        checks_n: k ? k.n : 0
      }
    };
  });
  rows.sort((a, b) => b.score - a.score || b.components.clients_n - a.components.clients_n || a.service_id - b.service_id);
  rows.forEach((r, i) => { r.rank = i + 1; });
  return { period, weights, rows };
}

export function publishTop(db, period, adminId = null) {
  return db.tx(() => {
    const { rows, weights } = computeTop(db, period);
    const winners = rows.filter((r) => r.score > 0).slice(0, TOP_SIZE);
    if (!winners.length) throw badRequest('За этот месяц нет данных для рейтинга');
    const republish = Boolean(db.get('SELECT 1 FROM top_snapshots WHERE period = ?', period));
    db.run('DELETE FROM top_snapshots WHERE period = ?', period);
    db.run('INSERT INTO top_snapshots (period, weights, published_at, published_by) VALUES (?, ?, ?, ?)', period, JSON.stringify(weights), now(), adminId);
    for (const w of winners) {
      db.run('INSERT INTO top_entries (period, rank, service_id, score, components) VALUES (?, ?, ?, ?, ?)',
        period, w.rank, w.service_id, w.score, JSON.stringify(w.components));
    }
    audit(db, adminId, republish ? 'top.republish' : 'top.publish', 'top', null, { period, weights, winners: winners.map((w) => w.service_id) });
    if (!republish) {
      notifyEveryone(db, 'top', `🏆 Опубликован топ-10 VPN за ${monthLabel(period)}. Первое место — <b>${winners[0].name.replace(/[&<>]/g, '')}</b>.`, 'top');
    }
    invalidate();
    return winners;
  });
}

export function topFor(db, period) {
  const snap = db.get('SELECT * FROM top_snapshots WHERE period = ?', period);
  if (!snap) return null;
  const entries = db.all(
    `SELECT e.rank, e.score, e.components, e.service_id, s.name, s.logo_url, s.hidden, s.status
     FROM top_entries e JOIN services s ON s.id = e.service_id WHERE e.period = ? ORDER BY e.rank`, period)
    .map((e) => ({ ...e, components: JSON.parse(e.components), available: e.status === 'published' && !e.hidden }));
  return { period, published_at: snap.published_at, weights: JSON.parse(snap.weights), entries };
}

export function latestTop(db) {
  const row = db.get('SELECT MAX(period) period FROM top_snapshots');
  return row?.period ? topFor(db, row.period) : null;
}

export function topArchive(db) {
  return db.all('SELECT period, published_at FROM top_snapshots ORDER BY period DESC').map((s) => ({
    ...s,
    leaders: db.all('SELECT s.name FROM top_entries e JOIN services s ON s.id = e.service_id WHERE e.period = ? ORDER BY e.rank LIMIT 3', s.period).map((r) => r.name)
  }));
}
