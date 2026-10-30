import { tg } from './tg.js';

// Outside Telegram the server may run with ALLOW_DEV_AUTH; then ?dev=<id> picks the test account.
function devUserId() {
  const q = new URLSearchParams(location.search).get('dev');
  try {
    if (q) localStorage.setItem('linza_dev_user', q);
    return q || localStorage.getItem('linza_dev_user') || '100001';
  } catch { return q || '100001'; }
}

// Admin panel in a browser: a session from the bot's one-time /admin link.
const SESSION_KEY = 'linza_admin_session';
export function adminSession() {
  try { return localStorage.getItem(SESSION_KEY); } catch { return null; }
}
export function setAdminSession(token) {
  try { token ? localStorage.setItem(SESSION_KEY, token) : localStorage.removeItem(SESSION_KEY); } catch {}
}

function authHeader() {
  if (tg) return `tma ${tg.initData}`;
  const session = adminSession();
  return session ? `Session ${session}` : `dev ${devUserId()}`;
}

// The app may live at the domain root or under a path such as /linza/ (behind a shared proxy),
// and the admin panel is one level deeper (/linza/admin/). This module sits in <app>/js/,
// so "/api/..." and "/uploads/..." resolve against its parent directory on every page.
const BASE = new URL('../', import.meta.url);
export const appUrl = (path) => new URL(String(path).replace(/^\//, ''), BASE).toString();
export const asset = (url) => (typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') ? appUrl(url) : url);

export class ApiError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

export async function api(path, { method = 'GET', body, keepalive = false } = {}) {
  let res;
  try {
    res = await fetch(appUrl(path), {
      method,
      keepalive,
      headers: { authorization: authHeader(), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch {
    throw new ApiError(0, 'Нет соединения с сервером');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || 'Ошибка сервера', data.code);
  return data;
}

// Authenticated file download (CSV exports).
export async function download(path, filename) {
  const res = await fetch(appUrl(path), { headers: { authorization: authHeader() } });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data.error || 'Не удалось скачать файл', data.code);
  }
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export const get = (path) => api(path);
export const post = (path, body = {}) => api(path, { method: 'POST', body });
export const put = (path, body = {}) => api(path, { method: 'PUT', body });
export const patch = (path, body = {}) => api(path, { method: 'PATCH', body });
export const del = (path) => api(path, { method: 'DELETE' });

export function qs(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === '' || v === false || (Array.isArray(v) && !v.length)) continue;
    p.set(k, Array.isArray(v) ? v.join(',') : v === true ? '1' : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}
