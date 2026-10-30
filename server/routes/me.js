import { requireUser, intParam, badRequest, notFound } from '../lib/http.js';
import { snapshot, toListItem } from '../lib/catalog.js';
import { notifySettings, setNotifySettings } from '../lib/notify.js';
import { upsertReview, deleteReview } from '../lib/moderation.js';
import { validateReview } from '../lib/validate.js';
import { now, mskDay } from '../lib/time.js';

function bumpStat(db, serviceId, column, by = 1) {
  db.run(`INSERT INTO stats_daily (service_id, day, ${column}) VALUES (?, ?, ?)
          ON CONFLICT(service_id, day) DO UPDATE SET ${column} = ${column} + excluded.${column}`, serviceId, mskDay(), by);
}

export function meRoutes(r, { db }) {
  r.get('/api/me', (ctx) => {
    const u = requireUser(ctx);
    return {
      id: u.id,
      first_name: u.first_name,
      last_name: u.last_name,
      username: u.username,
      photo_url: u.photo_url,
      roles: u.roles,
      active_role: u.roles.includes(u.active_role) ? u.active_role : 'client',
      bot_chat_allowed: Boolean(u.bot_chat_allowed),
      notify: notifySettings(db, u.id),
      favorites: db.all('SELECT service_id FROM favorites WHERE user_id = ? ORDER BY created_at DESC', u.id).map((f) => f.service_id),
      counts: {
        reviews: db.get('SELECT COUNT(*) n FROM reviews WHERE user_id = ?', u.id).n,
        history: db.get('SELECT COUNT(DISTINCT service_id) n FROM clicks WHERE user_id = ?', u.id).n,
        // Ad exchange: what needs the user's attention.
        ad_channels: db.get('SELECT COUNT(*) n FROM ad_channels WHERE owner_id = ?', u.id).n,
        ad_requests: db.get("SELECT COUNT(*) n FROM ad_deals WHERE seller_id = ? AND status = 'requested'", u.id).n,
        ad_deals: db.get("SELECT COUNT(*) n FROM ad_deals WHERE buyer_id = ? AND status IN ('requested', 'agreed', 'published')", u.id).n
      }
    };
  });

  // Role switch: a VPN owner is still a client; the profile just shows a different workspace.
  r.patch('/api/me', (ctx) => {
    const u = requireUser(ctx);
    const role = ctx.body?.active_role;
    if (role !== 'client' && !u.roles.includes(role)) throw badRequest('Эта роль вам недоступна');
    db.run('UPDATE users SET active_role = ? WHERE id = ?', role, u.id);
    return { active_role: role };
  });

  r.put('/api/me/notify', (ctx) => ({ notify: setNotifySettings(db, requireUser(ctx).id, ctx.body || {}) }));

  // Called after Telegram.WebApp.requestWriteAccess() succeeds.
  r.post('/api/me/bot-access', (ctx) => {
    const u = requireUser(ctx);
    db.run('UPDATE users SET bot_chat_allowed = 1 WHERE id = ?', u.id);
    return { bot_chat_allowed: true };
  });

  r.get('/api/me/favorites', (ctx) => {
    const u = requireUser(ctx);
    const snap = snapshot(db);
    const ids = db.all('SELECT service_id FROM favorites WHERE user_id = ? ORDER BY created_at DESC', u.id).map((f) => f.service_id);
    return { items: ids.map((id) => snap.byId.get(id)).filter(Boolean).map(toListItem) };
  });

  r.put('/api/me/favorites/:id', (ctx) => {
    const u = requireUser(ctx);
    const id = intParam(ctx.params.id);
    if (!db.get("SELECT 1 FROM services WHERE id = ? AND status = 'published'", id)) throw notFound('VPN не найден');
    const count = db.get('SELECT COUNT(*) n FROM favorites WHERE user_id = ?', u.id).n;
    if (count >= 200) throw badRequest('В избранном уже 200 сервисов');
    db.run('INSERT OR IGNORE INTO favorites (user_id, service_id, created_at) VALUES (?, ?, ?)', u.id, id, now());
    return { ok: true };
  });

  r.delete('/api/me/favorites/:id', (ctx) => {
    const u = requireUser(ctx);
    db.run('DELETE FROM favorites WHERE user_id = ? AND service_id = ?', u.id, intParam(ctx.params.id));
    return { ok: true };
  });

  r.get('/api/me/reviews', (ctx) => {
    const u = requireUser(ctx);
    return {
      items: db.all(
        `SELECT r.id, r.service_id, r.rating, r.text, r.status, r.reject_reason, r.created_at, r.updated_at, s.name, s.logo_url
         FROM reviews r JOIN services s ON s.id = r.service_id WHERE r.user_id = ? ORDER BY r.updated_at DESC`, u.id)
    };
  });

  r.post('/api/services/:id/reviews', (ctx) => {
    const u = requireUser(ctx);
    return { review: upsertReview(db, u, intParam(ctx.params.id), validateReview(ctx.body)) };
  });

  r.delete('/api/me/reviews/:id', (ctx) => {
    deleteReview(db, requireUser(ctx), intParam(ctx.params.id));
    return { ok: true };
  });

  r.get('/api/me/history', (ctx) => {
    const u = requireUser(ctx);
    return {
      items: db.all(
        `SELECT c.service_id, s.name, s.logo_url, MAX(c.created_at) last_at, COUNT(*) times,
           (SELECT status FROM reviews rv WHERE rv.user_id = c.user_id AND rv.service_id = c.service_id) review_status
         FROM clicks c JOIN services s ON s.id = c.service_id
         WHERE c.user_id = ? GROUP BY c.service_id ORDER BY last_at DESC LIMIT 100`, u.id)
    };
  });

  // Logged right before the client opens the VPN bot. One row per click; uniqueness is
  // counted per Telegram ID where it matters (top, popularity).
  r.post('/api/services/:id/click', (ctx) => {
    const u = requireUser(ctx);
    const id = intParam(ctx.params.id);
    const s = db.get("SELECT bot_url FROM services WHERE id = ? AND status = 'published' AND hidden = 0", id);
    if (!s) throw notFound('VPN не найден');
    const source = typeof ctx.body?.source === 'string' ? ctx.body.source.slice(0, 32) : null;
    // Debounce double taps: one click per user and service per minute.
    const recent = db.get('SELECT 1 FROM clicks WHERE user_id = ? AND service_id = ? AND created_at > ?', u.id, id, now() - 60_000);
    if (!recent) {
      db.run('INSERT INTO clicks (service_id, user_id, source, created_at) VALUES (?, ?, ?, ?)', id, u.id, source, now());
      bumpStat(db, id, 'clicks');
    }
    return { url: s.bot_url };
  });

  // Batched impressions (card seen in a list) and views (card opened).
  r.post('/api/events', (ctx) => {
    requireUser(ctx);
    const body = ctx.body || {};
    const known = new Set(snapshot(db).items.map((s) => s.id));
    const take = (arr) => [...new Set((Array.isArray(arr) ? arr : []).map(Number))].filter((id) => known.has(id)).slice(0, 100);
    db.tx(() => {
      for (const id of take(body.impressions)) bumpStat(db, id, 'impressions');
      for (const id of take(body.views)) bumpStat(db, id, 'views');
    });
    return { ok: true };
  });
}
