import { now, DAY } from './time.js';

// The catalog is small (tens to low thousands of cards), so the published set is
// assembled once into memory and filtered in JS. Writes call invalidate().
const TTL = 60_000;
let cache = null;

export function invalidate() { cache = null; }

const parse = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };

export function monthlyOf(tariffs) {
  const entries = Object.entries(tariffs).map(([m, p]) => [Number(m), p]).sort((a, b) => a[0] - b[0]);
  if (!entries.length) return { min: null, base: null };
  const monthly = entries.map(([m, p]) => Math.round(p / m));
  return { min: Math.min(...monthly), base: monthly[0] };
}

export function tariffsOf(db, serviceId) {
  return Object.fromEntries(db.all('SELECT months, price FROM tariffs WHERE service_id = ? ORDER BY months', serviceId).map((t) => [t.months, t.price]));
}

// Published row -> the same shape owners submit, so revisions can be diffed field by field.
export function rowToCard(row, tariffs) {
  return {
    name: row.name,
    description: row.description,
    logo: row.logo_url,
    bot_url: row.bot_url,
    channel_url: row.channel_url,
    support_contact: row.support_contact,
    tariffs,
    devices: row.devices,
    protocols: parse(row.protocols),
    countries: parse(row.countries),
    platforms: parse(row.platforms),
    payments: parse(row.payments),
    whitelist_bypass: Boolean(row.whitelist_bypass),
    whitelist_note: row.whitelist_note,
    trial: Boolean(row.trial),
    trial_days: row.trial_days,
    trial_terms: row.trial_terms
  };
}

export function marketLabel(baseMonthly, avg, band) {
  if (!avg || !baseMonthly) return null;
  if (baseMonthly < avg * (1 - band)) return 'below';
  if (baseMonthly > avg * (1 + band)) return 'above';
  return 'market';
}

// Recomputed on every publication of tariffs (and when cards are hidden/shown).
export function recomputeMarketAverage(db) {
  const row = db.get("SELECT AVG(base_monthly) avg, COUNT(*) n FROM services WHERE status = 'published' AND hidden = 0 AND base_monthly IS NOT NULL");
  const avg = row.n ? Math.round(row.avg) : null;
  db.setSetting('market_avg_monthly', avg);
  invalidate();
  return avg;
}

function build(db) {
  const ts = now();
  const rows = db.all("SELECT * FROM services WHERE status = 'published' AND hidden = 0");
  const ids = new Set(rows.map((r) => r.id));
  const tariffs = new Map();
  for (const t of db.all('SELECT service_id, months, price FROM tariffs ORDER BY months')) {
    if (!ids.has(t.service_id)) continue;
    if (!tariffs.has(t.service_id)) tariffs.set(t.service_id, {});
    tariffs.get(t.service_id)[t.months] = t.price;
  }
  const map = (sql, ...p) => new Map(db.all(sql, ...p).map((r) => [r.service_id, r]));
  const ratings = map("SELECT service_id, AVG(rating) avg, COUNT(*) n FROM reviews WHERE status = 'approved' GROUP BY service_id");
  const popularity = map('SELECT service_id, COUNT(DISTINCT user_id) n FROM clicks WHERE created_at >= ? GROUP BY service_id', ts - 30 * DAY);
  const checks = map('SELECT service_id, MAX(checked_at) at FROM service_checks WHERE passed = 1 GROUP BY service_id');
  const health = map('SELECT service_id, status FROM service_status');
  const promos = map(
    `SELECT service_id, id, title, description, discount_percent, promo_code, starts_at, ends_at FROM promotions
     WHERE status = 'approved' AND starts_at <= ? AND ends_at > ? ORDER BY ends_at DESC`, ts, ts);
  // Most recent monthly top each service made it into -> "Топ-10 за <месяц>" badge.
  const tops = map(
    `SELECT e.service_id, e.period, e.rank FROM top_entries e
     JOIN (SELECT service_id, MAX(period) period FROM top_entries GROUP BY service_id) last
       ON last.service_id = e.service_id AND last.period = e.period`);

  const avg = db.setting('market_avg_monthly');
  const band = db.setting('market_band');
  const allRatings = [...ratings.values()];
  const globalMean = allRatings.length ? allRatings.reduce((s, r) => s + r.avg * r.n, 0) / allRatings.reduce((s, r) => s + r.n, 0) : 4;

  const items = rows.map((r) => {
    const t = tariffs.get(r.id) || {};
    const rating = ratings.get(r.id);
    const card = rowToCard(r, t);
    const promo = promos.get(r.id);
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      logo_url: r.logo_url,
      bot_url: r.bot_url,
      channel_url: r.channel_url,
      support_contact: r.support_contact,
      tariffs: t,
      min_monthly: r.min_monthly,
      base_monthly: r.base_monthly,
      market: marketLabel(r.base_monthly, avg, band),
      rating: rating ? Math.round(rating.avg * 10) / 10 : null,
      reviews: rating ? rating.n : 0,
      // Bayesian average for sorting, so a single 5★ review does not jump to the top.
      rating_rank: rating ? (rating.avg * rating.n + globalMean * 5) / (rating.n + 5) : 0,
      popularity: popularity.get(r.id)?.n || 0,
      verified_at: checks.get(r.id)?.at || null,
      health: health.get(r.id)?.status || 'operational',
      promo: promo ? { id: promo.id, title: promo.title, description: promo.description, discount_percent: promo.discount_percent, promo_code: promo.promo_code, ends_at: promo.ends_at } : null,
      top: tops.get(r.id) ? { period: tops.get(r.id).period, rank: tops.get(r.id).rank } : null,
      devices: card.devices,
      protocols: card.protocols,
      countries: card.countries,
      platforms: card.platforms,
      payments: card.payments,
      whitelist_bypass: card.whitelist_bypass,
      whitelist_note: card.whitelist_note,
      trial: card.trial,
      trial_days: card.trial_days,
      trial_terms: card.trial_terms,
      published_at: r.published_at,
      updated_at: r.updated_at
    };
  });
  return { at: ts, items, byId: new Map(items.map((i) => [i.id, i])), avg };
}

export function snapshot(db) {
  if (!cache || now() - cache.at > TTL) cache = build(db);
  return cache;
}

const csv = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);
const num = (v) => (v === undefined || v === '' || v === null ? null : Number.isFinite(Number(v)) ? Number(v) : null);

export function parseFilters(q) {
  return {
    q: (q.q || '').trim().slice(0, 60),
    priceMin: num(q.price_min),
    priceMax: num(q.price_max),
    trial: q.trial === '1',
    protocols: csv(q.protocols),
    countries: csv(q.countries),
    devices: num(q.devices),
    payments: csv(q.payments),
    platforms: csv(q.platforms),
    whitelist: q.whitelist === '1',
    belowMarket: q.below_market === '1',
    promo: q.promo === '1',
    sort: ['price', 'rating', 'popular', 'new'].includes(q.sort) ? q.sort : 'rating'
  };
}

export function filterItems(items, f) {
  const q = f.q.toLocaleLowerCase('ru');
  const list = items.filter((s) => {
    if (q && !s.name.toLocaleLowerCase('ru').includes(q)) return false;
    if (f.priceMin !== null && s.min_monthly < f.priceMin) return false;
    if (f.priceMax !== null && s.min_monthly > f.priceMax) return false;
    if (f.trial && !s.trial) return false;
    if (f.whitelist && !s.whitelist_bypass) return false;
    if (f.belowMarket && s.market !== 'below') return false;
    if (f.promo && !s.promo) return false;
    if (f.devices !== null && s.devices < f.devices) return false;
    // Within a group: any of the chosen values matches, except platforms,
    // where the VPN has to cover every device the client picked.
    if (f.protocols.length && !f.protocols.some((p) => s.protocols.includes(p))) return false;
    if (f.countries.length && !f.countries.some((c) => s.countries.includes(c))) return false;
    if (f.payments.length && !f.payments.some((p) => s.payments.includes(p))) return false;
    if (f.platforms.length && !f.platforms.every((p) => s.platforms.includes(p))) return false;
    return true;
  });
  const sorters = {
    price: (a, b) => a.min_monthly - b.min_monthly || b.rating_rank - a.rating_rank,
    rating: (a, b) => b.rating_rank - a.rating_rank || b.reviews - a.reviews,
    popular: (a, b) => b.popularity - a.popularity || b.rating_rank - a.rating_rank,
    new: (a, b) => b.published_at - a.published_at
  };
  return list.sort(sorters[f.sort]);
}

// Compact list item: the full card is fetched separately when opened.
export function toListItem(s) {
  const { channel_url, support_contact, whitelist_note, trial_terms, rating_rank, description, ...rest } = s;
  return { ...rest, description: description.length > 140 ? description.slice(0, 137) + '…' : description };
}
