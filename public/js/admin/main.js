// Standalone admin panel: same design system and API as the Mini App, desktop layout.
// Opens in a browser (session from the bot's /admin link) or inside Telegram (initData).
import { initTelegram, inTelegram, setMain, setBack } from '../tg.js';
import { api, get, post, adminSession, setAdminSession } from '../api.js';
import { $, $$, esc, errorHTML, closeSheet, sheetIsOpen, setRouteBack, toastError, avatarHTML, emptyHTML } from '../ui.js';
import { store, loadMe, hasRole } from '../store.js';
import { adminApplications, adminModeration, adminChecks, adminTop, adminLog } from '../views/admin.js';
import { dashboard, services, serviceDetail, serviceNew, users, userDetail, reviews, broadcast, notifications, settings, statusScreen, statusSettings } from './views.js';

const I = (d) => `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const NAV = [
  { path: '/admin', name: 'Обзор', icon: I('<path d="M4 13h6V4H4zM14 20h6v-9h-6zM14 4v4h6V4zM4 20h6v-4H4z"/>') },
  { path: '/admin/applications', name: 'Заявки', count: 'applications', icon: I('<path d="M12 5v14M5 12h14"/>') },
  { path: '/admin/moderation', name: 'Модерация', count: 'moderation', icon: I('<path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z"/><path d="m9 12 2 2 4-4"/>') },
  { path: '/admin/services', name: 'Сервисы', icon: I('<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>') },
  { path: '/admin/users', name: 'Пользователи', icon: I('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.4 3.3-5.3 6.5-5.3s5.7 1.9 6.5 5.3M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20c-.5-2.4-1.8-4-3.5-4.8"/>') },
  { path: '/admin/reviews', name: 'Отзывы', icon: I('<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>') },
  { path: '/admin/status', name: 'Статусы', count: 'status_alerts', icon: I('<path d="M3 12h4l3-7 4 14 3-7h4"/>') },
  { path: '/admin/checks', name: 'Проверки', count: 'unchecked', icon: I('<path d="m5 12 4.5 4.5L19 7"/>') },
  { path: '/admin/top', name: 'Топ месяца', icon: I('<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0zM17 6h3v1a3 3 0 0 1-3 3M7 6H4v1a3 3 0 0 0 3 3"/>') },
  { path: '/admin/broadcast', name: 'Рассылка', icon: I('<path d="m21.5 4.5-19 7.4 6.2 2.1 2.3 6.5 3.4-4.3 5 3.8z"/><path d="m8.7 14 7.8-6.3"/>') },
  { path: '/admin/notifications', name: 'Уведомления', icon: I('<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0"/>') },
  { path: '/admin/settings', name: 'Настройки', icon: I('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>') },
  { path: '/admin/log', name: 'Журнал', icon: I('<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>') }
];

// Reused Mini App screens are list-shaped, so they keep a readable width.
const routes = [
  ['/admin', dashboard], ['/admin/applications', adminApplications, true], ['/admin/moderation', adminModeration, true],
  ['/admin/services', services], ['/admin/services/new', serviceNew], ['/admin/services/:id', serviceDetail],
  ['/admin/users', users], ['/admin/users/:id', userDetail], ['/admin/reviews', reviews],
  ['/admin/status', statusScreen], ['/admin/status/settings', statusSettings],
  ['/admin/checks', adminChecks, true], ['/admin/top', adminTop, true], ['/admin/broadcast', broadcast, true],
  ['/admin/notifications', notifications], ['/admin/settings', settings], ['/admin/log', adminLog, true]
].map(([pattern, view, narrow]) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  return { re, keys, view, narrow };
});

const parseHash = () => {
  const raw = location.hash.replace(/^#/, '') || '/admin';
  const [path, q = ''] = raw.split('?');
  return { path: path.startsWith('/admin') ? path : '/admin', query: Object.fromEntries(new URLSearchParams(q)) };
};

export const navigate = (to) => { location.hash = to; };

let cleanup = null;
let seq = 0;

async function refreshCounts() {
  try {
    const s = await get('/api/admin/summary');
    const counts = { applications: s.applications, moderation: s.revisions + s.promos + s.reviews, unchecked: s.unchecked, status_alerts: s.status_alerts };
    $$('#sideNav [data-count]').forEach((el) => {
      const n = counts[el.dataset.count] || 0;
      el.hidden = !n;
      el.textContent = n;
    });
  } catch {}
}

async function render() {
  const my = ++seq;
  const { path, query } = parseHash();
  let match = null;
  for (const r of routes) {
    const m = path.match(r.re);
    if (m) { match = { ...r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) }; break; }
  }
  if (!match) { navigate('/admin'); return; }
  if (sheetIsOpen()) closeSheet(true);
  if (typeof cleanup === 'function') cleanup();
  cleanup = null;
  setMain(null);

  const section = NAV.filter((n) => path === n.path || (n.path !== '/admin' && path.startsWith(n.path + '/'))).pop();
  $$('#sideNav a').forEach((a) => (a.dataset.path === section?.path ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  const isDetail = /\/(\d+|new)$/.test(path);
  setRouteBack(inTelegram ? () => (isDetail ? history.back() : location.assign('../#/profile')) : null);

  const root = $('#view');
  root.classList.toggle('narrow', Boolean(match.narrow));
  root.innerHTML = '';
  root.classList.remove('mat');
  void root.offsetWidth;
  root.classList.add('mat');
  window.scrollTo(0, 0);
  try {
    cleanup = await match.view(root, { params: match.params, query, path, navigate, refresh: render });
  } catch (e) {
    if (my === seq) root.innerHTML = errorHTML(e);
  }
  if (my === seq) refreshCounts();
}

function renderShell() {
  $('#side').hidden = false;
  $('#shell').classList.remove('solo');
  $('#sideNav').innerHTML = NAV.map((n) => `<a href="#${n.path}" data-path="${n.path}">${n.icon}<span>${n.name}</span>${n.count ? `<b class="count" data-count="${n.count}" hidden></b>` : ''}</a>`).join('');
  const me = store.me;
  $('#sideFoot').innerHTML = `
    <div class="side-user">${avatarHTML(me)}<span><b>${esc(me.first_name || '')}</b><br><span class="small muted">${me.username ? '@' + esc(me.username) : me.id}</span></span></div>
    <a class="link-btn" href="../#/">← В приложение</a>
    ${adminSession() && !inTelegram ? '<button type="button" class="link-btn danger" id="logout">Выйти</button>' : ''}`;
  $('#logout')?.addEventListener('click', async () => {
    await post('/api/admin/auth/logout').catch(() => {});
    setAdminSession(null);
    location.replace(location.pathname);
  });
}

async function loginScreen(reason) {
  $('#side').hidden = true;
  $('#shell').classList.add('solo');
  const meta = await get('/api/meta').catch(() => ({ bot_username: '' }));
  const bot = meta.bot_username;
  $('#view').innerHTML = `
    <div class="card login-card mat">
      <img src="../img/logo.svg" alt="">
      <h1 style="font-size:26px">Админ-панель Линзы</h1>
      ${reason ? `<p style="color:var(--bad)">${esc(reason)}</p>` : ''}
      <p>Чтобы войти, отправьте боту ${bot ? `<b>@${esc(bot)}</b>` : 'Линзы'} команду <code>/admin</code> — он пришлёт одноразовую ссылку для входа. Ссылка действует 10 минут.</p>
      ${bot ? `<a class="solid btn press" href="https://t.me/${esc(bot)}" target="_blank" rel="noopener">Открыть бота</a>` : ''}
      <p class="small muted">Вход доступен только администраторам. Сессия хранится в этом браузере 7 дней.</p>
    </div>`;
}

/* ---------------- Boot ---------------- */
$('#overlay').addEventListener('click', () => closeSheet());
$('#sheetClose').addEventListener('click', () => closeSheet());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheetIsOpen()) closeSheet(); });
window.addEventListener('hashchange', () => {
  // A login link pasted into an already open tab only changes the hash: start over.
  if (/^#login=/.test(location.hash)) { location.reload(); return; }
  if (store.me) render();
});
window.addEventListener('unhandledrejection', (e) => { if (e.reason?.status !== undefined) toastError(e.reason); });
// Press glow on glass controls, as in the Mini App.
document.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('.press');
  if (!el) return;
  const r = el.getBoundingClientRect();
  el.style.setProperty('--gx', ((e.clientX - r.left) / r.width) * 100 + '%');
  el.style.setProperty('--gy', ((e.clientY - r.top) / r.height) * 100 + '%');
  el.classList.add('pressed');
}, { passive: true });
['pointerup', 'pointercancel', 'dragstart'].forEach((ev) => document.addEventListener(ev, () => $$('.pressed').forEach((el) => el.classList.remove('pressed')), { capture: true, passive: true }));
// Rows that link to a detail page.
document.addEventListener('click', (e) => {
  const row = e.target.closest('[data-href]');
  if (row && !e.target.closest('a, button, input, select, label')) navigate(row.dataset.href);
});

initTelegram();
setBack(null);

// One-time login link from the bot: #login=<token>
const login = location.hash.match(/^#login=([A-Za-z0-9_-]+)/);
let loginError = null;
if (login && !inTelegram) {
  history.replaceState(null, '', location.pathname + '#/admin');
  try {
    const { session } = await api('/api/admin/auth/exchange', { method: 'POST', body: { token: login[1] } });
    setAdminSession(session);
  } catch (e) { loginError = e.message; }
}

await loadMe();
if (store.me && hasRole('admin')) {
  renderShell();
  render();
} else if (store.me) {
  $('#side').hidden = true;
  $('#shell').classList.add('solo');
  $('#view').innerHTML = emptyHTML('У этого аккаунта нет прав администратора Линзы.', '<a class="lgb btn press" href="../#/">В приложение</a>');
} else {
  if (adminSession()) setAdminSession(null); // expired or revoked
  loginScreen(loginError);
}
