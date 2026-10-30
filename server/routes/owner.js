import { requireUser, requireRole, intParam } from '../lib/http.js';
import { validateApplication, validateCard, validatePromo } from '../lib/validate.js';
import { createApplication, submitRevision, ownedService, createPromo, cancelPromo } from '../lib/moderation.js';
import { rowToCard, tariffsOf } from '../lib/catalog.js';
import { computeTop } from '../lib/top.js';
import { now, mskDay, periodOf, DAY } from '../lib/time.js';

const latestRevision = (db, serviceId) => db.get(
  "SELECT id, status, reject_reason, created_at, reviewed_at FROM service_revisions WHERE service_id = ? AND status != 'superseded' ORDER BY id DESC LIMIT 1",
  serviceId) || null;

export function ownerRoutes(r, { db }) {
  r.get('/api/owner', (ctx) => {
    const u = requireUser(ctx);
    return {
      applications: db.all('SELECT id, name, link, contact, comment, status, reject_reason, service_id, created_at, reviewed_at FROM applications WHERE user_id = ? ORDER BY id DESC', u.id),
      services: db.all('SELECT id, name, status, hidden, hidden_reason, logo_url, min_monthly, published_at FROM services WHERE owner_id = ? ORDER BY id', u.id)
        .map((s) => ({ ...s, revision: latestRevision(db, s.id) }))
    };
  });

  r.post('/api/owner/applications', (ctx) => {
    const u = requireUser(ctx);
    return { application: createApplication(db, u, validateApplication(ctx.body)) };
  });

  r.get('/api/owner/services/:id', (ctx) => {
    const u = requireRole(ctx, 'vpn_owner');
    const s = ownedService(db, u, intParam(ctx.params.id));
    const published = s.status === 'published' ? rowToCard(s, tariffsOf(db, s.id)) : null;
    const pending = db.get("SELECT data FROM service_revisions WHERE service_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1", s.id);
    // The editor starts from the newest version: pending > published > application skeleton.
    const draft = pending ? JSON.parse(pending.data) : published || { name: s.name, bot_url: s.bot_url, tariffs: {}, protocols: [], countries: [], platforms: [], payments: [], devices: 1 };
    return {
      service: { id: s.id, name: s.name, status: s.status, hidden: Boolean(s.hidden), hidden_reason: s.hidden_reason, logo_url: s.logo_url, published_at: s.published_at, updated_at: s.updated_at },
      published,
      draft,
      revision: latestRevision(db, s.id)
    };
  });

  r.post('/api/owner/services/:id/revisions', (ctx) => {
    const u = requireRole(ctx, 'vpn_owner');
    const id = intParam(ctx.params.id);
    ownedService(db, u, id);
    return { revision_id: submitRevision(db, u, id, validateCard(ctx.body)) };
  });

  r.get('/api/owner/services/:id/promos', (ctx) => {
    const u = requireRole(ctx, 'vpn_owner');
    const s = ownedService(db, u, intParam(ctx.params.id));
    return { items: db.all('SELECT * FROM promotions WHERE service_id = ? ORDER BY id DESC LIMIT 50', s.id) };
  });

  r.post('/api/owner/services/:id/promos', (ctx) => {
    const u = requireRole(ctx, 'vpn_owner');
    return { promo: createPromo(db, u, intParam(ctx.params.id), validatePromo(ctx.body, now())) };
  });

  r.delete('/api/owner/promos/:id', (ctx) => {
    cancelPromo(db, requireRole(ctx, 'vpn_owner'), intParam(ctx.params.id));
    return { ok: true };
  });

  r.get('/api/owner/services/:id/stats', (ctx) => {
    const u = requireRole(ctx, 'vpn_owner');
    const s = ownedService(db, u, intParam(ctx.params.id));
    const days = Math.min(90, Math.max(7, Number(ctx.query.days) || 30));
    const from = mskDay(now() - (days - 1) * DAY);
    const rows = new Map(db.all('SELECT day, impressions, views, clicks FROM stats_daily WHERE service_id = ? AND day >= ?', s.id, from).map((d) => [d.day, d]));
    const daily = [];
    for (let i = days - 1; i >= 0; i--) {
      const day = mskDay(now() - i * DAY);
      daily.push(rows.get(day) || { day, impressions: 0, views: 0, clicks: 0 });
    }
    const rating = db.get("SELECT AVG(rating) avg, COUNT(*) n FROM reviews WHERE service_id = ? AND status = 'approved'", s.id);
    const period = periodOf();
    const top = computeTop(db, period);
    const mine = top.rows.find((row) => row.service_id === s.id) || null;
    return {
      daily,
      totals: daily.reduce((t, d) => ({ impressions: t.impressions + d.impressions, views: t.views + d.views, clicks: t.clicks + d.clicks }), { impressions: 0, views: 0, clicks: 0 }),
      favorites: db.get('SELECT COUNT(*) n FROM favorites WHERE service_id = ?', s.id).n,
      rating: { avg: rating.n ? Math.round(rating.avg * 10) / 10 : null, n: rating.n },
      pending_reviews: db.get("SELECT COUNT(*) n FROM reviews WHERE service_id = ? AND status = 'pending'", s.id).n,
      top: { period, weights: top.weights, total: top.rows.length, rank: mine?.rank || null, score: mine?.score ?? null, components: mine?.components || null }
    };
  });
}
