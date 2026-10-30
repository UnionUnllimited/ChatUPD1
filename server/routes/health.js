// HTTP API of the service health system (see lib/health.js).
import { requireUser, requireRole, intParam, forbidden } from '../lib/http.js';
import {
  recordVote, setVoteNetwork, serviceHealth, openDispute, clearStatus, confirmStatus, keepAnomaly,
  statusConfig, validateStatusConfig, windowStats, statusRow
} from '../lib/health.js';
import { ownedService, audit } from '../lib/moderation.js';
import { now } from '../lib/time.js';

export function healthRoutes(r, { db, config }) {
  const opts = { envAdmins: config.adminIds };

  /* -------- Clients: «Работает у меня» / «Не работает у меня» -------- */
  const voter = (ctx) => {
    const user = requireUser(ctx);
    // Signals come only from Telegram-signed requests (initData), never from panel sessions.
    if (user.auth !== 'tma' && user.auth !== 'dev') throw forbidden('Отмечать статус можно только из Telegram');
    return user;
  };

  r.post('/api/services/:id/vote', (ctx) => {
    const user = voter(ctx);
    const id = intParam(ctx.params.id);
    const { repeated } = recordVote(db, user, id, ctx.body?.value, opts);
    return { repeated, health: serviceHealth(db, id, user.id) };
  });

  r.patch('/api/services/:id/vote', (ctx) => {
    const user = voter(ctx);
    const id = intParam(ctx.params.id);
    setVoteNetwork(db, user, id, ctx.body?.network ?? null);
    return { health: serviceHealth(db, id, user.id) };
  });

  /* -------- VPN owners -------- */
  r.post('/api/owner/services/:id/dispute', (ctx) => {
    const user = requireRole(ctx, 'vpn_owner');
    openDispute(db, user, intParam(ctx.params.id), ctx.body?.comment, opts);
    return { ok: true };
  });

  r.get('/api/owner/services/:id/health', (ctx) => {
    const user = requireRole(ctx, 'vpn_owner');
    const s = ownedService(db, user, intParam(ctx.params.id));
    return {
      health: serviceHealth(db, s.id),
      window: windowStats(db, s.id),
      dispute: db.get("SELECT id, status, comment, state, created_at FROM status_disputes WHERE service_id = ? ORDER BY id DESC LIMIT 1", s.id) || null
    };
  });

  /* -------- Admins -------- */
  const admin = (ctx) => requireRole(ctx, 'admin');

  r.get('/api/admin/status', (ctx) => {
    admin(ctx);
    const incidents = db.all(
      `SELECT st.service_id, st.status, st.since, st.confirmed_at, s.name, s.logo_url FROM service_status st JOIN services s ON s.id = st.service_id
       WHERE st.status != 'operational' ORDER BY st.since DESC`)
      .map((i) => ({ ...i, window: windowStats(db, i.service_id) }));
    return {
      incidents,
      disputes: db.all(`SELECT d.*, s.name, u.username owner_username, u.first_name owner_name FROM status_disputes d
                        JOIN services s ON s.id = d.service_id JOIN users u ON u.id = d.owner_id WHERE d.state = 'open' ORDER BY d.id`),
      anomalies: db.all(`SELECT a.*, s.name FROM status_anomalies a JOIN services s ON s.id = a.service_id WHERE a.state = 'open' ORDER BY a.id`)
        .map((a) => ({ ...a, details: a.details ? JSON.parse(a.details) : null })),
      changes: db.all(`SELECT c.*, s.name FROM status_changes c JOIN services s ON s.id = c.service_id ORDER BY c.id DESC LIMIT 40`),
      config: statusConfig(db)
    };
  });

  r.get('/api/admin/services/:id/votes', (ctx) => {
    admin(ctx);
    const id = intParam(ctx.params.id);
    return {
      status: statusRow(db, id),
      health: serviceHealth(db, id),
      window: windowStats(db, id),
      items: db.all(
        `SELECT v.id, v.user_id, v.value, v.network, v.base_weight, v.excluded, v.created_at, v.trust_checked_at,
           u.username, u.first_name, u.trust_score, ROUND(v.base_weight * u.trust_score, 2) weight
         FROM status_votes v JOIN users u ON u.id = v.user_id WHERE v.service_id = ? ORDER BY v.created_at DESC LIMIT 100`, id)
    };
  });

  r.post('/api/admin/services/:id/status/clear', (ctx) => {
    const note = typeof ctx.body?.note === 'string' ? ctx.body.note.trim().slice(0, 300) || null : null;
    return clearStatus(db, admin(ctx), intParam(ctx.params.id), note);
  });

  r.post('/api/admin/services/:id/status/confirm', (ctx) => {
    confirmStatus(db, admin(ctx), intParam(ctx.params.id));
    return { ok: true };
  });

  r.post('/api/admin/status/anomalies/:id/keep', (ctx) => {
    keepAnomaly(db, admin(ctx), intParam(ctx.params.id));
    return { ok: true };
  });

  r.get('/api/admin/status/config', (ctx) => { admin(ctx); return { config: statusConfig(db) }; });

  r.put('/api/admin/status/config', (ctx) => {
    const a = admin(ctx);
    const next = validateStatusConfig(ctx.body);
    const before = statusConfig(db);
    db.setSetting('status_config', next);
    const changed = Object.keys(next).filter((k) => next[k] !== before[k]);
    audit(db, a.id, 'settings.status', 'settings', null, { changed: Object.fromEntries(changed.map((k) => [k, [before[k], next[k]]])) });
    return { config: next, at: now() };
  });
}
