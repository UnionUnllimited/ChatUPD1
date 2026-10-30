import { now } from './time.js';

// Types a user can switch off in the profile. Moderation statuses are always delivered.
export const OPTIONAL_TYPES = ['price_drop', 'promo', 'top'];

export function notifySettings(db, userId) {
  const rows = new Map(db.all('SELECT type, enabled FROM user_notify WHERE user_id = ?', userId).map((r) => [r.type, r.enabled]));
  return Object.fromEntries(OPTIONAL_TYPES.map((t) => [t, rows.has(t) ? Boolean(rows.get(t)) : true]));
}

export function setNotifySettings(db, userId, patch) {
  for (const t of OPTIONAL_TYPES) {
    if (typeof patch[t] !== 'boolean') continue;
    db.run('INSERT INTO user_notify (user_id, type, enabled) VALUES (?, ?, ?) ON CONFLICT(user_id, type) DO UPDATE SET enabled = excluded.enabled', userId, t, patch[t]);
  }
  return notifySettings(db, userId);
}

export function enqueue(db, userId, type, text, startParam = null) {
  db.run('INSERT INTO notifications (user_id, type, text, start_param, created_at) VALUES (?, ?, ?, ?, ?)', userId, type, text, startParam, now());
}

const enabledFilter = `NOT EXISTS (SELECT 1 FROM user_notify n WHERE n.user_id = u.id AND n.type = ? AND n.enabled = 0)`;

export function notifyFavorites(db, serviceId, type, text, startParam) {
  const users = db.all(
    `SELECT u.id FROM favorites f JOIN users u ON u.id = f.user_id
     WHERE f.service_id = ? AND u.is_blocked = 0 AND ${enabledFilter}`, serviceId, type);
  for (const u of users) enqueue(db, u.id, type, text, startParam);
  return users.length;
}

export function notifyEveryone(db, type, text, startParam) {
  const users = db.all(`SELECT u.id FROM users u WHERE u.is_blocked = 0 AND u.bot_chat_allowed = 1 AND ${enabledFilter}`, type);
  for (const u of users) enqueue(db, u.id, type, text, startParam);
  return users.length;
}

// Sends a batch from the outbox; called every second by the scheduler.
// Telegram allows ~30 messages/s per bot, so the batch stays below that.
export async function flushOutbox(db, bot, limit = 25) {
  if (!bot.enabled) return 0;
  const batch = db.all(
    `SELECT n.*, u.bot_chat_allowed FROM notifications n JOIN users u ON u.id = n.user_id
     WHERE n.status = 'queued' ORDER BY n.id LIMIT ?`, limit);
  for (const n of batch) {
    if (!n.bot_chat_allowed) {
      db.run("UPDATE notifications SET status = 'skipped', error = 'bot not started' WHERE id = ?", n.id);
      continue;
    }
    try {
      await bot.sendAppMessage(n.user_id, n.text, n.start_param);
      db.run("UPDATE notifications SET status = 'sent', sent_at = ? WHERE id = ?", now(), n.id);
    } catch (e) {
      if (e.retryAfter) return 0; // flood control: leave the rest queued
      if (e.code === 403) db.run('UPDATE users SET bot_chat_allowed = 0 WHERE id = ?', n.user_id);
      db.run("UPDATE notifications SET status = 'failed', error = ? WHERE id = ?", String(e.message).slice(0, 200), n.id);
    }
  }
  return batch.length;
}
