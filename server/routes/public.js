import { snapshot, parseFilters, filterItems, toListItem } from '../lib/catalog.js';
import { latestTop, topFor, topArchive } from '../lib/top.js';
import { canReview } from '../lib/moderation.js';
import { serviceHealth } from '../lib/health.js';
import { notFound, intParam, badRequest } from '../lib/http.js';
import { isPeriod, now } from '../lib/time.js';

// Placements are a separate list labelled "Реклама"; they are never mixed into rankings.
function sponsored(db, placement) {
  const ts = now();
  return db.all('SELECT id, placement, service_id, title, image_url, url FROM ad_placements WHERE placement = ? AND starts_at <= ? AND ends_at > ?', placement, ts, ts);
}

function withTopItems(snap, top) {
  if (!top) return null;
  return { ...top, entries: top.entries.filter((e) => e.available).map((e) => ({ rank: e.rank, score: e.score, components: e.components, service: snap.byId.get(e.service_id) ? toListItem(snap.byId.get(e.service_id)) : null })).filter((e) => e.service) };
}

export function publicRoutes(r, { db }) {
  r.get('/api/home', () => {
    const snap = snapshot(db);
    const promos = snap.items.filter((s) => s.promo).sort((a, b) => a.promo.ends_at - b.promo.ends_at).map(toListItem);
    const count = (fn) => snap.items.filter(fn).length;
    return {
      top: withTopItems(snap, latestTop(db)),
      promos,
      market_avg: snap.avg,
      total: snap.items.length,
      quick: { cheap: count((s) => s.market === 'below'), trial: count((s) => s.trial), card_ru: count((s) => s.payments.includes('card_ru')) },
      sponsored: sponsored(db, 'home_banner')
    };
  });

  r.get('/api/catalog', ({ query }) => {
    const snap = snapshot(db);
    const f = parseFilters(query);
    const items = filterItems(snap.items, f);
    const prices = snap.items.map((s) => s.min_monthly).filter(Boolean);
    return {
      items: items.map(toListItem),
      total: snap.items.length,
      market_avg: snap.avg,
      price_range: prices.length ? [Math.min(...prices), Math.max(...prices)] : [0, 0],
      sponsored: sponsored(db, 'catalog_top')
    };
  });

  r.get('/api/services/:id', ({ params, user }) => {
    const id = intParam(params.id);
    const s = snapshot(db).byId.get(id);
    if (!s) throw notFound('VPN не найден или скрыт');
    const { rating_rank, ...card } = s;
    const lastChecks = db.all('SELECT passed, checked_at FROM service_checks WHERE service_id = ? ORDER BY checked_at DESC LIMIT 10', id);
    const me = user ? {
      favorite: Boolean(db.get('SELECT 1 FROM favorites WHERE user_id = ? AND service_id = ?', user.id, id)),
      can_review: canReview(db, user.id, id),
      review: db.get('SELECT id, rating, text, status, reject_reason, updated_at FROM reviews WHERE user_id = ? AND service_id = ?', user.id, id) || null
    } : null;
    return { ...card, checks: lastChecks, me, health: serviceHealth(db, id, user?.id ?? null) };
  });

  r.get('/api/services/:id/reviews', ({ params, query }) => {
    const id = intParam(params.id);
    const offset = Math.max(0, Number(query.offset) || 0);
    const limit = Math.min(50, Math.max(1, Number(query.limit) || 20));
    const items = db.all(
      `SELECT r.id, r.rating, r.text, r.created_at, r.updated_at, u.first_name, u.photo_url
       FROM reviews r JOIN users u ON u.id = r.user_id
       WHERE r.service_id = ? AND r.status = 'approved' ORDER BY r.created_at DESC LIMIT ? OFFSET ?`, id, limit, offset);
    const dist = db.all("SELECT rating, COUNT(*) n FROM reviews WHERE service_id = ? AND status = 'approved' GROUP BY rating", id);
    return { items, distribution: Object.fromEntries(dist.map((d) => [d.rating, d.n])) };
  });

  r.get('/api/compare', ({ query }) => {
    const ids = String(query.ids || '').split(',').map(Number).filter(Number.isSafeInteger).slice(0, 3);
    const snap = snapshot(db);
    return { items: ids.map((id) => snap.byId.get(id)).filter(Boolean).map(({ rating_rank, ...s }) => s) };
  });

  r.get('/api/top', () => ({ current: withTopItems(snapshot(db), latestTop(db)), archive: topArchive(db) }));

  r.get('/api/top/:period', ({ params }) => {
    if (!isPeriod(params.period)) throw badRequest('Неверный месяц');
    const top = topFor(db, params.period);
    if (!top) throw notFound('Топ за этот месяц не публиковался');
    return withTopItems(snapshot(db), top);
  });
}
