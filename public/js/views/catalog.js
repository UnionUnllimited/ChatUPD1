import { get, qs } from '../api.js';
import { store, trackImpressions } from '../store.js';
import { haptic } from '../tg.js';
import {
  $, $$, esc, rub, plural, icon, vpnCardHTML, renderList, emptyHTML, skeletonHTML, errorHTML,
  segHTML, bindSeg, openSheet, closeSheet, setSheetMain, replay
} from '../ui.js';
import { PROTOCOLS, COUNTRIES, PAYMENTS, PLATFORMS, PROTOCOL, COUNTRY, PAYMENT, PLATFORM, DEVICE_OPTIONS } from '../dict.js';

const SORTS = [{ id: 'price', name: 'Цена' }, { id: 'rating', name: 'Рейтинг' }, { id: 'popular', name: 'Популярные' }, { id: 'new', name: 'Новые' }];
const LISTS = ['protocols', 'countries', 'payments', 'platforms'];
const FLAGS = [['trial', 'С триалом'], ['whitelist', 'Обход белых списков'], ['below_market', 'Ниже рынка'], ['promo', 'Есть акция']];
const DICTS = { protocols: PROTOCOL, countries: COUNTRY, payments: PAYMENT, platforms: PLATFORM };

export function parseState(q) {
  const s = { q: q.q || '', sort: SORTS.some((x) => x.id === q.sort) ? q.sort : 'rating', price_min: q.price_min || '', price_max: q.price_max || '', devices: q.devices || '' };
  for (const k of LISTS) s[k] = q[k] ? q[k].split(',').filter((v) => DICTS[k][v]) : [];
  for (const [k] of FLAGS) s[k] = q[k] === '1';
  return s;
}
const toQuery = (s) => ({ ...s, sort: s.sort === 'rating' ? '' : s.sort });
const clone = (s) => JSON.parse(JSON.stringify(s));

function appliedChips(s) {
  const chips = [];
  if (s.q) chips.push(['q', null, `«${s.q}»`]);
  if (s.price_min || s.price_max) chips.push(['price', null, s.price_min && s.price_max ? `${s.price_min}–${s.price_max} ₽` : s.price_max ? `до ${s.price_max} ₽` : `от ${s.price_min} ₽`]);
  for (const [k, label] of FLAGS) if (s[k]) chips.push([k, null, label]);
  if (s.devices) chips.push(['devices', null, `от ${s.devices} устр.`]);
  for (const k of LISTS) for (const v of s[k]) chips.push([k, v, (k === 'countries' ? COUNTRY[v].flag + ' ' : '') + DICTS[k][v].name]);
  return chips;
}

const activeCount = (s) => appliedChips(s).filter(([k]) => k !== 'q').length;

function filtersHTML(f, range) {
  const chipGroup = (key, list, withFlag) => `<div class="chips">${list.map((it) => {
    const on = f[key].includes(it.id);
    return `<button type="button" class="${on ? 'sel' : 'fill'} chip press" aria-pressed="${on}" data-list="${key}" data-v="${it.id}">${withFlag ? it.flag + ' ' : ''}${esc(it.name)}</button>`;
  }).join('')}</div>`;
  return `
    <div class="card panel stack-sm">
      <div class="row-flex between"><b style="font-size:15px">Цена за месяц, ₽</b><span class="small muted">в каталоге ${rub(range[0])} – ${rub(range[1])}</span></div>
      <div class="grid2">
        <label class="field"><span>от</span><input class="input" type="number" inputmode="numeric" min="0" id="fMin" value="${esc(f.price_min)}" placeholder="${range[0]}"></label>
        <label class="field"><span>до</span><input class="input" type="number" inputmode="numeric" min="0" id="fMax" value="${esc(f.price_max)}" placeholder="${range[1]}"></label>
      </div>
      <div class="chips" style="margin-top:4px">${[100, 150, 200, 300].map((p) => `<button type="button" class="${String(f.price_max) === String(p) && !f.price_min ? 'sel' : 'fill'} chip press" data-preset="${p}">до ${p} ₽</button>`).join('')}</div>
    </div>
    <div class="card group">${FLAGS.map(([k, l]) => `<label class="row"><span>${l}</span><input class="sw" type="checkbox" data-flag="${k}" ${f[k] ? 'checked' : ''}></label>`).join('')}</div>
    <div><p class="label">Протокол</p>${chipGroup('protocols', PROTOCOLS)}</div>
    <div><p class="label">Страны серверов</p>${chipGroup('countries', COUNTRIES.filter((c) => c.id !== 'ru'), true)}</div>
    <div><p class="label">Устройств на подписку</p>
      <div class="chips">${[['', 'Любое'], ...DEVICE_OPTIONS.filter((d) => d > 1).map((d) => [String(d), `от ${d}`])].map(([v, l]) =>
        `<button type="button" class="${String(f.devices) === v ? 'sel' : 'fill'} chip press" data-devices="${v}">${l}</button>`).join('')}</div></div>
    <div><p class="label">Способ оплаты</p>${chipGroup('payments', PAYMENTS)}</div>
    <div><p class="label">Платформы — должны поддерживаться все выбранные</p>${chipGroup('platforms', PLATFORMS)}</div>
    <button type="button" class="fill cta press" id="fReset">Сбросить фильтры</button>`;
}

export default async function catalog(root, { query }) {
  const s = parseState(query);
  let range = [0, 0];
  let seq = 0;

  root.innerHTML = `
    <div class="topbar"><h1 class="title">Каталог</h1><span class="muted small" id="count"></span></div>
    <form class="lg search" id="catSearch" role="search" data-lens="18">
      ${icon.search}<input type="search" name="q" value="${esc(s.q)}" placeholder="Название VPN" enterkeyhint="search" autocomplete="off" aria-label="Поиск по названию">
    </form>
    <div id="sortBox">${segHTML(SORTS, s.sort)}</div>
    <div class="stack-sm">
      <div class="row-flex between">
        <button type="button" class="fill btn press" id="btnFilters">${icon.filter} Фильтры <span class="dot" id="filterDot" hidden></span></button>
        <button type="button" class="link-btn" id="resetAll" hidden>Сбросить всё</button>
      </div>
      <div class="chips scroll" id="applied" style="padding-bottom:4px"></div>
    </div>
    <div class="list" id="results">${skeletonHTML(3)}</div>`;

  const syncUrl = () => {
    const q = qs(toQuery(s));
    history.replaceState(history.state, '', '#/catalog' + q);
    store.catalogQuery = Object.fromEntries(new URLSearchParams(q.slice(1)));
  };

  const renderApplied = () => {
    const chips = appliedChips(s);
    $('#applied', root).innerHTML = chips.map(([k, v, label]) =>
      `<button type="button" class="sel chip press" data-remove="${k}" data-v="${esc(v ?? '')}" aria-label="Убрать фильтр ${esc(label)}">${esc(label)} <span class="x">${icon.x}</span></button>`).join('');
    $('#applied', root).hidden = !chips.length;
    const n = activeCount(s);
    $('#filterDot', root).hidden = !n;
    $('#filterDot', root).textContent = n;
    $('#resetAll', root).hidden = !chips.length;
  };

  async function load() {
    const my = ++seq;
    renderApplied();
    syncUrl();
    try {
      const data = await get('/api/catalog' + qs({ ...s }));
      if (my !== seq) return;
      range = data.price_range;
      $('#count', root).textContent = `${data.items.length} из ${data.total}`;
      const list = $('#results', root);
      renderList(list, data.items.length
        ? data.items.map((it) => vpnCardHTML(it, { fav: store.favorites.has(it.id), cmp: store.compare.includes(it.id) })).join('')
        : emptyHTML('Под эти условия ничего не подошло. Попробуйте ослабить фильтры.', '<button type="button" class="lgb btn press" id="emptyReset">Сбросить фильтры</button>'));
      $('#emptyReset', list)?.addEventListener('click', resetAll);
      trackImpressions(list);
    } catch (e) {
      if (my === seq) $('#results', root).innerHTML = errorHTML(e);
    }
  }

  function resetAll() {
    haptic.impact('light');
    Object.assign(s, parseState({ sort: s.sort }));
    $('#catSearch input', root).value = '';
    load();
  }

  let t;
  $('#catSearch input', root).addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { s.q = e.target.value.trim(); load(); }, 300); });
  $('#catSearch', root).addEventListener('submit', (e) => { e.preventDefault(); e.target.q.blur(); clearTimeout(t); s.q = e.target.q.value.trim(); load(); });
  bindSeg($('#sortBox .seg', root), (v) => { s.sort = v; load(); });
  $('#resetAll', root).addEventListener('click', resetAll);
  $('#applied', root).addEventListener('click', (e) => {
    const b = e.target.closest('[data-remove]');
    if (!b) return;
    haptic.select();
    const k = b.dataset.remove;
    if (k === 'q') { s.q = ''; $('#catSearch input', root).value = ''; }
    else if (k === 'price') { s.price_min = ''; s.price_max = ''; }
    else if (LISTS.includes(k)) s[k] = s[k].filter((v) => v !== b.dataset.v);
    else if (k === 'devices') s.devices = '';
    else s[k] = false;
    load();
  });
  $('#btnFilters', root).addEventListener('click', () => { haptic.impact('light'); openFilters(); });

  function openFilters() {
    const f = clone(s);
    let countSeq = 0;
    const updateCount = async () => {
      const my = ++countSeq;
      setSheetMain({ text: 'Считаем…', onClick: apply, progress: true });
      try {
        const d = await get('/api/catalog' + qs(f));
        if (my !== countSeq) return;
        const n = d.items.length;
        setSheetMain({ text: n ? `Показать ${n} ${plural(n, 'VPN', 'VPN', 'VPN')}` : 'Ничего не найдено', onClick: apply, disabled: !n });
      } catch { setSheetMain({ text: 'Показать', onClick: apply }); }
    };
    let ct;
    const changed = () => { clearTimeout(ct); ct = setTimeout(updateCount, 200); };
    const apply = () => { haptic.impact('medium'); Object.assign(s, f); closeSheet(true); load(); };
    const draw = (body) => {
      body.innerHTML = filtersHTML(f, range);
      $('#fMin', body).addEventListener('input', (e) => { f.price_min = e.target.value.replace(/\D/g, ''); changed(); });
      $('#fMax', body).addEventListener('input', (e) => { f.price_max = e.target.value.replace(/\D/g, ''); $$('[data-preset]', body).forEach((x) => { x.className = 'fill chip press'; }); changed(); });
      $$('[data-flag]', body).forEach((c) => c.addEventListener('change', () => { haptic.select(); f[c.dataset.flag] = c.checked; changed(); }));
    };
    const mount = (body) => {
      draw(body);
      body.addEventListener('click', (e) => {
        const chip = e.target.closest('[data-list]');
        if (chip) {
          haptic.select();
          const k = chip.dataset.list, v = chip.dataset.v;
          f[k] = f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v];
          const on = f[k].includes(v);
          chip.className = `${on ? 'sel' : 'fill'} chip press`;
          chip.setAttribute('aria-pressed', on);
          replay(chip, 'bump');
          changed();
          return;
        }
        const preset = e.target.closest('[data-preset]');
        if (preset) {
          haptic.select();
          f.price_min = ''; f.price_max = preset.dataset.preset;
          $('#fMin', body).value = ''; $('#fMax', body).value = f.price_max;
          $$('[data-preset]', body).forEach((x) => { x.className = `${x === preset ? 'sel' : 'fill'} chip press`; });
          changed();
          return;
        }
        const dev = e.target.closest('[data-devices]');
        if (dev) {
          haptic.select();
          f.devices = dev.dataset.devices;
          $$('[data-devices]', body).forEach((x) => { x.className = `${x === dev ? 'sel' : 'fill'} chip press`; });
          changed();
          return;
        }
        if (e.target.closest('#fReset')) {
          haptic.impact('light');
          Object.assign(f, parseState({ sort: f.sort, q: f.q }));
          draw(body);
          changed();
        }
      });
    };
    openSheet('Фильтры', '', (body) => { mount(body); updateCount(); }, { main: { text: 'Показать', onClick: apply } });
  }

  await load();
  return () => clearTimeout(t);
}
