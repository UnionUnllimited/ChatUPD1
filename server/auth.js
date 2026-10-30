import { createHmac, timingSafeEqual } from 'node:crypto';
import { now } from './lib/time.js';

// Validates Telegram WebApp initData as described in
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
export function validateInitData(initData, botToken, maxAgeSec, nowSec = Math.floor(now() / 1000)) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(dataCheckString).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) return null;

  const authDate = Number(params.get('auth_date'));
  if (!authDate || nowSec - authDate > maxAgeSec) return null;

  let user = null;
  try { user = JSON.parse(params.get('user') || 'null'); } catch { return null; }
  if (!user || !Number.isSafeInteger(user.id)) return null;
  return { user, authDate, startParam: params.get('start_param') || null };
}

// Test/dev helper: produce initData signed with the given token.
export function signInitData(fields, botToken) {
  const params = new URLSearchParams(fields);
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', createHmac('sha256', secret).update(dataCheckString).digest('hex'));
  return params.toString();
}

export function upsertUser(db, tgUser) {
  const ts = now();
  db.run(
    `INSERT INTO users (id, username, first_name, last_name, photo_url, language_code, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       username = excluded.username, first_name = excluded.first_name, last_name = excluded.last_name,
       photo_url = COALESCE(excluded.photo_url, users.photo_url), language_code = excluded.language_code,
       last_seen_at = excluded.last_seen_at`,
    tgUser.id, tgUser.username || null, String(tgUser.first_name || '').slice(0, 128), tgUser.last_name || null,
    tgUser.photo_url || null, tgUser.language_code || null, ts, ts
  );
  if (tgUser.allows_write_to_pm) db.run('UPDATE users SET bot_chat_allowed = 1 WHERE id = ?', tgUser.id);
}

export function loadUser(db, id, adminIds = []) {
  const user = db.get('SELECT * FROM users WHERE id = ?', id);
  if (!user) return null;
  const roles = new Set(['client', ...db.all('SELECT role FROM user_roles WHERE user_id = ?', id).map((r) => r.role)]);
  if (adminIds.includes(id)) roles.add('admin');
  return { ...user, roles: [...roles] };
}

export function grantRole(db, userId, role) {
  db.run('INSERT OR IGNORE INTO user_roles (user_id, role, granted_at) VALUES (?, ?, ?)', userId, role, now());
}

// Resolves the caller from the Authorization header: "tma <initData>" in production,
// "dev <telegramId>" only when ALLOW_DEV_AUTH is on.
export function authenticate(db, config, header) {
  if (!header) return null;
  const space = header.indexOf(' ');
  const scheme = header.slice(0, space);
  const value = header.slice(space + 1);
  if (scheme === 'tma') {
    const data = validateInitData(value, config.botToken, config.initDataMaxAgeSec);
    if (!data) return null;
    upsertUser(db, data.user);
    return loadUser(db, data.user.id, config.adminIds);
  }
  if (scheme === 'dev' && config.allowDevAuth) {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    if (!db.get('SELECT id FROM users WHERE id = ?', id)) upsertUser(db, { id, first_name: 'Тестовый', username: `dev${id}` });
    else db.run('UPDATE users SET last_seen_at = ? WHERE id = ?', now(), id);
    return loadUser(db, id, config.adminIds);
  }
  return null;
}
