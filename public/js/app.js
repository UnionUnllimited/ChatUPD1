import { initTelegram, startParam, setMain, haptic } from './tg.js';
import { $, $$, moveIndicator, applyLens, setRouteBack, closeSheet, sheetIsOpen, icon, errorHTML, toastError } from './ui.js';
import { appUrl } from './api.js';
import { store, subscribe, loadMe, toggleFavorite, toggleCompare } from './store.js';
import home from './views/home.js';
import catalog from './views/catalog.js';
import service from './views/service.js';
import compare from './views/compare.js';
import favorites from './views/favorites.js';
import { profile, myReviews, history as historyView, notifySettings } from './views/profile.js';
import { ownerHome, ownerApply, ownerService } from './views/owner.js';
import { topArchive } from './views/top.js';

const ROOT_TABS = ['/', '/catalog', '/compare', '/favorites', '/profile'];

// Admin screens live in the separate panel (public/admin/); old links land there.
function toPanel(root, { path, query }) {
  const q = new URLSearchParams(query).toString();
  location.replace(appUrl('admin/') + '#' + path + (q ? `?${q}` : ''));
}

const routes = [
  ['/', home], ['/catalog', catalog], ['/compare', compare], ['/favorites', favorites], ['/profile', profile],
  ['/service/:id', service], ['/top', topArchive], ['/top/:period', topArchive],
  ['/profile/reviews', myReviews], ['/profile/history', historyView], ['/profile/notify', notifySettings],
  ['/owner', ownerHome], ['/owner/apply', ownerApply], ['/owner/:id', ownerService],
  ['/admin', toPanel], ['/admin/:section', toPanel]
].map(([pattern, view]) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  return { re, keys, view };
});

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, q = ''] = raw.split('?');
  return { path: path || '/', query: Object.fromEntries(new URLSearchParams(q)) };
}

function tabFor(path) {
  if (ROOT_TABS.includes(path)) return path;
  if (path.startsWith('/top')) return '/';
  if (/^\/(profile|owner|admin)/.test(path)) return '/profile';
  return store.lastTab;
}

function parentOf(path) {
  if (path.startsWith('/admin/')) return '/admin';
  if (path.startsWith('/owner/')) return '/owner';
  if (path === '/owner' || path === '/admin' || path.startsWith('/profile/')) return '/profile';
  if (path.startsWith('/top/')) return '/top';
  return store.lastTab;
}

/* ---------------- Router with its own history index ---------------- */
// Telegram passes launch params in the URL hash (#tgWebAppData=…). The SDK has already
// read them, and the hash belongs to the router, so drop them before routing.
if (/^#tgWebApp/.test(location.hash)) history.replaceState(history.state, '', location.pathname + location.search);
let idx = history.state?.idx ?? 0;
let cleanup = null;
let renderSeq = 0;
const scrolls = new Map();
if (history.state?.idx === undefined) history.replaceState({ idx }, '', location.href);

export function navigate(to, { replace = false } = {}) {
  scrolls.set(idx, window.scrollY);
  if (replace) history.replaceState({ idx }, '', '#' + to);
  else history.pushState({ idx: ++idx }, '', '#' + to);
  render(false);
}

function goBack() {
  if (sheetIsOpen()) { closeSheet(); return; }
  haptic.impact('light');
  if (idx > 0) history.back();
  else navigate(parentOf(parseHash().path), { replace: true });
}

window.addEventListener('popstate', (e) => {
  if (sheetIsOpen()) closeSheet(true);
  scrolls.set(idx, window.scrollY);
  idx = e.state?.idx ?? 0;
  render(true);
});

async function render(restoreScroll) {
  const seq = ++renderSeq;
  const { path, query } = parseHash();
  let match = null;
  for (const r of routes) {
    const m = path.match(r.re);
    if (m) { match = { view: r.view, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) }; break; }
  }
  if (!match) { navigate('/', { replace: true }); return; }

  if (typeof cleanup === 'function') cleanup();
  cleanup = null;
  setMain(null);
  const tab = tabFor(path);
  if (ROOT_TABS.includes(path)) store.lastTab = path;
  if (path === '/catalog') store.catalogQuery = query;
  updateTabbar(tab);
  setRouteBack(ROOT_TABS.includes(path) ? null : goBack);

  const root = $('#view');
  root.innerHTML = '';
  root.classList.remove('mat');
  void root.offsetWidth;
  root.classList.add('mat');
  if (!restoreScroll) window.scrollTo(0, 0);

  const ctx = { params: match.params, query, path, navigate, refresh: () => render(true), isCurrent: () => seq === renderSeq };
  try {
    cleanup = await match.view(root, ctx);
  } catch (e) {
    if (seq === renderSeq) root.innerHTML = errorHTML(e);
  }
  if (seq !== renderSeq) { if (typeof cleanup === 'function') cleanup(); return; }
  if (restoreScroll && scrolls.has(idx)) requestAnimationFrame(() => window.scrollTo(0, scrolls.get(idx)));
  $$('.seg', root).forEach((s) => moveIndicator(s, false));
}

/* ---------------- Tab bar ---------------- */
function updateTabbar(tab) {
  const bar = $('.tabbar');
  $$('[data-nav]', bar).forEach((b) => b.setAttribute('aria-selected', b.dataset.nav === tab));
  moveIndicator(bar, true);
}
function updateCompareBadge() {
  const b = $('#cmpBadge');
  b.hidden = !store.compare.length;
  b.textContent = store.compare.length;
}

/* ---------------- Global interactions ---------------- */
document.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('.press, .seg > button');
  if (!el) return;
  const target = el.classList.contains('press') ? el : el.closest('.seg');
  const r = target.getBoundingClientRect();
  target.style.setProperty('--gx', ((e.clientX - r.left) / r.width) * 100 + '%');
  target.style.setProperty('--gy', ((e.clientY - r.top) / r.height) * 100 + '%');
  // Inner buttons press on their own; the card under them stays still.
  const inner = e.target.closest('button.press, a.press');
  (inner && inner !== el ? inner : el).classList.add('pressed');
}, { passive: true });
const release = () => $$('.pressed').forEach((el) => el.classList.remove('pressed'));
['pointerup', 'pointercancel', 'dragstart', 'scroll'].forEach((ev) => document.addEventListener(ev, release, { capture: true, passive: true }));

document.addEventListener('click', (e) => {
  const fav = e.target.closest('[data-fav]');
  if (fav) { e.stopPropagation(); toggleFavorite(Number(fav.dataset.fav)); return; }
  const cmp = e.target.closest('[data-cmp]');
  if (cmp) { e.stopPropagation(); toggleCompare(Number(cmp.dataset.cmp)); return; }
  const nav = e.target.closest('[data-nav]');
  if (nav) {
    e.preventDefault();
    const to = nav.dataset.nav;
    const current = parseHash().path;
    if (nav.closest('.tabbar')) {
      haptic.select();
      if (to === current) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
      if (to === '/catalog') {
        const q = new URLSearchParams(store.catalogQuery).toString();
        navigate(q ? `/catalog?${q}` : '/catalog');
        return;
      }
    }
    navigate(to);
    return;
  }
  const open = e.target.closest('[data-open]');
  if (open && !e.target.closest('a, input, label')) { haptic.impact('light'); navigate(`/service/${open.dataset.open}`); return; }
  if (e.target.closest('[data-action="reload"]')) render(true);
});

subscribe((what) => {
  if (what === 'favorites') {
    $$('[data-fav]').forEach((b) => {
      const on = store.favorites.has(Number(b.dataset.fav));
      if (b.getAttribute('aria-pressed') === String(on)) return;
      b.setAttribute('aria-pressed', on);
      if (b.classList.contains('circle')) b.innerHTML = icon.heart(on);
      else b.innerHTML = `${icon.heart(on)}${on ? 'В избранном' : 'В избранное'}`;
      b.setAttribute('aria-label', on ? 'Убрать из избранного' : 'В избранное');
    });
  }
  if (what === 'compare') {
    updateCompareBadge();
    $$('[data-cmp]').forEach((b) => {
      const on = store.compare.includes(Number(b.dataset.cmp));
      b.setAttribute('aria-pressed', on);
      b.classList.toggle('sel', on);
      b.classList.toggle('fill', !on);
      b.innerHTML = `${icon.compare(on)}${on ? 'В сравнении' : 'Сравнить'}`;
    });
  }
});

$('#overlay').addEventListener('click', () => closeSheet());
$('#sheetClose').addEventListener('click', () => closeSheet());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheetIsOpen()) closeSheet(); });
window.addEventListener('resize', () => $$('.seg').forEach((s) => moveIndicator(s, false)));
window.addEventListener('unhandledrejection', (e) => { if (e.reason?.status !== undefined) toastError(e.reason); });

/* ---------------- Boot ---------------- */
function routeFromStartParam(p) {
  if (!p) return null;
  let m;
  if ((m = p.match(/^s_(\d+)$/))) return `/service/${m[1]}`;
  if ((m = p.match(/^owner_(\d+)$/))) return `/owner/${m[1]}`;
  if (['owner', 'top', 'profile', 'admin', 'catalog', 'compare', 'favorites'].includes(p)) return `/${p}`;
  return null;
}

initTelegram(() => $$('.seg').forEach((s) => moveIndicator(s, false)));
updateCompareBadge();
applyLens($('.tabbar'));
await loadMe();
const deep = routeFromStartParam(startParam);
if (deep && !location.hash) {
  history.replaceState({ idx: 0 }, '', '#/');
  navigate(deep);
} else {
  render(false);
}
requestAnimationFrame(() => moveIndicator($('.tabbar'), false));
