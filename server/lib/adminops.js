// Operations available only in the admin panel: direct card editing, ownership,
// roles, broadcasts and launch housekeeping. Every change lands in the audit log.
import { now } from './time.js';
import { badRequest, notFound } from './http.js';
import { applyCard, audit, html } from './moderation.js';
import { recomputeMarketAverage, rowToCard, tariffsOf, invalidate } from './catalog.js';
import { enqueue, notifyFavorites } from './notify.js';
import { grantRole, loadUser } from '../auth.js';
import { refreshClaimStatus } from './claims.js';

const rub = (n) => `${n.toLocaleString('ru-RU')} ₽`;
const eq = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// Admins can publish cards themselves, e.g. to seed the catalog before owners join. Such a card
// is marked «Добавлено Линзой» with the date its data was checked, until the owner claims it.
export function createService(db, admin, card, { uploadsDir, checkedAt = null }) {
  return db.tx(() => {
    if (db.get("SELECT id FROM services WHERE bot_url = ? AND status = 'published'", card.bot_url)) throw badRequest('Сервис с этим ботом уже есть в каталоге');
    const ts = now();
    const r = db.run("INSERT INTO services (owner_id, name, bot_url, added_by, claim_status, data_checked_at, created_at) VALUES (NULL, ?, ?, 'admin', 'unclaimed', ?, ?)",
      card.name, card.bot_url, checkedAt || ts, ts);
    const id = Number(r.lastInsertRowid);
    applyCard(db, id, card, { uploadsDir });
    recomputeMarketAverage(db);
    audit(db, admin.id, 'service.create', 'service', id, { name: card.name });
    return id;
  });
}

// Direct edit, bypassing moderation (the admin is the moderator). Owners are told.
export function editService(db, admin, id, card, { uploadsDir }) {
  return db.tx(() => {
    const before = db.get('SELECT * FROM services WHERE id = ?', id);
    if (!before) throw notFound('Сервис не найден');
    const prev = before.status === 'published' ? rowToCard(before, tariffsOf(db, id)) : null;
    const { min } = applyCard(db, id, card, { uploadsDir });
    // An admin edit of an unclaimed card is a fresh check of its data.
    if (!before.owner_id) db.run('UPDATE services SET data_checked_at = ? WHERE id = ?', now(), id);
    recomputeMarketAverage(db);
    const changed = prev ? Object.keys(card).filter((k) => !eq(prev[k], card[k])) : Object.keys(card);
    audit(db, admin.id, 'service.edit', 'service', id, { name: card.name, changed });
    if (before.owner_id) enqueue(db, before.owner_id, 'moderation', `✏️ Администратор обновил карточку «${html(card.name)}».`, `owner_${id}`);
    if (prev && before.min_monthly && min < before.min_monthly) {
      notifyFavorites(db, id, 'price_drop', `📉 <b>${html(card.name)}</b> подешевел: от ${rub(min)}/мес вместо ${rub(before.min_monthly)}.`, `s_${id}`);
    }
    return { changed };
  });
}

export function assignOwner(db, admin, id, userId) {
  return db.tx(() => {
    const svc = db.get('SELECT id, name, owner_id FROM services WHERE id = ?', id);
    if (!svc) throw notFound('Сервис не найден');
    if (userId === null) {
      db.run('UPDATE services SET owner_id = NULL WHERE id = ?', id);
      refreshClaimStatus(db, id);
      audit(db, admin.id, 'service.owner', 'service', id, { name: svc.name, from: svc.owner_id, to: null });
      return;
    }
    if (!db.get('SELECT 1 FROM users WHERE id = ?', userId)) throw badRequest('Пользователь ещё не открывал Линзу — попросите его зайти в приложение');
    db.run("UPDATE services SET owner_id = ?, claim_status = 'claimed' WHERE id = ?", userId, id);
    grantRole(db, userId, 'vpn_owner');
    db.run("UPDATE service_claims SET status = 'superseded', decided_at = ? WHERE service_id = ? AND status IN ('invited', 'pending', 'manual', 'dispute')", now(), id);
    audit(db, admin.id, 'service.owner', 'service', id, { name: svc.name, from: svc.owner_id, to: userId });
    enqueue(db, userId, 'moderation', `🔑 Вам передан кабинет сервиса «${html(svc.name)}» в Линзе. Изменения карточки публикуются после модерации.`, `owner_${id}`);
  });
}

export function deleteService(db, admin, id, confirmName) {
  return db.tx(() => {
    const svc = db.get('SELECT id, name FROM services WHERE id = ?', id);
    if (!svc) throw notFound('Сервис не найден');
    if (String(confirmName || '').trim() !== svc.name) throw badRequest('Для удаления введите точное название сервиса');
    db.run('UPDATE applications SET service_id = NULL WHERE service_id = ?', id);
    db.run('DELETE FROM services WHERE id = ?', id);
    db.run('DELETE FROM top_snapshots WHERE period NOT IN (SELECT DISTINCT period FROM top_entries)');
    recomputeMarketAverage(db);
    audit(db, admin.id, 'service.delete', 'service', id, { name: svc.name });
  });
}

export const MANAGED_ROLES = ['admin', 'vpn_owner'];

export function setRole(db, admin, userId, role, grant, envAdmins) {
  if (!MANAGED_ROLES.includes(role)) throw badRequest('Неизвестная роль');
  if (!db.get('SELECT 1 FROM users WHERE id = ?', userId)) throw notFound('Пользователь не найден');
  if (!grant && role === 'admin') {
    if (envAdmins.includes(userId)) throw badRequest('Этот администратор задан в ADMIN_IDS на сервере — снять роль можно только там');
    if (userId === admin.id) throw badRequest('Нельзя снять роль администратора с себя');
  }
  if (grant) grantRole(db, userId, role);
  else {
    db.run('DELETE FROM user_roles WHERE user_id = ? AND role = ?', userId, role);
    if (role === 'admin') db.run('DELETE FROM admin_sessions WHERE user_id = ?', userId);
  }
  audit(db, admin.id, grant ? 'role.grant' : 'role.revoke', 'user', userId, { role });
  return loadUser(db, userId, envAdmins).roles;
}

const AUDIENCES = {
  all: '1 = 1',
  owners: "EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role = 'vpn_owner')",
  clients: "NOT EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role = 'vpn_owner')"
};

// Platform news through the bot. Respects the "Новости Линзы" opt-out and only reaches
// users the bot may write to; delivery goes through the rate-limited outbox.
export function broadcast(db, admin, { text, audience = 'all', dryRun = false }) {
  const body = String(text || '').trim();
  if (body.length < 5) throw badRequest('Напишите текст сообщения');
  if (body.length > 3000) throw badRequest('Сообщение длиннее 3000 символов');
  if (!AUDIENCES[audience]) throw badRequest('Неизвестная аудитория');
  const recipients = db.all(
    `SELECT u.id FROM users u WHERE u.is_blocked = 0 AND u.bot_chat_allowed = 1 AND ${AUDIENCES[audience]}
       AND NOT EXISTS (SELECT 1 FROM user_notify n WHERE n.user_id = u.id AND n.type = 'news' AND n.enabled = 0)`);
  if (dryRun) return { recipients: recipients.length };
  db.tx(() => {
    for (const r of recipients) enqueue(db, r.id, 'news', html(body), null);
    audit(db, admin.id, 'broadcast.send', 'broadcast', null, { audience, recipients: recipients.length, preview: body.slice(0, 120) });
  });
  return { recipients: recipients.length };
}

// Before launch: drop everything created by `npm run seed` (fictional services and users).
const DEMO_USER_MIN = 9_000_000_000_000;
export function purgeDemo(db, admin) {
  return db.tx(() => {
    const services = db.all("SELECT id FROM services WHERE bot_url LIKE 'https://t.me/linza_demo_%'").map((s) => s.id);
    for (const id of services) {
      db.run('UPDATE applications SET service_id = NULL WHERE service_id = ?', id);
      db.run('DELETE FROM services WHERE id = ?', id);
    }
    const users = db.get('SELECT COUNT(*) n FROM users WHERE id >= ?', DEMO_USER_MIN).n;
    // Ad exchange: demo channels (cascades to their deals and reviews) and everything demo users did there.
    db.run("DELETE FROM ad_channels WHERE owner_id >= ? OR link LIKE 'https://t.me/linza_demo_%'", DEMO_USER_MIN);
    db.run('DELETE FROM ad_deals WHERE buyer_id >= ? OR seller_id >= ?', DEMO_USER_MIN, DEMO_USER_MIN);
    for (const table of ['ad_reviews', 'ad_complaints', 'ad_favorites', 'status_votes']) {
      db.run(`DELETE FROM ${table} WHERE ${table === 'ad_reviews' ? 'buyer_id' : 'user_id'} >= ?`, DEMO_USER_MIN);
    }
    db.run('DELETE FROM status_disputes WHERE owner_id >= ?', DEMO_USER_MIN);
    db.run('DELETE FROM claim_checks WHERE user_id >= ?', DEMO_USER_MIN);
    db.run('DELETE FROM service_claims WHERE user_id >= ? OR decided_by >= ?', DEMO_USER_MIN, DEMO_USER_MIN);
    for (const table of ['reviews', 'clicks', 'favorites', 'user_roles', 'user_notify', 'applications', 'service_revisions', 'notifications']) {
      const col = table === 'service_revisions' ? 'author_id' : 'user_id';
      db.run(`DELETE FROM ${table} WHERE ${col} >= ?`, DEMO_USER_MIN);
    }
    db.run("DELETE FROM applications WHERE link LIKE 'https://t.me/linza_demo_%'");
    db.run('UPDATE services SET owner_id = NULL WHERE owner_id >= ?', DEMO_USER_MIN);
    db.run('DELETE FROM users WHERE id >= ?', DEMO_USER_MIN);
    db.run('DELETE FROM top_snapshots WHERE period NOT IN (SELECT DISTINCT period FROM top_entries)');
    recomputeMarketAverage(db);
    invalidate();
    audit(db, admin.id, 'maintenance.purge_demo', 'maintenance', null, { services: services.length, users });
    return { services: services.length, users };
  });
}

export function toCsv(rows, columns) {
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // Semicolons and a BOM so Excel with a Russian locale opens it correctly.
  return '﻿' + [columns.map(([, title]) => title).join(';'), ...rows.map((r) => columns.map(([key]) => cell(r[key])).join(';'))].join('\r\n');
}
