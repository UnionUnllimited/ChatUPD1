import { haptic, setBack, setMain } from './tg.js';
import { MARKET_LABELS, monthLabel, PAYMENT, PROTOCOL } from './dict.js';

/* ---------------- DOM & formatting ---------------- */
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmt = (n) => Number(n).toLocaleString('ru-RU').replace(/ | /g, ' ');
export const rub = (n) => `${fmt(n)} ₽`;
export const plural = (n, a, b, c) => { const m10 = n % 10, m100 = n % 100; if (m10 === 1 && m100 !== 11) return a; if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return b; return c; };
export const ratingStr = (r) => (r == null ? '—' : String(r.toFixed ? r.toFixed(1) : r).replace('.', ','));
const MSK = { timeZone: 'Europe/Moscow' };
export const dateShort = (ts) => new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', ...MSK }).replace('.', '');
export const dateLong = (ts) => new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', ...MSK });
export const dateTime = (ts) => new Date(ts).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...MSK }).replace('.', '');
export const monthsWord = (m) => `${m} ${plural(m, 'месяц', 'месяца', 'месяцев')}`;
export const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
export const replay = (el, cls) => { if (!el || REDUCED) return; el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); };
export const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

/* ---------------- Icons ---------------- */
export const icon = {
  heart: (on) => `<svg width="20" height="20" viewBox="0 0 24 24" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7Z"/></svg>`,
  compare: (on) => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${on ? 2.6 : 1.9}" stroke-linecap="round" aria-hidden="true"><path d="M5 20V11M12 20V4M19 20v-6"/></svg>`,
  search: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  chev: '<svg class="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>',
  check: '<svg class="check" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4.5 4.5L19 7"/></svg>',
  shield: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z"/><path d="m9 12 2 2 4-4"/></svg>',
  filter: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4"/></svg>',
  x: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  info: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
  plus: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  bot: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.5 4.5-19 7.4 6.2 2.1 2.3 6.5 3.4-4.3 5 3.8z"/><path d="m8.7 14 7.8-6.3"/></svg>'
};

/* ---------------- Toast ---------------- */
let toastTimer;
export function toast(text, type) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  if (type === 'error') haptic.notify('error');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}
export const toastError = (e) => toast(e?.message || 'Что-то пошло не так', 'error');

/* ---------------- Sheets (page recedes behind, like iOS) ---------------- */
let sheetState = null;
let routeBack = null;
// The router tells us what Back means when no sheet is open.
export function setRouteBack(fn) { routeBack = fn; if (!sheetState) setBack(fn); }

export function openSheet(title, html, onMount, { main } = {}) {
  if (sheetState) closeSheet(true);
  $('#sheetTitle').textContent = title;
  // A fresh container per sheet, so listeners never leak between sheets.
  const content = document.createElement('div');
  content.className = 'sheet-inner';
  content.innerHTML = html;
  $('#sheetBody').replaceChildren(content);
  $('#overlay').classList.add('open');
  $('#sheet').classList.add('open');
  $('#page').classList.add('behind');
  document.body.classList.add('sheet-open');
  const prevMain = setMain(main || null);
  sheetState = { prevMain };
  setBack(() => closeSheet());
  $('#sheetBody').scrollTop = 0;
  if (onMount) onMount(content);
}
export function closeSheet(instant) {
  if (!sheetState) return;
  const { prevMain } = sheetState;
  sheetState = null;
  $('#overlay').classList.remove('open');
  $('#sheet').classList.remove('open');
  $('#page').classList.remove('behind');
  document.body.classList.remove('sheet-open');
  setMain(prevMain);
  setBack(routeBack);
  if (!instant) haptic.impact('light');
}
export const sheetIsOpen = () => Boolean(sheetState);
export const setSheetMain = (cfg) => { if (sheetState) setMain(cfg); };

export function optionSheet(title, items, current, onPick) {
  const html = `<div class="card group" role="radiogroup">${items.map((it) =>
    `<button type="button" class="row" role="radio" aria-checked="${String(it.id) === String(current)}" data-id="${esc(it.id)}"><span>${esc(it.name)}</span>${icon.check}</button>`).join('')}</div>`;
  openSheet(title, html, (root) => {
    $$('[data-id]', root).forEach((b) => b.addEventListener('click', () => {
      haptic.select();
      $$('[data-id]', root).forEach((x) => x.setAttribute('aria-checked', x === b));
      setTimeout(() => { closeSheet(true); onPick(b.dataset.id); }, REDUCED ? 0 : 200);
    }));
  });
}

// Asks for a moderation reason; resolves null when dismissed.
export function reasonSheet(title, placeholder = 'Причина — её увидит автор') {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); };
    openSheet(title, `
      <label class="field"><span>Причина</span><textarea class="input" id="reasonText" maxlength="500" placeholder="${esc(placeholder)}"></textarea></label>
      <div class="err" id="reasonErr" hidden></div>`,
    (root) => {
      const ta = $('#reasonText', root);
      setTimeout(() => ta.focus(), 350);
      const observer = new MutationObserver(() => { if (!$('#sheet').classList.contains('open')) { observer.disconnect(); finish(null); } });
      observer.observe($('#sheet'), { attributes: true, attributeFilter: ['class'] });
      setSheetMain({
        text: 'Отправить',
        onClick: () => {
          const v = ta.value.trim();
          if (v.length < 3) { $('#reasonErr', root).textContent = 'Напишите причину'; $('#reasonErr', root).hidden = false; return; }
          finish(v);
          closeSheet();
        }
      });
    });
  });
}

/* ---------------- Liquid segmented indicator ---------------- */
export function moveIndicator(seg, animate = true) {
  const ind = $('.seg-ind', seg);
  const active = $('[aria-selected="true"]', seg);
  if (!ind) return;
  if (!active || !seg.offsetWidth) { ind.style.width = '0px'; return; }
  const x = active.offsetLeft, w = active.offsetWidth;
  const prevX = parseFloat(ind.dataset.x), prevW = parseFloat(ind.dataset.w);
  ind.style.left = x + 'px';
  ind.style.width = w + 'px';
  ind.dataset.x = x; ind.dataset.w = w;
  if (!animate || REDUCED || isNaN(prevX) || prevX === x || !prevW) return;
  const spring = cssVar('--spring-bouncy');
  ind.animate([{ left: prevX + 'px', width: prevW + 'px' }, { left: x + 'px', width: w + 'px' }], { duration: 650, easing: spring });
  ind.animate([{ transform: 'scale(1,1)' }, { transform: 'scale(1.08,.86)', offset: 0.35 }, { transform: 'scale(.98,1.04)', offset: 0.7 }, { transform: 'scale(1,1)' }], { duration: 520, easing: 'ease-in-out' });
}

export function segHTML(items, current, attr = 'data-seg-val') {
  return `<div class="lg seg" role="tablist"><span class="seg-ind lgs"></span>${items.map((it) =>
    `<button type="button" role="tab" ${attr}="${esc(it.id)}" aria-selected="${String(it.id) === String(current)}">${esc(it.name)}</button>`).join('')}</div>`;
}

// Wires a segmented control rendered by segHTML; the indicator settles after layout.
export function bindSeg(seg, onPick, attr = 'data-seg-val') {
  requestAnimationFrame(() => moveIndicator(seg, false));
  seg.addEventListener('click', (e) => {
    const b = e.target.closest(`[${attr}]`);
    if (!b || b.getAttribute('aria-selected') === 'true') return;
    haptic.select();
    $$(`[${attr}]`, seg).forEach((x) => x.setAttribute('aria-selected', x === b));
    moveIndicator(seg, true);
    onPick(b.getAttribute(attr));
  });
}

/* ---------------- Lensing: SVG displacement refraction (Chromium only) ---------------- */
const LENS_OK = (() => {
  const ua = navigator.userAgent;
  return /Chrome|Chromium|Edg\//.test(ua) && !/iPhone|iPad|iPod/.test(ua) && CSS.supports('backdrop-filter', 'url(#x)');
})();
let lensSeq = 0;
function lensMap(w, h, radius, bezel) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  const r = Math.min(radius, h / 2, w / 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5 - w / 2, py = y + 0.5 - h / 2;
      const qx = Math.abs(px) - (w / 2 - r), qy = Math.abs(py) - (h / 2 - r);
      let dist, nx, ny;
      if (qx > 0 && qy > 0) { const len = Math.hypot(qx, qy); dist = len - r; nx = (qx / len) * Math.sign(px); ny = (qy / len) * Math.sign(py); }
      else { dist = Math.max(qx, qy) - r; if (qx > qy) { nx = Math.sign(px); ny = 0; } else { nx = 0; ny = Math.sign(py); } }
      const depth = -dist;
      let dx = 0, dy = 0;
      if (depth >= 0 && depth < bezel) { const t = 1 - depth / bezel; const m = t * t * (3 - 2 * t); dx = -nx * m; dy = -ny * m; }
      const i = (y * w + x) * 4;
      img.data[i] = 128 + dx * 127; img.data[i + 1] = 128 + dy * 127; img.data[i + 2] = 128; img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL();
}
export function applyLens(el) {
  if (!LENS_OK || el.dataset.lensOn) return;
  el.dataset.lensOn = '1';
  const bezel = Number(el.dataset.lens) || 16;
  const build = () => {
    const w = Math.round(el.offsetWidth), h = Math.round(el.offsetHeight);
    if (!w || !h) return;
    const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || h / 2;
    const id = el.dataset.lensId || ('lens' + (++lensSeq));
    el.dataset.lensId = id;
    let f = document.getElementById(id);
    if (!f) {
      f = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
      f.setAttribute('id', id);
      f.setAttribute('color-interpolation-filters', 'sRGB');
      $('#lensDefs defs').appendChild(f);
    }
    f.innerHTML = `<feImage href="${lensMap(w, h, radius, bezel)}" x="0" y="0" width="${w}" height="${h}" result="map"/><feDisplacementMap in="SourceGraphic" in2="map" scale="${bezel * 2.2}" xChannelSelector="R" yChannelSelector="G"/>`;
    el.style.backdropFilter = `blur(3px) url(#${id}) saturate(1.8) brightness(1.05)`;
  };
  let t;
  new ResizeObserver(() => { clearTimeout(t); t = setTimeout(build, 80); }).observe(el);
}

/* ---------------- Keyed list render with FLIP ---------------- */
export function renderList(container, html) {
  const before = new Map($$('[data-key]', container).map((el) => [el.dataset.key, el.getBoundingClientRect()]));
  container.innerHTML = html;
  const spring = cssVar('--spring');
  $$('[data-key]', container).forEach((el, i) => {
    if (REDUCED) return;
    const prev = before.get(el.dataset.key);
    if (prev) {
      const now = el.getBoundingClientRect();
      const dx = prev.left - now.left, dy = prev.top - now.top;
      if (dx || dy) el.animate([{ transform: `translate(${dx}px,${dy}px)` }, { transform: 'none' }], { duration: 650, easing: spring });
    } else if (i < 8) {
      el.style.animationDelay = (i * 40) + 'ms';
      el.classList.add('mat');
    }
  });
}

/* ---------------- Shared components ---------------- */
export function logoHTML(s, size = '') {
  const name = s.name || s.service_name || '?';
  const url = s.logo_url;
  return `<span class="lgs logo ${size}" aria-hidden="true">${url ? `<img src="${esc(url)}" alt="" loading="lazy">` : esc(name.trim()[0] || '?')}</span>`;
}

export const stars = (n) => `<span class="stars" aria-label="${n} из 5">${'★'.repeat(n)}<span class="no">${'★'.repeat(5 - n)}</span></span>`;

export function marketTag(m) {
  if (!m) return '';
  const cls = m === 'below' ? 'good' : m === 'above' ? 'warn' : 'neutral';
  return `<span class="tag ${cls}">${MARKET_LABELS[m]}</span>`;
}

export const topTag = (top) => (top ? `<span class="tag">🏆 Топ-10 за ${esc(monthLabel(top.period).split(' ')[0])}</span>` : '');

export function verifiedHTML(ts) {
  return ts ? `<span class="ok">${icon.shield} Проверено ${dateShort(ts)}</span>` : '<span>Ещё не проверялся</span>';
}

// The 3–4 most useful facts for a list card (the top badge counts towards the limit).
export function keyBadges(s, limit = 4) {
  const out = [];
  if (s.promo) out.push(`<span class="tag">${s.promo.discount_percent ? `−${s.promo.discount_percent}%` : 'Акция'}</span>`);
  if (s.trial) out.push(`<span class="tag neutral">Триал${s.trial_days ? ` ${s.trial_days} ${plural(s.trial_days, 'день', 'дня', 'дней')}` : ''}</span>`);
  if (s.payments.includes('card_ru')) out.push('<span class="tag neutral">Карта РФ</span>');
  else if (s.payments.includes('sbp')) out.push('<span class="tag neutral">СБП</span>');
  if (s.whitelist_bypass) out.push('<span class="tag neutral">Обход белых списков</span>');
  if (out.length < 4) out.push(`<span class="tag neutral">до ${s.devices} ${plural(s.devices, 'устройства', 'устройств', 'устройств')}</span>`);
  if (out.length < 4 && s.protocols[0]) out.push(`<span class="tag neutral">${esc(PROTOCOL[s.protocols[0]]?.name || s.protocols[0])}</span>`);
  return out.slice(0, limit).join('');
}

export function vpnCardHTML(s, { fav = false, cmp = false } = {}) {
  return `
  <article class="card vpn press" data-key="${s.id}" data-open="${s.id}" data-impression="${s.id}">
    <div class="vpn-head">
      ${logoHTML(s)}
      <div class="grow">
        <div class="vpn-name">${esc(s.name)}</div>
        <div class="meta">
          <span><span class="star">★</span> ${ratingStr(s.rating)} · ${fmt(s.reviews)} ${plural(s.reviews, 'отзыв', 'отзыва', 'отзывов')}</span>
          ${verifiedHTML(s.verified_at)}
        </div>
      </div>
      <button type="button" class="fill circle fav press" data-fav="${s.id}" aria-pressed="${fav}" aria-label="${fav ? 'Убрать из избранного' : 'В избранное'}">${icon.heart(fav)}</button>
    </div>
    <div class="badges">${topTag(s.top)}${keyBadges(s, s.top ? 3 : 4)}</div>
    <div class="vpn-foot">
      <div class="stack-sm price" style="gap:6px"><span class="price-line"><span class="from">от</span><b>${rub(s.min_monthly)}</b><small>/мес</small></span>${s.market ? `<span>${marketTag(s.market)}</span>` : ''}</div>
      <button type="button" class="${cmp ? 'sel' : 'fill'} btn sm press cmp-btn" data-cmp="${s.id}" aria-pressed="${cmp}">${icon.compare(cmp)}${cmp ? 'В сравнении' : 'Сравнить'}</button>
    </div>
  </article>`;
}

export function emptyHTML(text, action = '', glyph = icon.search) {
  return `<div class="card empty mat"><span class="lgs ico">${glyph}</span><p>${text}</p>${action}</div>`;
}

export const skeletonHTML = (n = 3) => Array.from({ length: n }, () => '<div class="skeleton"></div>').join('');

export function errorHTML(e, retry = true) {
  return emptyHTML(esc(e?.message || 'Не удалось загрузить данные'), retry ? '<button type="button" class="lgb btn press" data-action="reload">Повторить</button>' : '');
}

export const paymentsText = (list) => list.map((p) => PAYMENT[p]?.name || p).join(', ');
