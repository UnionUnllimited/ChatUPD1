export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || null;
  }
}

export const badRequest = (msg) => new HttpError(400, msg, 'bad_request');
export const forbidden = (msg = 'Нет доступа') => new HttpError(403, msg, 'forbidden');
export const notFound = (msg = 'Не найдено') => new HttpError(404, msg, 'not_found');

export function requireUser(ctx) {
  if (!ctx.user) throw new HttpError(401, 'Откройте приложение через Telegram', 'unauthorized');
  if (ctx.user.is_blocked) throw forbidden('Аккаунт заблокирован');
  return ctx.user;
}

export function requireRole(ctx, role) {
  const user = requireUser(ctx);
  if (!user.roles.includes(role)) throw forbidden();
  return user;
}

// Tiny pattern router: "/api/services/:id" -> { id }.
export function createRouter() {
  const routes = [];
  const add = (method) => (pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, handler });
  };
  return {
    get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE'),
    match(method, path) {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = path.match(r.re);
        if (m) return { handler: r.handler, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
      }
      return null;
    }
  };
}

export const intParam = (v, name = 'id') => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw badRequest(`Неверный параметр ${name}`);
  return n;
};
