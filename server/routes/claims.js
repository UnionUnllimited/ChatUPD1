// HTTP API of «Забрать свою карточку» (see lib/claims.js) and the owner's home block.
import { requireUser, requireRole, intParam, badRequest } from '../lib/http.js';
import {
  previewLink, claimByLink, startClaim, claimView, checkCode, requestManual, decideClaim, createClaimLink, claimSuggestions
} from '../lib/claims.js';
import { importServices } from '../lib/importer.js';
import { mskDay, now, DAY } from '../lib/time.js';

export function claimRoutes(r, { db, config }) {
  const opts = { envAdmins: config.adminIds };
  const view = (user, id) => claimView(db, user, id, { botUsername: config.botUsername });

  r.get('/api/claims/link/:token', (ctx) => { requireUser(ctx); return previewLink(db, ctx.params.token); });

  // By an invitation token, or from the card («Это ваш VPN?»).
  r.post('/api/claims', (ctx) => {
    const user = requireUser(ctx);
    const b = ctx.body || {};
    if (b.token) return claimByLink(db, user, String(b.token), opts);
    if (!b.service_id) throw badRequest('Не указана карточка');
    const out = startClaim(db, user, intParam(b.service_id, 'service_id'), { dispute: Boolean(b.dispute), note: b.note, ...opts });
    return out.claim_id ? { claim: view(user, out.claim_id) } : out;
  });

  r.get('/api/claims/:id', (ctx) => ({ claim: view(requireUser(ctx), intParam(ctx.params.id)) }));

  r.post('/api/claims/:id/verify', async (ctx) => {
    const user = requireUser(ctx);
    const id = intParam(ctx.params.id);
    const method = ctx.body?.method;
    let result = {};
    if (method === 'code') result = await checkCode(db, user, id, opts);
    else if (method === 'manual') requestManual(db, user, id, ctx.body?.note, opts);
    else throw badRequest('Неизвестный способ проверки');
    return { ...result, claim: view(user, id) };
  });

  // Home: «Ваш VPN» for owners, «Похоже, это ваш VPN…» hints for everyone else.
  r.get('/api/me/services', (ctx) => {
    const user = requireUser(ctx);
    const from = mskDay(now() - 6 * DAY);
    const services = db.all(
      `SELECT s.id, s.name, s.logo_url, s.status, s.hidden, s.min_monthly, COALESCE(st.status, 'operational') health,
         (SELECT status FROM service_revisions v WHERE v.service_id = s.id ORDER BY v.id DESC LIMIT 1) revision,
         (SELECT COALESCE(SUM(impressions), 0) FROM stats_daily d WHERE d.service_id = s.id AND d.day >= ?) impressions7,
         (SELECT COALESCE(SUM(clicks), 0) FROM stats_daily d WHERE d.service_id = s.id AND d.day >= ?) clicks7
       FROM services s LEFT JOIN service_status st ON st.service_id = s.id WHERE s.owner_id = ? ORDER BY s.published_at IS NULL, s.name`, from, from, user.id);
    const open = db.all(`SELECT id, service_id, status FROM service_claims WHERE user_id = ? AND status IN ('pending', 'manual', 'dispute')`, user.id);
    const busy = new Set(open.map((c) => c.service_id));
    return { services, claims: open, suggestions: claimSuggestions(db, user).filter((s) => !busy.has(s.id)) };
  });

  /* -------- Admins -------- */
  const admin = (ctx) => requireRole(ctx, 'admin');
  r.post('/api/admin/services/:id/claim-link', (ctx) => createClaimLink(db, admin(ctx), intParam(ctx.params.id)));
  r.post('/api/admin/claims/:id/approve', (ctx) => decideClaim(db, admin(ctx), intParam(ctx.params.id), true, null, opts));
  r.post('/api/admin/claims/:id/reject', (ctx) => decideClaim(db, admin(ctx), intParam(ctx.params.id), false, ctx.body?.reason, opts));
  r.post('/api/admin/services/import', (ctx) => importServices(db, admin(ctx), ctx.body?.text, { dryRun: Boolean(ctx.body?.dry_run), uploadsDir: config.uploadsDir }));
}
