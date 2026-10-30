// Telegram WebApp bridge. Every call is safe outside Telegram (plain browser preview).
const wa = window.Telegram && window.Telegram.WebApp;
export const tg = wa && wa.initData ? wa : null;
export const inTelegram = Boolean(tg);
const atLeast = (v) => Boolean(tg && tg.isVersionAtLeast && tg.isVersionAtLeast(v));

export const startParam = tg?.initDataUnsafe?.start_param || new URLSearchParams(location.search).get('startapp') || null;
export const tgUser = tg?.initDataUnsafe?.user || null;

/* ---------- Theme: follows Telegram unless the user picked one in the profile ---------- */
const THEME_KEY = 'linza_theme';
let onThemeChange = null;

export function themePref() {
  try { return localStorage.getItem(THEME_KEY) || 'auto'; } catch { return 'auto'; }
}

function resolvedTheme() {
  const pref = themePref();
  if (pref === 'light' || pref === 'dark') return pref;
  if (tg) return tg.colorScheme === 'dark' ? 'dark' : 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme() {
  document.documentElement.setAttribute('data-theme', resolvedTheme());
  if (tg) {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    try {
      tg.setHeaderColor(bg);
      tg.setBackgroundColor(bg);
      if (atLeast('7.10')) tg.setBottomBarColor(bg);
    } catch {}
  }
  if (mainCfg) setMain(mainCfg); // MainButton colours come from the theme
  onThemeChange?.();
}

export function setThemePref(pref) {
  try { pref === 'auto' ? localStorage.removeItem(THEME_KEY) : localStorage.setItem(THEME_KEY, pref); } catch {}
  applyTheme();
}

export function initTelegram(onTheme) {
  onThemeChange = onTheme;
  if (tg) {
    try {
      tg.ready();
      tg.expand();
      if (atLeast('7.7')) tg.disableVerticalSwipes(); // sheets and horizontal lists need the gesture
    } catch {}
    tg.onEvent('themeChanged', applyTheme);
  }
  applyTheme();
}

export const haptic = {
  impact(style = 'light') { try { tg.HapticFeedback.impactOccurred(style); } catch {} },
  select() { try { tg.HapticFeedback.selectionChanged(); } catch {} },
  notify(type = 'success') { try { tg.HapticFeedback.notificationOccurred(type); } catch {} }
};

// t.me links open inside Telegram (the VPN's bot); anything else in the browser.
export function openLink(url) {
  if (!url) return;
  if (tg) {
    try {
      if (/^https:\/\/t\.me\//.test(url)) tg.openTelegramLink(url);
      else tg.openLink(url);
      return;
    } catch {}
  }
  window.open(url, '_blank', 'noopener');
}

/* ---------- BackButton: one handler at a time ---------- */
let backHandler = null;
if (tg) tg.BackButton.onClick(() => backHandler && backHandler());
export function setBack(handler) {
  backHandler = handler;
  if (!tg) return;
  try { handler ? tg.BackButton.show() : tg.BackButton.hide(); } catch {}
}

/* ---------- MainButton with an in-page fallback ---------- */
const fallback = () => document.getElementById('fallbackMain');
let mainCfg = null;
let mainHandler = null;
if (tg) tg.MainButton.onClick(() => mainHandler && mainHandler());

export function setMain(cfg) {
  const prev = mainCfg;
  mainCfg = cfg;
  mainHandler = cfg ? cfg.onClick : null;
  if (tg) {
    try {
      if (!cfg) { tg.MainButton.hideProgress(); tg.MainButton.hide(); return prev; }
      // The native button can't be translucent: it takes the glass tint colour, not a solid accent.
      const css = getComputedStyle(document.documentElement);
      tg.MainButton.setParams({ text: cfg.text, color: css.getPropertyValue('--main-bg').trim(), text_color: css.getPropertyValue('--main-text').trim(), is_active: !cfg.disabled, is_visible: true });
      cfg.progress ? tg.MainButton.showProgress(false) : tg.MainButton.hideProgress();
    } catch {}
    return prev;
  }
  const b = fallback();
  document.body.classList.toggle('has-main', Boolean(cfg));
  if (!cfg) { b.hidden = true; return prev; }
  b.hidden = false;
  b.textContent = cfg.progress ? 'Подождите…' : cfg.text;
  b.disabled = Boolean(cfg.disabled || cfg.progress);
  b.onclick = () => cfg.onClick && cfg.onClick();
  return prev;
}
export const mainVisible = () => Boolean(mainCfg);
export function mainProgress(on) { if (mainCfg) setMain({ ...mainCfg, progress: on }); }

export function confirmDialog(text) {
  return new Promise((resolve) => {
    if (tg && atLeast('6.2')) { tg.showConfirm(text, (ok) => resolve(Boolean(ok))); return; }
    resolve(window.confirm(text));
  });
}

export function requestWriteAccess() {
  return new Promise((resolve) => {
    if (!tg || !atLeast('6.9')) { resolve(false); return; }
    try { tg.requestWriteAccess((ok) => resolve(Boolean(ok))); } catch { resolve(false); }
  });
}

export function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(() => true, () => false);
  return Promise.resolve(false);
}
