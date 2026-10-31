// «Радар сбоев» — Downdetector for VPN: client signals grouped by mobile network, so a person can
// tell "is it me or everyone" and see which VPNs work on their network right now.
// Built from the same counted votes as statuses (weights, trust, exclusions, admin clears).
import { NETWORKS } from '../../public/js/dict.js';
import { statusConfig } from './health.js';
import { now } from './time.js';

const MIN = 60_000, HOUR = 60 * MIN;
const TREND_HOURS = 12;
let cache = null;

export function radar(db, { ts = now(), fresh = false } = {}) {
  // Many people open the radar at once during an outage; half a minute of staleness is fine.
  if (!fresh && cache && ts - cache.ts < 30_000) return cache.data;
  const cfg = statusConfig(db);
  const winFrom = ts - cfg.radar_window_min * MIN;
  const dayFrom = ts - Math.max(cfg.networks_h, TREND_HOURS) * HOUR;
  const votes = db.all(
    `SELECT v.service_id, v.value, v.network, v.created_at, v.base_weight * u.trust_score w
     FROM status_votes v JOIN users u ON u.id = v.user_id
     JOIN services s ON s.id = v.service_id AND s.status = 'published' AND s.hidden = 0
     LEFT JOIN service_status st ON st.service_id = v.service_id
     WHERE v.excluded IS NULL AND u.is_blocked = 0 AND v.created_at > ? AND v.created_at > COALESCE(st.cleared_at, 0)`, dayFrom);
  const services = new Map(db.all(
    `SELECT s.id, s.name, s.logo_url, s.bot_url, s.min_monthly, COALESCE(st.status, 'operational') status
     FROM services s LEFT JOIN service_status st ON st.service_id = s.id WHERE s.status = 'published' AND s.hidden = 0`).map((s) => [s.id, s]));

  const hourStart = Math.floor(ts / HOUR) * HOUR;
  const bucket = (t) => TREND_HOURS - 1 - Math.floor((hourStart - Math.floor(t / HOUR) * HOUR) / HOUR);
  const emptyTrend = () => Array.from({ length: TREND_HOURS }, (_, i) => ({ at: hourStart - (TREND_HOURS - 1 - i) * HOUR, down: 0 }));
  const trend = emptyTrend();

  const nets = new Map(NETWORKS.map((n) => [n.id, { id: n.id, name: n.name, cells: new Map(), works: new Map(), trend: emptyTrend(), down: 0 }]));
  let down = 0;
  for (const v of votes) {
    const i = bucket(v.created_at);
    if (!v.value && i >= 0) trend[i].down++;
    const net = v.network ? nets.get(v.network) : null;
    if (net && !v.value && i >= 0) net.trend[i].down++;
    if (!net) { if (!v.value && v.created_at > winFrom) down++; continue; }
    if (v.value) net.works.set(v.service_id, (net.works.get(v.service_id) || 0) + 1);
    if (v.created_at <= winFrom) continue;
    if (!v.value) { down++; net.down++; }
    const c = net.cells.get(v.service_id) || { up: 0, down: 0, up_w: 0, down_w: 0 };
    if (v.value) { c.up++; c.up_w += v.w; } else { c.down++; c.down_w += v.w; }
    net.cells.set(v.service_id, c);
  }

  const card = (id) => { const s = services.get(id); return s && { id: s.id, name: s.name, logo_url: s.logo_url, bot_url: s.bot_url, min_monthly: s.min_monthly, status: s.status }; };
  const networks = [...nets.values()].map((n) => {
    const reported = [...n.cells.entries()]
      .filter(([, c]) => c.down >= cfg.radar_min_votes && c.down_w >= cfg.radar_min_weight && c.down_w > c.up_w)
      .map(([id, c]) => ({ ...card(id), down: c.down, up: c.up }))
      .filter((s) => s.id)
      .sort((a, b) => b.down - a.down);
    const bad = new Set(reported.map((s) => s.id));
    // Where to switch: VPNs people on this network say work, that have no failure status now.
    const working = [...n.works.entries()]
      .filter(([id]) => !bad.has(id) && services.get(id)?.status === 'operational')
      .map(([id, up]) => ({ ...card(id), up }))
      .filter((s) => s.id)
      .sort((a, b) => b.up - a.up)
      .slice(0, 5);
    const level = !reported.length ? 'calm' : reported.length >= cfg.radar_operator ? 'operator' : 'some';
    return { id: n.id, name: n.name, level, reported, working, down: n.down, trend: n.trend.map((t) => t.down) };
  });

  // Official statuses (issues / outage) — the list a person checks for "their" VPN.
  const incidents = [...services.values()].filter((s) => s.status !== 'operational').map((s) => ({
    ...card(s.id), networks: networks.filter((n) => n.reported.some((r) => r.id === s.id)).map((n) => n.id)
  })).sort((a, b) => (b.status === 'outage') - (a.status === 'outage'));

  const data = {
    window_min: cfg.radar_window_min,
    networks,
    incidents,
    trend,
    down,
    updated_at: ts
  };
  cache = { ts, data };
  return data;
}

// Compact form for the home screen block.
export function radarSummary(db) {
  const r = radar(db);
  return {
    networks: r.networks.map((n) => ({ id: n.id, name: n.name, level: n.level, count: n.reported.length })),
    incidents: r.incidents.length
  };
}

export const resetRadarCache = () => { cache = null; };
