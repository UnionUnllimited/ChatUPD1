import { tg } from './tg.js';

// Outside Telegram the server may run with ALLOW_DEV_AUTH; then ?dev=<id> picks the test account.
function devUserId() {
  const q = new URLSearchParams(location.search).get('dev');
  try {
    if (q) localStorage.setItem('linza_dev_user', q);
    return q || localStorage.getItem('linza_dev_user') || '100001';
  } catch { return q || '100001'; }
}

const authHeader = tg ? `tma ${tg.initData}` : `dev ${devUserId()}`;

export class ApiError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

export async function api(path, { method = 'GET', body, keepalive = false } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      keepalive,
      headers: { authorization: authHeader, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch {
    throw new ApiError(0, 'Нет соединения с сервером');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || 'Ошибка сервера', data.code);
  return data;
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
