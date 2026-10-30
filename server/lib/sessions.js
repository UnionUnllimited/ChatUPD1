import { randomBytes, createHash } from 'node:crypto';
import { now } from './time.js';
import { badRequest } from './http.js';

const LOGIN_TTL = 10 * 60_000;
export const SESSION_TTL = 7 * 24 * 3600_000;

const hash = (token) => createHash('sha256').update(String(token)).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

// One-time link token sent by the bot to an admin; only its hash is stored.
export function createLoginToken(db, userId) {
  const token = newToken();
  const ts = now();
  db.run('DELETE FROM login_tokens WHERE expires_at < ? OR used_at IS NOT NULL', ts);
  db.run('INSERT INTO login_tokens (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', hash(token), userId, ts, ts + LOGIN_TTL);
  return token;
}

export function exchangeLoginToken(db, token, userAgent) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) throw badRequest('Ссылка для входа недействительна');
  return db.tx(() => {
    const ts = now();
    const row = db.get('SELECT * FROM login_tokens WHERE token_hash = ?', hash(token));
    if (!row || row.used_at || row.expires_at < ts) throw badRequest('Ссылка для входа устарела — запросите новую командой /admin');
    db.run('UPDATE login_tokens SET used_at = ? WHERE token_hash = ?', ts, row.token_hash);
    const session = newToken();
    db.run('INSERT INTO admin_sessions (token_hash, user_id, created_at, expires_at, last_used_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
      hash(session), row.user_id, ts, ts + SESSION_TTL, ts, String(userAgent || '').slice(0, 200));
    return { session, user_id: row.user_id, expires_at: ts + SESSION_TTL };
  });
}

export function sessionUserId(db, token) {
  const ts = now();
  const row = db.get('SELECT user_id, last_used_at FROM admin_sessions WHERE token_hash = ? AND expires_at > ?', hash(token), ts);
  if (!row) return null;
  if (!row.last_used_at || ts - row.last_used_at > 60_000) db.run('UPDATE admin_sessions SET last_used_at = ? WHERE token_hash = ?', ts, hash(token));
  return row.user_id;
}

export function endSession(db, token) {
  db.run('DELETE FROM admin_sessions WHERE token_hash = ?', hash(token));
}

export function listSessions(db, userId, currentToken) {
  const current = currentToken ? hash(currentToken) : null;
  return db.all('SELECT token_hash, created_at, expires_at, last_used_at, user_agent FROM admin_sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_used_at DESC', userId, now())
    .map(({ token_hash, ...s }) => ({ ...s, current: token_hash === current }));
}

export function endAllSessions(db, userId) {
  return db.run('DELETE FROM admin_sessions WHERE user_id = ?', userId).changes;
}
