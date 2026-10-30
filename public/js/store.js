import { api, get, put, del } from './api.js';
import { haptic, requestWriteAccess } from './tg.js';
import { toast, toastError } from './ui.js';

const COMPARE_KEY = 'linza_compare';
export const COMPARE_MAX = 3;

function loadCompare() {
  try { return JSON.parse(localStorage.getItem(COMPARE_KEY) || '[]').filter(Number.isInteger).slice(0, COMPARE_MAX); } catch { return []; }
}

const listeners = new Set();
export const store = {
  me: null,
  meError: null,
  favorites: new Set(),
  compare: loadCompare(),
  catalogQuery: {},
  lastTab: '/'
};

export const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = (what) => listeners.forEach((fn) => fn(what));

export async function loadMe() {
  try {
    store.me = await get('/api/me');
    store.favorites = new Set(store.me.favorites);
    store.meError = null;
  } catch (e) {
    store.me = null;
    store.meError = e;
  }
  emit('me');
  return store.me;
}

export const hasRole = (role) => Boolean(store.me?.roles.includes(role));

// The bot can write only to people who started it or allowed messages. Asked right where a reply
// is promised (an application, a listed channel, a booking), never on a plain visit.
export async function ensureBotChat() {
  if (!store.me || store.me.bot_chat_allowed) return true;
  const ok = await requestWriteAccess();
  if (ok) {
    await api('/api/me/bot-access', { method: 'POST' }).catch(() => {});
    store.me.bot_chat_allowed = true;
  }
  return ok;
}

export async function toggleFavorite(id) {
  if (!store.me) { toast('Откройте Линзу в Telegram, чтобы сохранять избранное'); return false; }
  const had = store.favorites.has(id);
  haptic.impact(had ? 'light' : 'medium');
  had ? store.favorites.delete(id) : store.favorites.add(id);
  emit('favorites');
  try {
    had ? await del(`/api/me/favorites/${id}`) : await put(`/api/me/favorites/${id}`);
    toast(had ? 'Удалено из избранного' : 'В избранном — сообщим о скидках');
  } catch (e) {
    had ? store.favorites.add(id) : store.favorites.delete(id);
    emit('favorites');
    toastError(e);
  }
  return !had;
}

export function toggleCompare(id) {
  const i = store.compare.indexOf(id);
  if (i >= 0) store.compare.splice(i, 1);
  else {
    if (store.compare.length >= COMPARE_MAX) { toast(`Сравнить можно до ${COMPARE_MAX} VPN — уберите один`, 'error'); return false; }
    store.compare.push(id);
  }
  haptic.select();
  try { localStorage.setItem(COMPARE_KEY, JSON.stringify(store.compare)); } catch {}
  emit('compare');
  if (i < 0) toast(`Добавлено к сравнению (${store.compare.length} из ${COMPARE_MAX})`);
  return i < 0;
}

export function removeFromCompare(id) {
  store.compare = store.compare.filter((x) => x !== id);
  try { localStorage.setItem(COMPARE_KEY, JSON.stringify(store.compare)); } catch {}
  emit('compare');
}

/* ---------- Impressions & views, sent in batches ---------- */
const seen = new Set();
const queue = { impressions: new Set(), views: new Set() };
let observer = null;

function flush(keepalive = false) {
  if (!store.me || (!queue.impressions.size && !queue.views.size)) return;
  const body = { impressions: [...queue.impressions], views: [...queue.views] };
  queue.impressions.clear();
  queue.views.clear();
  api('/api/events', { method: 'POST', body, keepalive }).catch(() => {});
}
setInterval(flush, 5000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(true); });

export function trackImpressions(root) {
  if (!('IntersectionObserver' in window)) return;
  observer ||= new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const id = Number(e.target.dataset.impression);
      observer.unobserve(e.target);
      if (seen.has(id)) continue;
      seen.add(id);
      queue.impressions.add(id);
    }
  }, { threshold: 0.6 });
  root.querySelectorAll('[data-impression]').forEach((el) => observer.observe(el));
}

export function trackView(id) { queue.views.add(id); }
