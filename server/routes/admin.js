import { requireRole, intParam, badRequest, notFound } from '../lib/http.js';
import {
  approveApplication, rejectApplication, approveRevision, rejectRevision, revisionDiff,
  approvePromo, rejectPromo, moderateReview, audit
} from '../lib/moderation.js';
import { recomputeMarketAverage, invalidate } from '../lib/catalog.js';
import { computeTop, publishTop, normalizeWeights, topArchive } from '../lib/top.js';
import { reason as validReason } from '../lib/validate.js';
import { now, previousPeriod, periodOf, isPeriod, DAY } from '../lib/time.js';

const userBrief = 'u.id user_id, u.username, u.first_name, u.last_name';

export function adminRoutes(r, { db, config }) {
  const admin = (ctx) => requireRole(ctx, 'admin');

  r.get('/api/admin/summary', (ctx) => {
    admin(ctx);
    const n = (sql, ...p) => db.get(sql, ...p).n;
    return {
      applications: n("SELECT COUNT(*) n FROM applications WHERE status = 'pending'"),
      revisions: n("SELECT COUNT(*) n FROM service_revisions WHERE status = 'pending'"),
      promos: n("SELECT COUNT(*) n FROM promotions WHERE status = 'pending'"),
      reviews: n("SELECT COUNT(*) n FROM reviews WHERE status = 'pending'"),
      services: n("SELECT COUNT(*) n FROM services WHERE status = 'published'"),
      hidden: n("SELECT COUNT(*) n FROM services WHERE hidden = 1"),
      unchecked: n(`SELECT COUNT(*) n FROM services s WHERE s.status = 'published' AND s.hidden = 0
                    AND NOT EXISTS (SELECT 1 FROM service_checks c WHERE c.service_id = s.id AND c.checked_at > ?)`, now() - 14 * DAY),
      users: n('SELECT COUNT(*) n FROM users'),
      outbox: n("SELECT COUNT(*) n FROM notifications WHERE status = 'queued'"),
      top_pending: !db.get('SELECT 1 FROM top_snapshots WHERE period = ?', previousPeriod())
    };
  });

  /* -------- Applications -------- */
  r.get('/api/admin/applications', (ctx) => {
    admin(ctx);
    const status = ['pending', 'approved', 'rejected'].includes(ctx.query.status) ? ctx.query.status : 'pending';
    return {
      items: db.all(`SELECT a.*, ${userBrief} FROM applications a JOIN users u ON u.id = a.user_id WHERE a.status = ? ORDER BY a.id ${status === 'pending' ? 'ASC' : 'DESC'} LIMIT 100`, status)
    };
  });
  r.post('/api/admin/applications/:id/approve', (ctx) => approveApplication(db, admin(ctx), intParam(ctx.params.id)));
  r.post('/api/admin/applications/:id/reject', (ctx) => {
    const a = admin(ctx);
    rejectApplication(db, a, intParam(ctx.params.id), validReason(ctx.body?.reason));
    return { ok: true };
  });

  /* -------- Moderation queue -------- */
  r.get('/api/admin/moderation', (ctx) => {
    admin(ctx);
    const kind = ctx.query.kind || 'revisions';
    if (kind === 'revisions') {
      return {
        items: db.all(`SELECT r.id, r.service_id, r.data, r.created_at, s.name service_name, s.status service_status, ${userBrief}
                       FROM service_revisions r JOIN services s ON s.id = r.service_id JOIN users u ON u.id = r.author_id
                       WHERE r.status = 'pending' ORDER BY r.id LIMIT 50`)
          .map(({ data, ...row }) => ({ ...row, diff: revisionDiff(db, { service_id: row.service_id, data }) }))
      };
    }
    if (kind === 'promos') {
      return { items: db.all("SELECT p.*, s.name service_name FROM promotions p JOIN services s ON s.id = p.service_id WHERE p.status = 'pending' ORDER BY p.id LIMIT 100") };
    }
    if (kind === 'reviews') {
      return {
        items: db.all(`SELECT r.id, r.service_id, r.rating, r.text, r.created_at, r.updated_at, s.name service_name, ${userBrief},
                         (SELECT COUNT(*) FROM clicks c WHERE c.user_id = r.user_id AND c.service_id = r.service_id) clicks
                       FROM reviews r JOIN services s ON s.id = r.service_id JOIN users u ON u.id = r.user_id
                       WHERE r.status = 'pending' ORDER BY r.updated_at LIMIT 100`)
      };
    }
    throw badRequest('Неизвестная очередь');
  });

  r.post('/api/admin/revisions/:id/approve', (ctx) => approveRevision(db, admin(ctx), intParam(ctx.params.id), { uploadsDir: config.uploadsDir }));
  r.post('/api/admin/revisions/:id/reject', (ctx) => { rejectRevision(db, admin(ctx), intParam(ctx.params.id), validReason(ctx.body?.reason)); return { ok: true }; });
  r.post('/api/admin/promos/:id/approve', (ctx) => { approvePromo(db, admin(ctx), intParam(ctx.params.id)); return { ok: true }; });
  r.post('/api/admin/promos/:id/reject', (ctx) => { rejectPromo(db, admin(ctx), intParam(ctx.params.id), validReason(ctx.body?.reason)); return { ok: true }; });
  r.post('/api/admin/reviews/:id/approve', (ctx) => { moderateReview(db, admin(ctx), intParam(ctx.params.id), true); return { ok: true }; });
  r.post('/api/admin/reviews/:id/reject', (ctx) => { moderateReview(db, admin(ctx), intParam(ctx.params.id), false, validReason(ctx.body?.reason)); return { ok: true }; });

  /* -------- Manual checks -------- */
  r.get('/api/admin/checks', (ctx) => {
    admin(ctx);
    const since = now() - 30 * DAY;
    return {
      items: db.all(
        `SELECT s.id, s.name, s.logo_url, s.bot_url, s.hidden,
           (SELECT MAX(checked_at) FROM service_checks c WHERE c.service_id = s.id) last_at,
           (SELECT passed FROM service_checks c WHERE c.service_id = s.id ORDER BY checked_at DESC LIMIT 1) last_passed,
           (SELECT COUNT(*) FROM service_checks c WHERE c.service_id = s.id AND c.checked_at > ?) n30,
           (SELECT COALESCE(SUM(passed), 0) FROM service_checks c WHERE c.service_id = s.id AND c.checked_at > ?) passed30
         FROM services s WHERE s.status = 'published' ORDER BY last_at IS NOT NULL, last_at`, since, since)
    };
  });

  r.get('/api/admin/services/:id/checks', (ctx) => {
    admin(ctx);
    return {
      items: db.all(`SELECT c.id, c.passed, c.note, c.checked_at, u.username, u.first_name FROM service_checks c LEFT JOIN users u ON u.id = c.admin_id
                     WHERE c.service_id = ? ORDER BY c.checked_at DESC LIMIT 50`, intParam(ctx.params.id))
    };
  });

  r.post('/api/admin/services/:id/checks', (ctx) => {
    const a = admin(ctx);
    const id = intParam(ctx.params.id);
    if (!db.get('SELECT 1 FROM services WHERE id = ?', id)) throw notFound('Сервис не найден');
    const passed = Boolean(ctx.body?.passed);
    const note = typeof ctx.body?.note === 'string' ? ctx.body.note.trim().slice(0, 300) || null : null;
    db.run('INSERT INTO service_checks (service_id, admin_id, passed, note, checked_at) VALUES (?, ?, ?, ?, ?)', id, a.id, passed, note, now());
    audit(db, a.id, passed ? 'check.pass' : 'check.fail', 'service', id, note ? { note } : null);
    invalidate();
    return { ok: true };
  });

  /* -------- Monthly top -------- */
  r.get('/api/admin/top', (ctx) => {
    admin(ctx);
    const period = isPeriod(ctx.query.period) ? ctx.query.period : previousPeriod();
    const preview = computeTop(db, period);
    return {
      ...preview,
      current_period: periodOf(),
      published: db.get('SELECT published_at, published_by FROM top_snapshots WHERE period = ?', period) || null,
      archive: topArchive(db)
    };
  });

  r.put('/api/admin/settings/top-weights', (ctx) => {
    const a = admin(ctx);
    const weights = normalizeWeights(ctx.body);
    const before = db.setting('top_weights');
    db.setSetting('top_weights', weights);
    audit(db, a.id, 'settings.top_weights', 'settings', null, { before, after: weights });
    return { weights };
  });

  r.post('/api/admin/top/:period/publish', (ctx) => {
    const a = admin(ctx);
    const period = ctx.params.period;
    if (!isPeriod(period)) throw badRequest('Неверный месяц');
    if (period >= periodOf()) throw badRequest('Топ публикуется только за завершённый месяц');
    return { winners: publishTop(db, period, a.id).length };
  });

  /* -------- Users & services -------- */
  r.get('/api/admin/search', (ctx) => {
    admin(ctx);
    const q = String(ctx.query.q || '').trim().slice(0, 64);
    const like = `%${q.replace(/^@/, '')}%`;
    const asId = /^\d+$/.test(q) ? Number(q) : -1;
    return {
      users: db.all(`SELECT id, username, first_name, last_name, is_blocked, blocked_reason, created_at, last_seen_at,
                       (SELECT GROUP_CONCAT(role) FROM user_roles WHERE user_id = users.id) roles
                     FROM users WHERE ? = '' OR id = ? OR username LIKE ? OR first_name LIKE ? ORDER BY last_seen_at DESC LIMIT 30`, q, asId, like, like),
      services: db.all(`SELECT s.id, s.name, s.status, s.hidden, s.hidden_reason, s.owner_id, u.username owner_username
                        FROM services s LEFT JOIN users u ON u.id = s.owner_id
                        WHERE ? = '' OR s.id = ? OR s.name LIKE ? ORDER BY s.name LIMIT 30`, q, asId, like)
    };
  });

  r.post('/api/admin/users/:id/block', (ctx) => {
    const a = admin(ctx);
    const id = intParam(ctx.params.id);
    if (config.adminIds.includes(id) || id === a.id) throw badRequest('Нельзя заблокировать администратора');
    const why = validReason(ctx.body?.reason);
    if (!db.run('UPDATE users SET is_blocked = 1, blocked_reason = ? WHERE id = ?', why, id).changes) throw notFound('Пользователь не найден');
    audit(db, a.id, 'user.block', 'user', id, { reason: why });
    return { ok: true };
  });

  r.post('/api/admin/users/:id/unblock', (ctx) => {
    const a = admin(ctx);
    const id = intParam(ctx.params.id);
    db.run('UPDATE users SET is_blocked = 0, blocked_reason = NULL WHERE id = ?', id);
    audit(db, a.id, 'user.unblock', 'user', id);
    return { ok: true };
  });

  r.post('/api/admin/services/:id/hide', (ctx) => {
    const a = admin(ctx);
    const id = intParam(ctx.params.id);
    const why = validReason(ctx.body?.reason);
    if (!db.run('UPDATE services SET hidden = 1, hidden_reason = ? WHERE id = ?', why, id).changes) throw notFound('Сервис не найден');
    recomputeMarketAverage(db);
    audit(db, a.id, 'service.hide', 'service', id, { reason: why });
    return { ok: true };
  });

  r.post('/api/admin/services/:id/unhide', (ctx) => {
    const a = admin(ctx);
    const id = intParam(ctx.params.id);
    db.run('UPDATE services SET hidden = 0, hidden_reason = NULL WHERE id = ?', id);
    recomputeMarketAverage(db);
    audit(db, a.id, 'service.unhide', 'service', id);
    return { ok: true };
  });

  /* -------- Audit log -------- */
  r.get('/api/admin/log', (ctx) => {
    admin(ctx);
    const offset = Math.max(0, Number(ctx.query.offset) || 0);
    return {
      items: db.all(`SELECT l.*, u.username, u.first_name FROM audit_log l LEFT JOIN users u ON u.id = l.admin_id ORDER BY l.id DESC LIMIT 50 OFFSET ?`, offset)
        .map((l) => ({ ...l, details: l.details ? JSON.parse(l.details) : null }))
    };
  });
}
