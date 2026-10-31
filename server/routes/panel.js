// API of the standalone admin panel (public/admin/). Moderation, checks, the monthly
// top and the audit log live in routes/admin.js and are shared with it.
import { requireRole, intParam, badRequest, notFound, RawResponse } from '../lib/http.js';
import { exchangeLoginToken, endSession, listSessions, endAllSessions } from '../lib/sessions.js';
import { createService, editService, assignOwner, deleteService, setRole, broadcast, purgeDemo, toCsv } from '../lib/adminops.js';
import { setReviewStatus, audit } from '../lib/moderation.js';
import { rowToCard, tariffsOf, invalidate } from '../lib/catalog.js';
import { validateCard, reason as validReason } from '../lib/validate.js';
import { loadUser } from '../auth.js';
import { now, periodOf, periodRange, mskDay, DAY } from '../lib/time.js';

const sessionToken = (ctx) => (ctx.authorization.startsWith('Session ') ? ctx.authorization.slice(8) : null);
const dayExpr = (col) => `strftime('%Y-%m-%d', ${col} / 1000 + 10800, 'unixepoch')`;

function series(db, sql, days, ...params) {
  const rows = new Map(db.all(sql, ...params).map((r) => [r.day, r.n]));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = mskDay(now() - i * DAY);
    out.push({ day, n: rows.get(day) || 0 });
  }
  return out;
}

export function panelRoutes(r, { db, config }) {
  const admin = (ctx) => requireRole(ctx, 'admin');

  /* -------- Public bits the login screen needs -------- */
  r.get('/api/meta', () => ({ bot_username: config.botUsername }));

  r.post('/api/admin/auth/exchange', (ctx) => {
    const s = exchangeLoginToken(db, ctx.body?.token, ctx.userAgent);
    const user = loadUser(db, s.user_id, config.adminIds);
    if (!user || !user.roles.includes('admin')) throw badRequest('Нет прав администратора');
    audit(db, user.id, 'auth.login', 'user', user.id, { via: 'bot link' });
    return { session: s.session, expires_at: s.expires_at };
  });

  r.post('/api/admin/auth/logout', (ctx) => {
    const token = sessionToken(ctx);
    if (token) endSession(db, token);
    return { ok: true };
  });

  r.get('/api/admin/sessions', (ctx) => ({ items: listSessions(db, admin(ctx).id, sessionToken(ctx)) }));
  r.post('/api/admin/sessions/revoke-all', (ctx) => {
    const a = admin(ctx);
    const n = endAllSessions(db, a.id);
    audit(db, a.id, 'auth.revoke_all', 'user', a.id, { sessions: n });
    return { revoked: n };
  });

  /* -------- Dashboard -------- */
  r.get('/api/admin/dashboard', (ctx) => {
    admin(ctx);
    const ts = now();
    const n = (sql, ...p) => db.get(sql, ...p).n;
    const [mStart] = periodRange(periodOf());
    const since30 = ts - 30 * DAY;
    return {
      users: {
        total: n('SELECT COUNT(*) n FROM users'),
        new7: n('SELECT COUNT(*) n FROM users WHERE created_at > ?', ts - 7 * DAY),
        active1: n('SELECT COUNT(*) n FROM users WHERE last_seen_at > ?', ts - DAY),
        active7: n('SELECT COUNT(*) n FROM users WHERE last_seen_at > ?', ts - 7 * DAY),
        reachable: n('SELECT COUNT(*) n FROM users WHERE bot_chat_allowed = 1 AND is_blocked = 0'),
        owners: n("SELECT COUNT(DISTINCT user_id) n FROM user_roles WHERE role = 'vpn_owner'")
      },
      catalog: {
        published: n("SELECT COUNT(*) n FROM services WHERE status = 'published' AND hidden = 0"),
        drafts: n("SELECT COUNT(*) n FROM services WHERE status = 'draft'"),
        hidden: n('SELECT COUNT(*) n FROM services WHERE hidden = 1'),
        market_avg: db.setting('market_avg_monthly'),
        promos_active: n("SELECT COUNT(*) n FROM promotions WHERE status = 'approved' AND starts_at <= ? AND ends_at > ?", ts, ts)
      },
      month: {
        period: periodOf(),
        clicks: n('SELECT COUNT(*) n FROM clicks WHERE created_at >= ?', mStart),
        clients: n('SELECT COUNT(DISTINCT user_id) n FROM clicks WHERE created_at >= ?', mStart),
        reviews: n("SELECT COUNT(*) n FROM reviews WHERE created_at >= ? AND status = 'approved'", mStart)
      },
      queue: {
        applications: n("SELECT COUNT(*) n FROM applications WHERE status = 'pending'"),
        revisions: n("SELECT COUNT(*) n FROM service_revisions WHERE status = 'pending'"),
        promos: n("SELECT COUNT(*) n FROM promotions WHERE status = 'pending'"),
        reviews: n("SELECT COUNT(*) n FROM reviews WHERE status = 'pending'"),
        unchecked: n(`SELECT COUNT(*) n FROM services s WHERE s.status = 'published' AND s.hidden = 0
                      AND NOT EXISTS (SELECT 1 FROM service_checks c WHERE c.service_id = s.id AND c.checked_at > ?)`, ts - 14 * DAY),
        incidents: n("SELECT COUNT(*) n FROM service_status WHERE status != 'operational'"),
        status_alerts: n("SELECT COUNT(*) n FROM status_disputes WHERE state = 'open'") + n("SELECT COUNT(*) n FROM status_anomalies WHERE state = 'open'")
      },
      outbox: {
        queued: n("SELECT COUNT(*) n FROM notifications WHERE status = 'queued'"),
        sent7: n("SELECT COUNT(*) n FROM notifications WHERE status = 'sent' AND sent_at > ?", ts - 7 * DAY),
        failed7: n("SELECT COUNT(*) n FROM notifications WHERE status IN ('failed', 'skipped') AND created_at > ?", ts - 7 * DAY)
      },
      clicks_by_day: series(db, `SELECT ${dayExpr('created_at')} day, COUNT(*) n FROM clicks WHERE created_at > ? GROUP BY day`, 30, since30),
      users_by_day: series(db, `SELECT ${dayExpr('created_at')} day, COUNT(*) n FROM users WHERE created_at > ? GROUP BY day`, 30, since30),
      top_month: db.all(
        `SELECT s.id, s.name, s.logo_url, COUNT(*) clicks, COUNT(DISTINCT c.user_id) clients
         FROM clicks c JOIN services s ON s.id = c.service_id WHERE c.created_at >= ? GROUP BY s.id ORDER BY clients DESC LIMIT 8`, mStart)
    };
  });

  /* -------- Services -------- */
  r.get('/api/admin/services', (ctx) => {
    admin(ctx);
    const since = now() - 30 * DAY;
    return {
      items: db.all(
        `SELECT s.id, s.name, s.logo_url, s.status, s.hidden, s.hidden_reason, s.min_monthly, s.base_monthly, s.owner_id, s.published_at, s.updated_at, s.bot_url,
           s.added_by, s.claim_status, s.data_checked_at, s.missing, s.users_monthly,
           (SELECT COUNT(*) FROM service_claims c WHERE c.service_id = s.id AND c.status IN ('manual', 'dispute')) claims_waiting,
           u.username owner_username, u.first_name owner_name,
           (SELECT ROUND(AVG(rating), 1) FROM reviews r WHERE r.service_id = s.id AND r.status = 'approved') rating,
           (SELECT COUNT(*) FROM reviews r WHERE r.service_id = s.id AND r.status = 'approved') reviews,
           (SELECT COUNT(DISTINCT user_id) FROM clicks c WHERE c.service_id = s.id AND c.created_at > ?) clients30,
           (SELECT COUNT(*) FROM favorites f WHERE f.service_id = s.id) favorites,
           (SELECT MAX(checked_at) FROM service_checks k WHERE k.service_id = s.id) last_check,
           (SELECT passed FROM service_checks k WHERE k.service_id = s.id ORDER BY checked_at DESC LIMIT 1) last_passed,
           EXISTS (SELECT 1 FROM service_revisions v WHERE v.service_id = s.id AND v.status = 'pending') pending
         FROM services s LEFT JOIN users u ON u.id = s.owner_id ORDER BY s.name`, since)
    };
  });

  r.get('/api/admin/services/:id', (ctx) => {
    admin(ctx);
    const id = intParam(ctx.params.id);
    const s = db.get('SELECT * FROM services WHERE id = ?', id);
    if (!s) throw notFound('Сервис не найден');
    const from = mskDay(now() - 29 * DAY);
    const rows = new Map(db.all('SELECT day, impressions, views, clicks FROM stats_daily WHERE service_id = ? AND day >= ?', id, from).map((d) => [d.day, d]));
    const daily = [];
    for (let i = 29; i >= 0; i--) { const day = mskDay(now() - i * DAY); daily.push(rows.get(day) || { day, impressions: 0, views: 0, clicks: 0 }); }
    return {
      service: { id: s.id, name: s.name, status: s.status, hidden: Boolean(s.hidden), hidden_reason: s.hidden_reason, logo_url: s.logo_url,
        min_monthly: s.min_monthly, published_at: s.published_at, updated_at: s.updated_at, created_at: s.created_at,
        added_by: s.added_by, claim_status: s.claim_status, data_checked_at: s.data_checked_at,
        missing: s.missing ? JSON.parse(s.missing) : [], users_monthly: s.users_monthly, site_url: s.site_url, admin_note: s.admin_note },
      claims: db.all(
        `SELECT c.id, c.status, c.method, c.note, c.created_at, c.decided_at, c.expires_at, c.user_id, u.username, u.first_name
         FROM service_claims c LEFT JOIN users u ON u.id = c.user_id WHERE c.service_id = ? AND c.status != 'superseded' ORDER BY c.id DESC LIMIT 20`, id),
      // Unknown devices stay unknown (the column itself defaults to 1).
      card: { ...rowToCard(s, tariffsOf(db, id)), ...(s.missing?.includes('"devices"') ? { devices: null } : {}) },
      owner: s.owner_id ? db.get('SELECT id, username, first_name, last_name FROM users WHERE id = ?', s.owner_id) : null,
      daily,
      favorites: db.get('SELECT COUNT(*) n FROM favorites WHERE service_id = ?', id).n,
      rating: db.get("SELECT ROUND(AVG(rating), 2) avg, COUNT(*) n FROM reviews WHERE service_id = ? AND status = 'approved'", id),
      reviews_by_status: Object.fromEntries(db.all('SELECT status, COUNT(*) n FROM reviews WHERE service_id = ? GROUP BY status', id).map((x) => [x.status, x.n])),
      checks: db.all('SELECT c.passed, c.note, c.checked_at, u.username FROM service_checks c LEFT JOIN users u ON u.id = c.admin_id WHERE c.service_id = ? ORDER BY c.checked_at DESC LIMIT 15', id),
      revisions: db.all('SELECT id, status, reject_reason, created_at, reviewed_at FROM service_revisions WHERE service_id = ? ORDER BY id DESC LIMIT 10', id),
      promos: db.all('SELECT id, title, discount_percent, promo_code, starts_at, ends_at, status FROM promotions WHERE service_id = ? ORDER BY id DESC LIMIT 10', id)
    };
  });

  r.post('/api/admin/services', (ctx) => {
    const a = admin(ctx);
    return { id: createService(db, a, validateCard(ctx.body, { partial: true }), { uploadsDir: config.uploadsDir }) };
  });

  // Admins may leave unknown parts empty (they show as «уточняется»); owners fill in the whole card.
  r.put('/api/admin/services/:id/card', (ctx) => editService(db, admin(ctx), intParam(ctx.params.id), validateCard(ctx.body, { partial: true }), { uploadsDir: config.uploadsDir }));

  r.post('/api/admin/services/:id/owner', (ctx) => {
    const raw = ctx.body?.user_id;
    assignOwner(db, admin(ctx), intParam(ctx.params.id), raw === null || raw === '' ? null : intParam(raw, 'user_id'));
    return { ok: true };
  });

  r.delete('/api/admin/services/:id', (ctx) => {
    deleteService(db, admin(ctx), intParam(ctx.params.id), ctx.body?.confirm);
    return { ok: true };
  });

  /* -------- Users -------- */
  r.get('/api/admin/users', (ctx) => {
    admin(ctx);
    const q = String(ctx.query.q || '').trim().replace(/^@/, '').slice(0, 64);
    const role = ['admin', 'vpn_owner', 'blocked'].includes(ctx.query.role) ? ctx.query.role : '';
    const offset = Math.max(0, Number(ctx.query.offset) || 0);
    const asId = /^\d+$/.test(q) ? Number(q) : -1;
    const where = [
      q ? '(u.id = ? OR u.username LIKE ? OR u.first_name LIKE ? OR u.last_name LIKE ?)' : '1 = 1',
      role === 'blocked' ? 'u.is_blocked = 1' : role ? 'EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role = ?)' : '1 = 1'
    ].join(' AND ');
    const params = [...(q ? [asId, `%${q}%`, `%${q}%`, `%${q}%`] : []), ...(role && role !== 'blocked' ? [role] : [])];
    const envAdmins = config.adminIds.join(',') || '0';
    return {
      total: db.get(`SELECT COUNT(*) n FROM users u WHERE ${where}`, ...params).n,
      items: db.all(
        `SELECT u.id, u.username, u.first_name, u.last_name, u.photo_url, u.is_blocked, u.blocked_reason, u.bot_chat_allowed, u.created_at, u.last_seen_at,
           (SELECT GROUP_CONCAT(role) FROM user_roles r WHERE r.user_id = u.id) roles, (u.id IN (${envAdmins})) env_admin,
           (SELECT COUNT(*) FROM reviews r WHERE r.user_id = u.id) reviews,
           (SELECT COUNT(DISTINCT service_id) FROM clicks c WHERE c.user_id = u.id) services_clicked,
           (SELECT COUNT(*) FROM favorites f WHERE f.user_id = u.id) favorites
         FROM users u WHERE ${where} ORDER BY u.last_seen_at DESC LIMIT 50 OFFSET ?`, ...params, offset)
        .map((u) => ({ ...u, roles: [...new Set([...(u.roles ? u.roles.split(',') : []), ...(u.env_admin ? ['admin'] : [])])] }))
    };
  });

  r.get('/api/admin/users/:id', (ctx) => {
    admin(ctx);
    const id = intParam(ctx.params.id);
    const user = loadUser(db, id, config.adminIds);
    if (!user) throw notFound('Пользователь не найден');
    return {
      user: { ...user, env_admin: config.adminIds.includes(id) },
      services: db.all('SELECT id, name, status, hidden FROM services WHERE owner_id = ?', id),
      applications: db.all('SELECT id, name, link, status, created_at FROM applications WHERE user_id = ? ORDER BY id DESC LIMIT 10', id),
      reviews: db.all('SELECT r.id, r.rating, r.text, r.status, r.created_at, s.name service_name FROM reviews r JOIN services s ON s.id = r.service_id WHERE r.user_id = ? ORDER BY r.id DESC LIMIT 20', id),
      clicks: db.all('SELECT s.name, MAX(c.created_at) last_at, COUNT(*) n FROM clicks c JOIN services s ON s.id = c.service_id WHERE c.user_id = ? GROUP BY c.service_id ORDER BY last_at DESC LIMIT 20', id),
      favorites: db.get('SELECT COUNT(*) n FROM favorites WHERE user_id = ?', id).n
    };
  });

  r.post('/api/admin/users/:id/roles', (ctx) => {
    const a = admin(ctx);
    return { roles: setRole(db, a, intParam(ctx.params.id), ctx.body?.role, Boolean(ctx.body?.grant), config.adminIds) };
  });

  /* -------- Reviews (all, not just the queue) -------- */
  r.get('/api/admin/reviews', (ctx) => {
    admin(ctx);
    const status = ['pending', 'approved', 'rejected'].includes(ctx.query.status) ? ctx.query.status : '';
    const q = String(ctx.query.q || '').trim().slice(0, 64);
    const offset = Math.max(0, Number(ctx.query.offset) || 0);
    const where = [status ? 'r.status = ?' : '1 = 1', q ? '(s.name LIKE ? OR r.text LIKE ? OR u.username LIKE ?)' : '1 = 1'].join(' AND ');
    const params = [...(status ? [status] : []), ...(q ? [`%${q}%`, `%${q}%`, `%${q}%`] : [])];
    return {
      total: db.get(`SELECT COUNT(*) n FROM reviews r JOIN services s ON s.id = r.service_id JOIN users u ON u.id = r.user_id WHERE ${where}`, ...params).n,
      items: db.all(
        `SELECT r.id, r.service_id, r.rating, r.text, r.status, r.reject_reason, r.created_at, r.updated_at, s.name service_name,
           u.id user_id, u.username, u.first_name FROM reviews r JOIN services s ON s.id = r.service_id JOIN users u ON u.id = r.user_id
         WHERE ${where} ORDER BY r.updated_at DESC LIMIT 50 OFFSET ?`, ...params, offset)
    };
  });

  r.post('/api/admin/reviews/:id/status', (ctx) => {
    const status = ctx.body?.status;
    setReviewStatus(db, admin(ctx), intParam(ctx.params.id), status, status === 'rejected' ? validReason(ctx.body?.reason) : null);
    return { ok: true };
  });

  /* -------- Broadcast & outbox -------- */
  r.post('/api/admin/broadcast', (ctx) => broadcast(db, admin(ctx), {
    text: ctx.body?.text, audience: ctx.body?.audience, dryRun: Boolean(ctx.body?.dry_run)
  }));

  r.get('/api/admin/notifications', (ctx) => {
    admin(ctx);
    const status = ['queued', 'sent', 'failed', 'skipped'].includes(ctx.query.status) ? ctx.query.status : '';
    return {
      counts: Object.fromEntries(db.all('SELECT status, COUNT(*) n FROM notifications GROUP BY status').map((x) => [x.status, x.n])),
      items: db.all(
        `SELECT n.id, n.user_id, n.type, n.text, n.status, n.error, n.created_at, n.sent_at, u.username, u.first_name
         FROM notifications n LEFT JOIN users u ON u.id = n.user_id ${status ? 'WHERE n.status = ?' : ''} ORDER BY n.id DESC LIMIT 100`,
        ...(status ? [status] : []))
    };
  });

  /* -------- Settings -------- */
  r.get('/api/admin/settings', (ctx) => {
    admin(ctx);
    return {
      top_weights: db.setting('top_weights'),
      top_rating_prior: db.setting('top_rating_prior'),
      market_band: db.setting('market_band'),
      env_admins: config.adminIds,
      admins: db.all(`SELECT u.id, u.username, u.first_name, u.last_name, u.last_seen_at FROM users u
                      WHERE u.id IN (${config.adminIds.join(',') || '0'}) OR EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role = 'admin')`)
        .map((u) => ({ ...u, env: config.adminIds.includes(u.id) }))
    };
  });

  r.put('/api/admin/settings', (ctx) => {
    const a = admin(ctx);
    const prior = Number(ctx.body?.top_rating_prior);
    const band = Number(ctx.body?.market_band);
    if (!Number.isFinite(prior) || prior < 0 || prior > 50) throw badRequest('Сглаживание оценки — число от 0 до 50');
    if (!Number.isFinite(band) || band < 0.02 || band > 0.5) throw badRequest('Порог рынка — от 2% до 50%');
    const before = { top_rating_prior: db.setting('top_rating_prior'), market_band: db.setting('market_band') };
    db.setSetting('top_rating_prior', prior);
    db.setSetting('market_band', band);
    invalidate();
    audit(db, a.id, 'settings.update', 'settings', null, { before, after: { top_rating_prior: prior, market_band: band } });
    return { ok: true };
  });

  r.post('/api/admin/maintenance/purge-demo', (ctx) => {
    const a = admin(ctx);
    if (ctx.body?.confirm !== 'УДАЛИТЬ') throw badRequest('Для подтверждения введите слово УДАЛИТЬ');
    return purgeDemo(db, a);
  });

  /* -------- CSV exports -------- */
  const EXPORTS = {
    services: [
      `SELECT s.id, s.name, s.status, s.hidden, s.min_monthly, s.base_monthly, s.bot_url, s.owner_id, u.username owner_username,
         (SELECT ROUND(AVG(rating), 2) FROM reviews r WHERE r.service_id = s.id AND r.status = 'approved') rating,
         (SELECT COUNT(*) FROM reviews r WHERE r.service_id = s.id AND r.status = 'approved') reviews,
         (SELECT COUNT(*) FROM favorites f WHERE f.service_id = s.id) favorites,
         datetime(s.published_at / 1000, 'unixepoch') published_at
       FROM services s LEFT JOIN users u ON u.id = s.owner_id ORDER BY s.id`,
      [['id', 'ID'], ['name', 'Название'], ['status', 'Статус'], ['hidden', 'Скрыт'], ['min_monthly', 'От ₽/мес'], ['base_monthly', '1 мес ₽'], ['bot_url', 'Бот'],
        ['owner_id', 'Владелец ID'], ['owner_username', 'Владелец'], ['rating', 'Рейтинг'], ['reviews', 'Отзывов'], ['favorites', 'В избранном'], ['published_at', 'Опубликован (UTC)']]
    ],
    users: [
      `SELECT u.id, u.username, u.first_name, u.last_name, u.is_blocked, u.bot_chat_allowed,
         (SELECT GROUP_CONCAT(role) FROM user_roles r WHERE r.user_id = u.id) roles,
         datetime(u.created_at / 1000, 'unixepoch') created_at, datetime(u.last_seen_at / 1000, 'unixepoch') last_seen_at
       FROM users u ORDER BY u.created_at`,
      [['id', 'Telegram ID'], ['username', 'Username'], ['first_name', 'Имя'], ['last_name', 'Фамилия'], ['roles', 'Роли'], ['is_blocked', 'Заблокирован'],
        ['bot_chat_allowed', 'Бот может писать'], ['created_at', 'Первый вход (UTC)'], ['last_seen_at', 'Последний вход (UTC)']]
    ],
    reviews: [
      `SELECT r.id, s.name service, r.user_id, u.username, r.rating, r.status, r.text, datetime(r.created_at / 1000, 'unixepoch') created_at
       FROM reviews r JOIN services s ON s.id = r.service_id JOIN users u ON u.id = r.user_id ORDER BY r.id`,
      [['id', 'ID'], ['service', 'Сервис'], ['user_id', 'Telegram ID'], ['username', 'Username'], ['rating', 'Оценка'], ['status', 'Статус'], ['text', 'Текст'], ['created_at', 'Создан (UTC)']]
    ],
    clicks: [
      `SELECT c.id, s.name service, c.user_id, c.source, datetime(c.created_at / 1000, 'unixepoch') created_at
       FROM clicks c JOIN services s ON s.id = c.service_id ORDER BY c.id`,
      [['id', 'ID'], ['service', 'Сервис'], ['user_id', 'Telegram ID'], ['source', 'Откуда'], ['created_at', 'Время (UTC)']]
    ]
  };

  r.get('/api/admin/export/:kind', (ctx) => {
    const a = admin(ctx);
    const kind = String(ctx.params.kind).replace(/\.csv$/, '');
    const spec = EXPORTS[kind];
    if (!spec) throw notFound('Нет такой выгрузки');
    audit(db, a.id, 'export', 'export', null, { kind });
    return new RawResponse(toCsv(db.all(spec[0]), spec[1]), {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="linza-${kind}-${mskDay()}.csv"`
    });
  });
}
