import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { now } from './time.js';
import { badRequest, forbidden, notFound, HttpError } from './http.js';
import { grantRole } from '../auth.js';
import { invalidate, monthlyOf, recomputeMarketAverage, rowToCard, tariffsOf } from './catalog.js';
import { enqueue, notifyFavorites } from './notify.js';

export const html = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const rub = (n) => `${n.toLocaleString('ru-RU')} ₽`;
const dateRu = (ts) => new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' });

export function audit(db, adminId, action, entityType, entityId, details = null) {
  db.run('INSERT INTO audit_log (admin_id, action, entity_type, entity_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    adminId, action, entityType, entityId, details ? JSON.stringify(details) : null, now());
}

function pendingOrThrow(row, what) {
  if (!row) throw notFound(`${what} не найдена`);
  if (row.status !== 'pending') throw new HttpError(409, `${what} уже рассмотрена`, 'conflict');
  return row;
}

export function ownedService(db, user, serviceId) {
  const s = db.get('SELECT * FROM services WHERE id = ?', serviceId);
  if (!s) throw notFound('Сервис не найден');
  if (s.owner_id !== user.id) throw forbidden('Это не ваш сервис');
  return s;
}

/* ---------------- Applications: "Добавить VPN" ---------------- */

export function createApplication(db, user, data) {
  const pending = db.get("SELECT COUNT(*) n FROM applications WHERE user_id = ? AND status = 'pending'", user.id).n;
  if (pending >= 3) throw badRequest('У вас уже есть заявки на проверке');
  const dup = db.get("SELECT id FROM applications WHERE link = ? AND status IN ('pending', 'approved')", data.link);
  if (dup) throw badRequest('Этот бот или канал уже подан на подключение');
  const r = db.run('INSERT INTO applications (user_id, name, link, contact, comment, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    user.id, data.name, data.link, data.contact, data.comment, now());
  return db.get('SELECT * FROM applications WHERE id = ?', r.lastInsertRowid);
}

export function approveApplication(db, admin, id) {
  return db.tx(() => {
    const app = pendingOrThrow(db.get('SELECT * FROM applications WHERE id = ?', id), 'Заявка');
    const ts = now();
    const svc = db.run('INSERT INTO services (owner_id, status, name, bot_url, created_at) VALUES (?, ?, ?, ?, ?)',
      app.user_id, 'draft', app.name, app.link, ts);
    const serviceId = Number(svc.lastInsertRowid);
    db.run("UPDATE applications SET status = 'approved', service_id = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?", serviceId, admin.id, ts, id);
    grantRole(db, app.user_id, 'vpn_owner');
    audit(db, admin.id, 'application.approve', 'application', id, { service_id: serviceId, name: app.name });
    enqueue(db, app.user_id, 'moderation',
      `✅ Заявка «${html(app.name)}» одобрена. Кабинет VPN-сервиса открыт: заполните карточку и тарифы — после модерации они появятся в каталоге.`, `owner_${serviceId}`);
    return { service_id: serviceId };
  });
}

export function rejectApplication(db, admin, id, reason) {
  return db.tx(() => {
    const app = pendingOrThrow(db.get('SELECT * FROM applications WHERE id = ?', id), 'Заявка');
    db.run("UPDATE applications SET status = 'rejected', reject_reason = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?", reason, admin.id, now(), id);
    audit(db, admin.id, 'application.reject', 'application', id, { reason, name: app.name });
    enqueue(db, app.user_id, 'moderation', `❌ Заявка «${html(app.name)}» отклонена.\nПричина: ${html(reason)}`, 'owner');
  });
}

/* ---------------- Card revisions ---------------- */

export function submitRevision(db, user, serviceId, card) {
  ownedService(db, user, serviceId);
  return db.tx(() => {
    // Only the latest submission matters; older pending ones are replaced.
    db.run("UPDATE service_revisions SET status = 'superseded' WHERE service_id = ? AND status = 'pending'", serviceId);
    const r = db.run('INSERT INTO service_revisions (service_id, author_id, data, created_at) VALUES (?, ?, ?, ?)',
      serviceId, user.id, JSON.stringify(card), now());
    return Number(r.lastInsertRowid);
  });
}

function saveLogo(uploadsDir, serviceId, dataUrl) {
  const m = dataUrl.match(/^data:image\/(png|jpeg|webp);base64,(.+)$/);
  if (!m) return dataUrl; // already a stored /uploads path
  const buf = Buffer.from(m[2], 'base64');
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const name = `logo-${serviceId}-${createHash('sha256').update(buf).digest('hex').slice(0, 10)}.${ext}`;
  mkdirSync(uploadsDir, { recursive: true });
  writeFileSync(join(uploadsDir, name), buf);
  return `/uploads/${name}`;
}

// Writes an approved card into the services row. Used by moderation and by the seed script.
export function applyCard(db, serviceId, card, { uploadsDir } = {}) {
  const ts = now();
  const { min, base } = monthlyOf(card.tariffs);
  const logo = card.logo && uploadsDir ? saveLogo(uploadsDir, serviceId, card.logo) : card.logo && card.logo.startsWith('/uploads/') ? card.logo : null;
  db.run(
    `UPDATE services SET name = ?, description = ?, logo_url = ?, bot_url = ?, channel_url = ?, support_contact = ?,
       devices = ?, protocols = ?, countries = ?, platforms = ?, payments = ?, whitelist_bypass = ?, whitelist_note = ?,
       trial = ?, trial_days = ?, trial_terms = ?, min_monthly = ?, base_monthly = ?, status = 'published',
       published_at = COALESCE(published_at, ?), updated_at = ?
     WHERE id = ?`,
    card.name, card.description || '', logo, card.bot_url, card.channel_url, card.support_contact,
    card.devices, JSON.stringify(card.protocols), JSON.stringify(card.countries), JSON.stringify(card.platforms),
    JSON.stringify(card.payments), card.whitelist_bypass, card.whitelist_note, card.trial, card.trial_days, card.trial_terms,
    min, base, ts, ts, serviceId);
  db.run('DELETE FROM tariffs WHERE service_id = ?', serviceId);
  for (const [m, p] of Object.entries(card.tariffs)) db.run('INSERT INTO tariffs (service_id, months, price) VALUES (?, ?, ?)', serviceId, Number(m), p);
  return { min, base, logo };
}

export function approveRevision(db, admin, revId, { uploadsDir }) {
  return db.tx(() => {
    const rev = pendingOrThrow(db.get('SELECT * FROM service_revisions WHERE id = ?', revId), 'Версия карточки');
    const before = db.get('SELECT * FROM services WHERE id = ?', rev.service_id);
    const card = JSON.parse(rev.data);
    const { min } = applyCard(db, rev.service_id, card, { uploadsDir });
    const ts = now();
    db.run("UPDATE service_revisions SET status = 'approved', reviewed_by = ?, reviewed_at = ? WHERE id = ?", admin.id, ts, revId);
    recomputeMarketAverage(db);
    audit(db, admin.id, 'revision.approve', 'service', rev.service_id, { revision_id: revId });

    const first = before.status !== 'published';
    enqueue(db, before.owner_id, 'moderation',
      first ? `✅ Карточка «${html(card.name)}» опубликована в каталоге Линзы.` : `✅ Изменения карточки «${html(card.name)}» опубликованы.`,
      `owner_${rev.service_id}`);
    if (!first && before.min_monthly && min < before.min_monthly) {
      notifyFavorites(db, rev.service_id, 'price_drop',
        `📉 <b>${html(card.name)}</b> подешевел: от ${rub(min)}/мес вместо ${rub(before.min_monthly)}.`, `s_${rev.service_id}`);
    }
    return { service_id: rev.service_id };
  });
}

export function rejectRevision(db, admin, revId, reason) {
  return db.tx(() => {
    const rev = pendingOrThrow(db.get('SELECT * FROM service_revisions WHERE id = ?', revId), 'Версия карточки');
    db.run("UPDATE service_revisions SET status = 'rejected', reject_reason = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?", reason, admin.id, now(), revId);
    const svc = db.get('SELECT owner_id, name FROM services WHERE id = ?', rev.service_id);
    audit(db, admin.id, 'revision.reject', 'service', rev.service_id, { revision_id: revId, reason });
    enqueue(db, svc.owner_id, 'moderation', `❌ Изменения карточки «${html(svc.name)}» отклонены.\nПричина: ${html(reason)}`, `owner_${rev.service_id}`);
  });
}

const eq = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// Field-level "было / стало" for the moderation queue.
export function revisionDiff(db, rev) {
  const svc = db.get('SELECT * FROM services WHERE id = ?', rev.service_id);
  const after = JSON.parse(rev.data);
  const before = svc.status === 'published' ? rowToCard(svc, tariffsOf(db, svc.id)) : null;
  const changed = before ? Object.keys(after).filter((k) => !eq(before[k], after[k])) : Object.keys(after);
  return { before, after, changed, is_new: !before };
}

/* ---------------- Promotions ---------------- */

export function createPromo(db, user, serviceId, data) {
  const s = ownedService(db, user, serviceId);
  if (s.status !== 'published') throw badRequest('Акции доступны после публикации карточки');
  const active = db.get("SELECT COUNT(*) n FROM promotions WHERE service_id = ? AND status IN ('pending', 'approved') AND ends_at > ?", serviceId, now()).n;
  if (active >= 5) throw badRequest('Не больше 5 активных акций одновременно');
  const r = db.run(
    'INSERT INTO promotions (service_id, title, description, discount_percent, promo_code, starts_at, ends_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    serviceId, data.title, data.description, data.discount_percent, data.promo_code, data.starts_at, data.ends_at, now());
  return db.get('SELECT * FROM promotions WHERE id = ?', r.lastInsertRowid);
}

export function approvePromo(db, admin, id) {
  return db.tx(() => {
    const p = pendingOrThrow(db.get('SELECT * FROM promotions WHERE id = ?', id), 'Акция');
    const ts = now();
    if (p.ends_at <= ts) throw badRequest('Срок акции уже истёк');
    db.run("UPDATE promotions SET status = 'approved', reviewed_by = ?, reviewed_at = ? WHERE id = ?", admin.id, ts, id);
    const svc = db.get('SELECT owner_id, name FROM services WHERE id = ?', p.service_id);
    audit(db, admin.id, 'promo.approve', 'promotion', id, { service_id: p.service_id, title: p.title });
    enqueue(db, svc.owner_id, 'moderation', `✅ Акция «${html(p.title)}» одобрена и появится в блоке «Скидки и акции».`, `owner_${p.service_id}`);
    const when = p.starts_at > ts ? ` с ${dateRu(p.starts_at)}` : '';
    notifyFavorites(db, p.service_id, 'promo',
      `🏷 Акция у <b>${html(svc.name)}</b>${when}: ${html(p.title)}${p.discount_percent ? ` (−${p.discount_percent}%)` : ''}. До ${dateRu(p.ends_at)}.`, `s_${p.service_id}`);
    invalidate();
  });
}

export function rejectPromo(db, admin, id, reason) {
  return db.tx(() => {
    const p = pendingOrThrow(db.get('SELECT * FROM promotions WHERE id = ?', id), 'Акция');
    db.run("UPDATE promotions SET status = 'rejected', reject_reason = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?", reason, admin.id, now(), id);
    const svc = db.get('SELECT owner_id FROM services WHERE id = ?', p.service_id);
    audit(db, admin.id, 'promo.reject', 'promotion', id, { reason, title: p.title });
    enqueue(db, svc.owner_id, 'moderation', `❌ Акция «${html(p.title)}» отклонена.\nПричина: ${html(reason)}`, `owner_${p.service_id}`);
  });
}

export function cancelPromo(db, user, id) {
  const p = db.get('SELECT * FROM promotions WHERE id = ?', id);
  if (!p) throw notFound('Акция не найдена');
  ownedService(db, user, p.service_id);
  if (!['pending', 'approved'].includes(p.status)) throw badRequest('Акция уже не активна');
  db.run("UPDATE promotions SET status = 'cancelled' WHERE id = ?", id);
  invalidate();
}

// Promotions are taken off automatically once their end date passes.
export function expirePromos(db) {
  const r = db.run("UPDATE promotions SET status = 'expired' WHERE status = 'approved' AND ends_at <= ?", now());
  if (r.changes) invalidate();
  return r.changes;
}

/* ---------------- Reviews ---------------- */

export function canReview(db, userId, serviceId) {
  return Boolean(db.get('SELECT 1 FROM clicks WHERE user_id = ? AND service_id = ? LIMIT 1', userId, serviceId));
}

export function upsertReview(db, user, serviceId, data) {
  const svc = db.get("SELECT id FROM services WHERE id = ? AND status = 'published'", serviceId);
  if (!svc) throw notFound('Сервис не найден');
  if (!canReview(db, user.id, serviceId)) throw forbidden('Отзыв можно оставить после перехода в бот этого VPN через Линзу');
  const ts = now();
  db.run(
    `INSERT INTO reviews (service_id, user_id, rating, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(service_id, user_id) DO UPDATE SET rating = excluded.rating, text = excluded.text,
       status = 'pending', reject_reason = NULL, updated_at = excluded.updated_at`,
    serviceId, user.id, data.rating, data.text, ts, ts);
  invalidate();
  return db.get('SELECT * FROM reviews WHERE service_id = ? AND user_id = ?', serviceId, user.id);
}

export function deleteReview(db, user, id) {
  const r = db.run('DELETE FROM reviews WHERE id = ? AND user_id = ?', id, user.id);
  if (!r.changes) throw notFound('Отзыв не найден');
  invalidate();
}

export function moderateReview(db, admin, id, approve, reason = null) {
  return db.tx(() => {
    const r = pendingOrThrow(db.get('SELECT * FROM reviews WHERE id = ?', id), 'Отзыв');
    db.run('UPDATE reviews SET status = ?, reject_reason = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?',
      approve ? 'approved' : 'rejected', reason, admin.id, now(), id);
    audit(db, admin.id, approve ? 'review.approve' : 'review.reject', 'review', id, { service_id: r.service_id, reason });
    invalidate();
  });
}
