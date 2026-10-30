// Admin panel screens that exist only in the panel (desktop tables, editing, broadcast...).
import { api, get, post, download } from '../api.js';
import { haptic, setMain, mainProgress, confirmDialog, openLink } from '../tg.js';
import {
  $, $$, esc, rub, fmt, plural, icon, logoHTML, avatarHTML, dateShort, dateTime, stars, segHTML, bindSeg,
  openSheet, closeSheet, setSheetMain, reasonSheet, toast, toastError, monthsWord, paymentsText,
  healthTag, uptimeBarHTML, bindUptimeBar
} from '../ui.js';
import { store } from '../store.js';
import { PROTOCOL, COUNTRY, PLATFORM, TARIFF_MONTHS, MODERATION_STATUS, NOTIFY_TYPES, NETWORK, STATUS_CONFIG_FIELDS, monthLabel } from '../dict.js';
import { editorHTML, bindEditor, barChart } from '../views/owner.js';

/* ---------------- Shared bits ---------------- */
const head = (title, actions = '', extra = '') => `<div class="page-head"><h1 class="title">${title}</h1><div class="actions">${extra}${actions}</div></div>`;
const kpi = (k, v, sub = '') => `<div class="card kpi"><div class="k">${k}</div><div class="v">${v}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
const tag = (text, kind = 'neutral') => `<span class="tag ${kind}">${esc(text)}</span>`;
const who = (u) => (u?.username ? `@${esc(u.username)}` : esc([u?.first_name, u?.last_name].filter(Boolean).join(' ') || `id ${u?.id ?? u?.user_id}`));
const ROLE_NAMES = { admin: 'админ', vpn_owner: 'VPN-сервис' };

async function act(fn, okText) {
  try { const out = await fn(); haptic.notify('success'); if (okText) toast(okText); return out ?? true; } catch (e) { toastError(e); return false; }
}

function exportButton(kind, label = 'Выгрузить CSV') {
  return `<button type="button" class="fill btn sm press" data-export="${kind}">${label}</button>`;
}
function bindExports(root) {
  $$('[data-export]', root).forEach((b) => b.addEventListener('click', () => {
    const kind = b.dataset.export;
    download(`/api/admin/export/${kind}.csv`, `linza-${kind}.csv`).then(() => toast('Файл сохранён'), toastError);
  }));
}

function chips(items, current, attr) {
  return `<div class="chips">${items.map(([id, label]) => `<button type="button" class="${String(id) === String(current) ? 'sel' : 'fill'} chip press" ${attr}="${esc(id)}">${label}</button>`).join('')}</div>`;
}

const cmp = (a, b) => {
  if (a === b) return 0;
  if (a === null || a === undefined || a === '') return 1;
  if (b === null || b === undefined || b === '') return -1;
  return typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), 'ru');
};

// Sortable table; rows with `href` open a detail page on click.
function dataTable(box, { columns, rows, href, empty = 'Ничего не найдено', sort = null }) {
  let state = sort;
  let data = rows;
  const draw = () => {
    let list = data;
    if (state) {
      const col = columns.find((c) => c.key === state.key);
      const val = col.value || ((r) => r[col.key]);
      list = [...data].sort((a, b) => cmp(val(a), val(b)) * state.dir);
    }
    box.innerHTML = `<div class="card table-wrap"><table class="data"><thead><tr>${columns.map((c) =>
      `<th class="${c.num ? 'num' : ''}" ${c.sortable === false ? '' : `data-sort="${c.key}"`}>${c.title}${state?.key === c.key ? `<span class="dir">${state.dir > 0 ? '↑' : '↓'}</span>` : ''}</th>`).join('')}</tr></thead>
      <tbody>${list.length ? list.map((r) => `<tr ${href ? `class="clickable" data-href="${esc(href(r))}"` : ''}>${columns.map((c) =>
        `<td class="${c.num ? 'num' : c.cls || ''}">${c.render ? c.render(r) : esc(r[c.key] ?? '—')}</td>`).join('')}</tr>`).join('')
        : `<tr><td colspan="${columns.length}" class="empty-cell">${empty}</td></tr>`}</tbody></table></div>`;
    $$('th[data-sort]', box).forEach((th) => th.addEventListener('click', () => {
      const key = th.dataset.sort;
      const col = columns.find((c) => c.key === key);
      state = state?.key === key ? { key, dir: -state.dir } : { key, dir: col.num ? -1 : 1 };
      draw();
    }));
  };
  draw();
  return { update(next) { data = next; draw(); } };
}

// Charts redraw on width changes only.
function charts(root, draws) {
  const run = () => draws.forEach(([sel, daily, key, forms]) => { const el = $(sel, root); if (el) barChart(el, daily, key, forms); });
  requestAnimationFrame(run);
  let lastW = 0;
  const ro = new ResizeObserver(() => { const w = root.clientWidth; if (w !== lastW) { lastW = w; run(); } });
  ro.observe(root);
  return () => ro.disconnect();
}

/* ---------------- Dashboard ---------------- */
export async function dashboard(root) {
  const d = await get('/api/admin/dashboard');
  const q = d.queue;
  const tile = (href, title, n, hint) => `<a class="card tile press" href="#${href}" style="color:inherit"><span class="row-flex between"><span class="n">${n}</span>${n ? '<span class="dot">!</span>' : ''}</span><span><span class="t">${title}</span><br><span class="small muted">${hint}</span></span></a>`;
  root.innerHTML = `
    ${head('Обзор', '', `<span class="muted small" style="align-self:center">${esc(monthLabel(d.month.period))}</span>`)}
    <div class="kpi-grid">
      ${kpi('Пользователи', fmt(d.users.total), `+${fmt(d.users.new7)} за 7 дней`)}
      ${kpi('Активны за 7 дней', fmt(d.users.active7), `${fmt(d.users.active1)} за сутки`)}
      ${kpi('Бот может писать', fmt(d.users.reachable), 'получают уведомления')}
      ${kpi('VPN в каталоге', fmt(d.catalog.published), `${d.catalog.drafts} черн. · ${d.catalog.hidden} скрыто`)}
      ${kpi('Переходы в бот', fmt(d.month.clicks), `${fmt(d.month.clients)} уникальных за месяц`)}
      ${kpi('Отзывы за месяц', fmt(d.month.reviews), 'опубликовано')}
      ${kpi('Средняя цена', d.catalog.market_avg ? rub(d.catalog.market_avg) : '—', 'за месяц по каталогу')}
      ${kpi('Акции', fmt(d.catalog.promos_active), `${fmt(d.users.owners)} владельцев VPN`)}
    </div>
    <section>
      <h2 class="section-title">Требует внимания</h2>
      <div class="queue-grid">
        ${tile('/admin/applications', 'Заявки', q.applications, 'на подключение')}
        ${tile('/admin/moderation?kind=revisions', 'Карточки', q.revisions, 'новые и правки')}
        ${tile('/admin/moderation?kind=promos', 'Акции', q.promos, 'на модерации')}
        ${tile('/admin/moderation?kind=reviews', 'Отзывы', q.reviews, 'на модерации')}
        ${tile('/admin/status', 'Споры и аномалии', q.status_alerts, 'по статусам')}
        ${tile('/admin/status', 'Сейчас со сбоями', q.incidents, 'по сигналам клиентов')}
      </div>
    </section>
    <div class="grid-2">
      <div class="card panel stack-sm"><h3>Переходы в бот по дням</h3><div class="chart-box" id="chClicks"></div></div>
      <div class="card panel stack-sm"><h3>Новые пользователи по дням</h3><div class="chart-box" id="chUsers"></div></div>
    </div>
    <div class="grid-2">
      <section><h2 class="section-title">Лидеры месяца по клиентам</h2><div id="topTable"></div></section>
      <section><h2 class="section-title">Бот</h2>
        <div class="card group">
          <a class="row press" href="#/admin/notifications?status=queued" style="color:inherit"><span>В очереди на отправку</span><span class="row-flex"><span class="v">${fmt(d.outbox.queued)}</span>${icon.chev}</span></a>
          <a class="row press" href="#/admin/notifications?status=sent" style="color:inherit"><span>Отправлено за 7 дней</span><span class="row-flex"><span class="v">${fmt(d.outbox.sent7)}</span>${icon.chev}</span></a>
          <a class="row press" href="#/admin/notifications?status=failed" style="color:inherit"><span>Не доставлено за 7 дней</span><span class="row-flex"><span class="v">${fmt(d.outbox.failed7)}</span>${icon.chev}</span></a>
        </div>
        <a class="lgb btn press" href="#/admin/broadcast" style="margin-top:12px">${icon.bot} Сделать рассылку</a>
      </section>
    </div>`;
  dataTable($('#topTable', root), {
    rows: d.top_month,
    href: (r) => `/admin/services/${r.id}`,
    empty: 'В этом месяце переходов ещё не было',
    columns: [
      { key: 'name', title: 'Сервис', render: (r) => `<span class="cell-main">${logoHTML(r, 'sm')}<b>${esc(r.name)}</b></span>` },
      { key: 'clients', title: 'Клиенты', num: true, render: (r) => fmt(r.clients) },
      { key: 'clicks', title: 'Переходы', num: true, render: (r) => fmt(r.clicks) }
    ]
  });
  return charts(root, [
    ['#chClicks', d.clicks_by_day, 'n', ['переход', 'перехода', 'переходов']],
    ['#chUsers', d.users_by_day, 'n', ['пользователь', 'пользователя', 'пользователей']]
  ]);
}

/* ---------------- Services ---------------- */
function serviceTags(s) {
  const out = [];
  if (s.hidden) out.push(tag('Скрыт', 'bad'));
  out.push(s.status === 'published' ? tag('В каталоге', 'good') : tag('Черновик'));
  if (s.pending) out.push(tag('Ждёт модерации', 'warn'));
  return out.join(' ');
}

export async function services(root) {
  const { items } = await get('/api/admin/services');
  let filter = 'all';
  let q = '';
  const FILTERS = [
    ['all', `Все <span class="n">${items.length}</span>`],
    ['published', `В каталоге <span class="n">${items.filter((s) => s.status === 'published' && !s.hidden).length}</span>`],
    ['draft', `Черновики <span class="n">${items.filter((s) => s.status === 'draft').length}</span>`],
    ['hidden', `Скрытые <span class="n">${items.filter((s) => s.hidden).length}</span>`],
    ['pending', `Ждут модерации <span class="n">${items.filter((s) => s.pending).length}</span>`]
  ];
  root.innerHTML = `
    ${head('Сервисы', `${exportButton('services')}<a class="solid btn sm press" href="#/admin/services/new">${icon.plus} Добавить сервис</a>`)}
    <div class="toolbar">
      <form class="lg search" id="sSearch" role="search">${icon.search}<input type="search" placeholder="Название или бот" aria-label="Поиск сервиса" autocomplete="off"></form>
      <div id="sFilters">${chips(FILTERS, filter, 'data-f')}</div>
    </div>
    <div id="sTable"></div>`;
  const pick = () => items.filter((s) => {
    if (filter === 'published' && !(s.status === 'published' && !s.hidden)) return false;
    if (filter === 'draft' && s.status !== 'draft') return false;
    if (filter === 'hidden' && !s.hidden) return false;
    if (filter === 'pending' && !s.pending) return false;
    const needle = q.toLocaleLowerCase('ru');
    return !needle || s.name.toLocaleLowerCase('ru').includes(needle) || s.bot_url.toLowerCase().includes(needle);
  });
  const table = dataTable($('#sTable', root), {
    rows: pick(),
    href: (s) => `/admin/services/${s.id}`,
    sort: { key: 'name', dir: 1 },
    columns: [
      { key: 'name', title: 'Сервис', render: (s) => `<span class="cell-main">${logoHTML(s, 'sm')}<span><b>${esc(s.name)}</b><small>${esc(s.bot_url.replace('https://t.me/', '@'))}</small></span></span>` },
      { key: 'status', title: 'Статус', value: (s) => (s.hidden ? 2 : s.status === 'published' ? 0 : 1), render: serviceTags },
      { key: 'owner_username', title: 'Владелец', value: (s) => s.owner_username || s.owner_name || '', render: (s) => (s.owner_id ? who({ username: s.owner_username, first_name: s.owner_name, id: s.owner_id }) : '<span class="muted">—</span>') },
      { key: 'min_monthly', title: 'От ₽/мес', num: true, render: (s) => (s.min_monthly ? rub(s.min_monthly) : '—') },
      { key: 'rating', title: 'Рейтинг', num: true, render: (s) => (s.rating ? `★ ${String(s.rating).replace('.', ',')} <span class="muted">(${s.reviews})</span>` : '—') },
      { key: 'clients30', title: 'Клиенты 30 дн', num: true, render: (s) => fmt(s.clients30) },
      { key: 'favorites', title: 'Избранное', num: true, render: (s) => fmt(s.favorites) },
      { key: 'last_check', title: 'Проверка', num: true, render: (s) => (s.last_check ? `<span style="color:${s.last_passed ? 'var(--good)' : 'var(--bad)'}">${s.last_passed ? '✓' : '✕'}</span> ${dateShort(s.last_check)}` : '<span class="muted">нет</span>') }
    ]
  });
  let t;
  $('#sSearch input', root).addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { q = e.target.value.trim(); table.update(pick()); }, 150); });
  $('#sSearch', root).addEventListener('submit', (e) => e.preventDefault());
  $('#sFilters', root).addEventListener('click', (e) => {
    const b = e.target.closest('[data-f]');
    if (!b) return;
    haptic.select();
    filter = b.dataset.f;
    $('#sFilters', root).innerHTML = chips(FILTERS, filter, 'data-f');
    table.update(pick());
  });
  bindExports(root);
  return () => clearTimeout(t);
}

function cardKV(c) {
  const list = (arr, dict) => esc(arr.map((x) => dict[x]?.name || x).join(', ') || '—');
  const rows = [
    ['Бот', c.bot_url ? `<a href="${esc(c.bot_url)}" target="_blank" rel="noopener">${esc(c.bot_url.replace('https://', ''))}</a>` : '—'],
    ['Канал', c.channel_url ? `<a href="${esc(c.channel_url)}" target="_blank" rel="noopener">${esc(c.channel_url.replace('https://', ''))}</a>` : '—'],
    ['Поддержка', esc(c.support_contact || '—')],
    ['Тарифы', TARIFF_MONTHS.filter((m) => c.tariffs[m]).map((m) => `${monthsWord(m)} — ${rub(c.tariffs[m])}`).join('<br>') || '—'],
    ['Устройства', `до ${c.devices}`],
    ['Протоколы', list(c.protocols, PROTOCOL)],
    ['Страны', esc(c.countries.map((x) => `${COUNTRY[x]?.flag || ''} ${COUNTRY[x]?.name || x}`).join(', ') || '—')],
    ['Платформы', list(c.platforms, PLATFORM)],
    ['Оплата', esc(paymentsText(c.payments) || '—')],
    ['Белые списки', c.whitelist_bypass ? `Да${c.whitelist_note ? ` — ${esc(c.whitelist_note)}` : ''}` : 'Нет'],
    ['Триал', c.trial ? `${c.trial_days ? `${c.trial_days} дн.` : 'Есть'}${c.trial_terms ? ` — ${esc(c.trial_terms)}` : ''}` : 'Нет'],
    ['Описание', esc(c.description || '—')]
  ];
  return `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
}

function editorPage(root, { title, crumbs, draft, submitText, onSubmit }) {
  root.innerHTML = `
    <div class="crumbs">${crumbs}</div>
    ${head(title)}
    <div style="max-width:760px" id="edBox">${editorHTML(draft)}
      <p class="note">Изменения админа публикуются сразу, без модерации, и попадают в журнал. Владелец получит уведомление.</p></div>`;
  const box = $('#edBox', root);
  const submit = async (card) => {
    const err = $('#cardErr', box);
    err.hidden = true;
    mainProgress(true);
    try { await onSubmit(card); } catch (e) {
      mainProgress(false);
      err.textContent = e.message;
      err.hidden = false;
      err.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };
  const collect = bindEditor(box, draft, submit);
  setMain({ text: submitText, onClick: () => submit(collect()) });
}

export async function serviceNew(root, { navigate }) {
  editorPage(root, {
    title: 'Новый сервис',
    crumbs: '<a href="#/admin/services">Сервисы</a> / новый',
    draft: { tariffs: {}, protocols: [], countries: [], platforms: [], payments: [], devices: 1 },
    submitText: 'Опубликовать в каталоге',
    onSubmit: async (card) => {
      const { id } = await post('/api/admin/services', card);
      haptic.notify('success');
      toast('Сервис опубликован');
      navigate(`/admin/services/${id}`);
    }
  });
}

export async function serviceDetail(root, { params, navigate, refresh }) {
  const id = Number(params.id);
  const d = await get(`/api/admin/services/${id}`);
  const s = d.service;
  const clicks30 = d.daily.reduce((n, x) => n + x.clicks, 0);
  const visible = s.status === 'published' && !s.hidden;

  root.innerHTML = `
    <div class="crumbs"><a href="#/admin/services">Сервисы</a> / ${esc(s.name)}</div>
    <div class="detail-head">
      ${logoHTML(s, 'xl')}
      <div class="grow"><h1>${esc(s.name)}</h1><div class="badges" style="margin-top:6px">${serviceTags({ ...s, pending: d.revisions.some((r) => r.status === 'pending') })}
        ${s.min_monthly ? tag(`от ${rub(s.min_monthly)}/мес`) : ''}</div></div>
      <div class="row-flex" style="flex-wrap:wrap">
        ${visible ? `<a class="fill btn sm press" href="../#/service/${id}" target="_blank" rel="noopener">В каталоге ↗</a>` : ''}
        <button type="button" class="solid btn sm press" id="edit">Редактировать карточку</button>
      </div>
    </div>
    <div class="kpi-grid">
      ${kpi('Рейтинг', d.rating.n ? `★ ${String(d.rating.avg).replace('.', ',')}` : '—', `${fmt(d.rating.n)} ${plural(d.rating.n, 'отзыв', 'отзыва', 'отзывов')}${d.reviews_by_status.pending ? ` · ${d.reviews_by_status.pending} на модерации` : ''}`)}
      ${kpi('Переходы, 30 дней', fmt(clicks30))}
      ${kpi('В избранном', fmt(d.favorites))}
      ${kpi('Опубликован', s.published_at ? dateShort(s.published_at) : '—', s.updated_at ? `обновлён ${dateShort(s.updated_at)}` : '')}
    </div>
    <div class="grid-2">
      <div class="card panel stack-sm"><h3>Переходы в бот</h3><div class="chart-box" id="chClicks"></div></div>
      <div class="card panel stack-sm"><h3>Показы карточки</h3><div class="chart-box" id="chImp"></div></div>
    </div>
    <div class="grid-2">
      <section class="stack">
        <h2 class="section-title" style="margin:0">Управление</h2>
        <div class="card group">
          <div class="row"><span style="display:flex;flex-direction:column"><span>Владелец</span><span class="small muted">${d.owner ? `${who(d.owner)} · ${d.owner.id}` : 'не назначен'}</span></span>
            <span class="row-flex">${d.owner ? `<a class="link-btn" href="#/admin/users/${d.owner.id}">Профиль</a>` : ''}<button type="button" class="fill btn sm press" id="owner">${d.owner ? 'Сменить' : 'Назначить'}</button></span></div>
          <div class="row"><span style="display:flex;flex-direction:column"><span>Ручная проверка</span><span class="small muted">${d.checks[0] ? `${d.checks[0].passed ? '✓ работает' : '✕ не работает'} · ${dateShort(d.checks[0].checked_at)}` : 'ещё не было'}</span></span>
            <span class="row-flex"><button type="button" class="fill btn sm press danger" id="fail">✕</button><button type="button" class="lgb btn sm press" id="pass">✓ Работает</button></span></div>
          <div class="row"><span style="display:flex;flex-direction:column"><span>Видимость в каталоге</span><span class="small muted">${s.hidden ? `скрыт: ${esc(s.hidden_reason || '')}` : visible ? 'виден клиентам' : 'черновик — ещё не опубликован'}</span></span>
            ${s.hidden ? '<button type="button" class="fill btn sm press" id="unhide">Вернуть</button>' : '<button type="button" class="fill btn sm press danger" id="hide">Скрыть</button>'}</div>
          <div class="row"><span>Бот сервиса</span><button type="button" class="fill btn sm press" id="openBot">${icon.bot} Открыть</button></div>
        </div>
        <div class="card panel stack-sm danger-zone">
          <h3>Удалить сервис</h3>
          <p class="note" style="padding:0">Удаляются карточка, тарифы, отзывы, переходы, статистика и места в топе. Отменить нельзя — если нужно убрать временно, скройте карточку.</p>
          <button type="button" class="fill btn sm press danger" id="del" style="align-self:flex-start">Удалить навсегда</button>
        </div>
      </section>
      <section><h2 class="section-title">Карточка</h2><div class="card panel">${cardKV(d.card)}</div></section>
    </div>
    <section><h2 class="section-title">Статус по сигналам клиентов</h2><div id="healthSec"></div></section>
    <div class="grid-2">
      <section><h2 class="section-title">История проверок</h2><div id="tChecks"></div></section>
      <section class="stack"><div><h2 class="section-title">Версии карточки</h2><div id="tRevs"></div></div><div><h2 class="section-title">Акции</h2><div id="tPromos"></div></div></section>
    </div>`;

  dataTable($('#tChecks', root), {
    rows: d.checks, empty: 'Проверок ещё не было', columns: [
      { key: 'checked_at', title: 'Когда', render: (c) => dateTime(c.checked_at), cls: 'nowrap' },
      { key: 'passed', title: 'Итог', render: (c) => (c.passed ? tag('работает', 'good') : tag('не работает', 'bad')) },
      { key: 'note', title: 'Комментарий', cls: 'text', render: (c) => esc(c.note || '') },
      { key: 'username', title: 'Кто', render: (c) => (c.username ? '@' + esc(c.username) : '—') }
    ]
  });
  dataTable($('#tRevs', root), {
    rows: d.revisions, empty: 'Владелец ещё не отправлял правок', columns: [
      { key: 'created_at', title: 'Отправлена', render: (r) => dateTime(r.created_at), cls: 'nowrap' },
      { key: 'status', title: 'Статус', render: (r) => tag(MODERATION_STATUS[r.status] || r.status, r.status === 'approved' ? 'good' : r.status === 'rejected' ? 'bad' : r.status === 'pending' ? 'warn' : 'neutral') },
      { key: 'reject_reason', title: 'Причина', cls: 'text', render: (r) => esc(r.reject_reason || '') }
    ]
  });
  dataTable($('#tPromos', root), {
    rows: d.promos, empty: 'Акций не было', columns: [
      { key: 'title', title: 'Акция', cls: 'text', render: (p) => `${esc(p.title)}${p.discount_percent ? ` <b>−${p.discount_percent}%</b>` : ''}` },
      { key: 'starts_at', title: 'Срок', cls: 'nowrap', render: (p) => `${dateShort(p.starts_at)} – ${dateShort(p.ends_at)}` },
      { key: 'status', title: 'Статус', render: (p) => tag(MODERATION_STATUS[p.status] || p.status, p.status === 'approved' ? 'good' : p.status === 'pending' ? 'warn' : 'neutral') }
    ]
  });

  $('#edit', root).addEventListener('click', () => editorPage(root, {
    title: `Редактирование: ${esc(s.name)}`,
    crumbs: `<a href="#/admin/services">Сервисы</a> / <a href="#/admin/services/${id}">${esc(s.name)}</a> / редактирование`,
    draft: d.card,
    submitText: 'Сохранить и опубликовать',
    onSubmit: async (card) => {
      await api(`/api/admin/services/${id}/card`, { method: 'PUT', body: card });
      haptic.notify('success');
      toast('Карточка обновлена');
      refresh();
    }
  }));
  $('#openBot', root).addEventListener('click', () => openLink(d.card.bot_url));
  $('#pass', root).addEventListener('click', async () => { if (await act(() => post(`/api/admin/services/${id}/checks`, { passed: true }), 'Проверка записана')) refresh(); });
  $('#fail', root).addEventListener('click', async () => {
    const note = await reasonSheet('Что не работает', 'Например: не подключается на МТС');
    if (note && (await act(() => post(`/api/admin/services/${id}/checks`, { passed: false, note }), 'Проверка записана'))) refresh();
  });
  $('#hide', root)?.addEventListener('click', async () => {
    const reason = await reasonSheet('Скрыть из каталога', 'Причина — её увидит владелец в кабинете');
    if (reason && (await act(() => post(`/api/admin/services/${id}/hide`, { reason }), 'Карточка скрыта'))) refresh();
  });
  $('#unhide', root)?.addEventListener('click', async () => { if (await act(() => post(`/api/admin/services/${id}/unhide`), 'Карточка снова в каталоге')) refresh(); });
  $('#owner', root).addEventListener('click', () => openSheet('Владелец сервиса', `
      <label class="field"><span>Telegram ID нового владельца</span><input class="input" id="ownId" inputmode="numeric" placeholder="Например, 123456789" value="${d.owner?.id || ''}"></label>
      <p class="note">Человек должен хотя бы раз открыть Линзу. ID видно в разделе «Пользователи». Владелец получит доступ к кабинету и уведомление в боте.</p>
      ${d.owner ? '<button type="button" class="fill btn press danger" id="ownClear">Убрать владельца</button>' : ''}
      <div class="err" id="ownErr" hidden></div>`, (sheet) => {
    const save = async (userId) => {
      try { await post(`/api/admin/services/${id}/owner`, { user_id: userId }); closeSheet(true); toast('Владелец обновлён'); refresh(); } catch (e) { $('#ownErr', sheet).textContent = e.message; $('#ownErr', sheet).hidden = false; }
    };
    $('#ownClear', sheet)?.addEventListener('click', () => save(null));
    setSheetMain({ text: 'Сохранить', onClick: () => save($('#ownId', sheet).value.trim()) });
  }));
  $('#del', root).addEventListener('click', () => openSheet('Удалить сервис', `
      <p class="note" style="font-size:15px">Это удалит «${esc(s.name)}» со всеми отзывами и статистикой без возможности восстановления. Введите название сервиса для подтверждения.</p>
      <input class="input" id="delName" placeholder="${esc(s.name)}" autocomplete="off">
      <div class="err" id="delErr" hidden></div>`, (sheet) => {
    setSheetMain({
      text: 'Удалить навсегда',
      onClick: async () => {
        try {
          await api(`/api/admin/services/${id}`, { method: 'DELETE', body: { confirm: $('#delName', sheet).value } });
          closeSheet(true);
          toast('Сервис удалён');
          navigate('/admin/services');
        } catch (e) { $('#delErr', sheet).textContent = e.message; $('#delErr', sheet).hidden = false; }
      }
    });
  }));

  const stopVotes = await serviceVotes($('#healthSec', root), id, refresh);
  const stopCharts = charts(root, [
    ['#chClicks', d.daily, 'clicks', ['переход', 'перехода', 'переходов']],
    ['#chImp', d.daily, 'impressions', ['показ', 'показа', 'показов']]
  ]);
  return () => { stopVotes(); stopCharts(); };
}

/* ---------------- Users ---------------- */
const roleTags = (u) => [
  ...(u.roles || []).filter((r) => ROLE_NAMES[r]).map((r) => tag(ROLE_NAMES[r], r === 'admin' ? 'warn' : '')),
  u.is_blocked ? tag('заблокирован', 'bad') : ''
].join(' ');

export async function users(root, { query }) {
  let q = query.q || '';
  let role = query.role || '';
  let items = [];
  let total = 0;
  const ROLES = [['', 'Все'], ['admin', 'Админы'], ['vpn_owner', 'Владельцы VPN'], ['blocked', 'Заблокированные']];
  root.innerHTML = `
    ${head('Пользователи', exportButton('users'))}
    <div class="toolbar">
      <form class="lg search" id="uSearch" role="search">${icon.search}<input type="search" value="${esc(q)}" placeholder="ID, @username или имя" aria-label="Поиск пользователя" autocomplete="off"></form>
      <div id="uRoles">${chips(ROLES, role, 'data-role')}</div>
    </div>
    <div class="muted small" id="uTotal"></div>
    <div id="uTable"></div>
    <div class="more-row"><button type="button" class="fill btn press" id="uMore" hidden>Показать ещё</button></div>`;
  const table = dataTable($('#uTable', root), {
    rows: [],
    href: (u) => `/admin/users/${u.id}`,
    columns: [
      { key: 'first_name', title: 'Пользователь', render: (u) => `<span class="cell-main">${avatarHTML(u)}<span><b>${esc([u.first_name, u.last_name].filter(Boolean).join(' ') || '—')}</b><small>${u.username ? '@' + esc(u.username) : 'без username'}</small></span></span>` },
      { key: 'id', title: 'Telegram ID', num: true },
      { key: 'roles', title: 'Роли', value: (u) => (u.roles || []).length, render: roleTags },
      { key: 'last_seen_at', title: 'Заходил', num: true, render: (u) => dateTime(u.last_seen_at) },
      { key: 'created_at', title: 'Впервые', num: true, render: (u) => dateShort(u.created_at) },
      { key: 'services_clicked', title: 'Переходы', num: true },
      { key: 'reviews', title: 'Отзывы', num: true },
      { key: 'favorites', title: 'Избранное', num: true },
      { key: 'bot_chat_allowed', title: 'Бот', num: true, render: (u) => (u.bot_chat_allowed ? '✓' : '<span class="muted">—</span>') }
    ]
  });
  const load = async (reset) => {
    const data = await get(`/api/admin/users?q=${encodeURIComponent(q)}&role=${role}&offset=${reset ? 0 : items.length}`);
    items = reset ? data.items : [...items, ...data.items];
    total = data.total;
    table.update(items);
    $('#uTotal', root).textContent = `${fmt(total)} ${plural(total, 'пользователь', 'пользователя', 'пользователей')}`;
    $('#uMore', root).hidden = items.length >= total;
    history.replaceState(null, '', `#/admin/users${q || role ? `?${new URLSearchParams({ ...(q ? { q } : {}), ...(role ? { role } : {}) })}` : ''}`);
  };
  let t;
  $('#uSearch input', root).addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { q = e.target.value.trim(); load(true).catch(toastError); }, 300); });
  $('#uSearch', root).addEventListener('submit', (e) => e.preventDefault());
  $('#uRoles', root).addEventListener('click', (e) => {
    const b = e.target.closest('[data-role]');
    if (!b) return;
    haptic.select();
    role = b.dataset.role;
    $('#uRoles', root).innerHTML = chips(ROLES, role, 'data-role');
    load(true).catch(toastError);
  });
  $('#uMore', root).addEventListener('click', () => load(false).catch(toastError));
  bindExports(root);
  await load(true);
  return () => clearTimeout(t);
}

export async function userDetail(root, { params, refresh }) {
  const id = Number(params.id);
  const d = await get(`/api/admin/users/${id}`);
  const u = d.user;
  const isAdmin = u.roles.includes('admin');
  const isOwner = u.roles.includes('vpn_owner');
  const isMe = store.me?.id === id;
  root.innerHTML = `
    <div class="crumbs"><a href="#/admin/users">Пользователи</a> / ${who(u)}</div>
    <div class="detail-head">
      ${avatarHTML(u, 'lg-size')}
      <div class="grow"><h1>${esc([u.first_name, u.last_name].filter(Boolean).join(' ') || '—')}</h1>
        <div class="muted">${u.username ? '@' + esc(u.username) + ' · ' : ''}ID ${u.id}</div>
        <div class="badges" style="margin-top:8px">${roleTags(u)}${u.env_admin ? tag('из ADMIN_IDS') : ''}</div></div>
      ${u.username ? `<a class="fill btn sm press" href="https://t.me/${esc(u.username)}" target="_blank" rel="noopener">Написать в Telegram ↗</a>` : ''}
    </div>
    <div class="kpi-grid">
      ${kpi('Впервые зашёл', dateShort(u.created_at))}
      ${kpi('Последний вход', dateTime(u.last_seen_at))}
      ${kpi('В избранном', fmt(d.favorites))}
      ${kpi('Бот может писать', u.bot_chat_allowed ? 'Да' : 'Нет')}
    </div>
    <div class="grid-2">
      <section><h2 class="section-title">Роли и доступ</h2>
        <div class="card group">
          <div class="row"><span style="display:flex;flex-direction:column"><span>Администратор</span><span class="small muted">${u.env_admin ? 'задан в ADMIN_IDS на сервере' : 'полный доступ к панели'}</span></span>
            ${isAdmin ? `<button type="button" class="fill btn sm press danger" data-role="admin" data-grant="0" ${u.env_admin || isMe ? 'disabled' : ''}>Снять</button>` : '<button type="button" class="lgb btn sm press" data-role="admin" data-grant="1">Назначить</button>'}</div>
          <div class="row"><span style="display:flex;flex-direction:column"><span>VPN-сервис</span><span class="small muted">доступ к кабинету владельца</span></span>
            ${isOwner ? '<button type="button" class="fill btn sm press danger" data-role="vpn_owner" data-grant="0">Снять</button>' : '<button type="button" class="fill btn sm press" data-role="vpn_owner" data-grant="1">Выдать</button>'}</div>
          <div class="row"><span style="display:flex;flex-direction:column"><span>Блокировка</span><span class="small muted">${u.is_blocked ? `заблокирован: ${esc(u.blocked_reason || '')}` : 'может писать отзывы и подавать заявки'}</span></span>
            ${u.is_blocked ? '<button type="button" class="fill btn sm press" id="unblock">Разблокировать</button>' : `<button type="button" class="fill btn sm press danger" id="block" ${u.env_admin || isMe ? 'disabled' : ''}>Заблокировать</button>`}</div>
        </div>
      </section>
      <section><h2 class="section-title">Сервисы и заявки</h2>
        <div class="card group">
          ${d.services.map((s) => `<a class="row press" href="#/admin/services/${s.id}" style="color:inherit"><span>${esc(s.name)}</span><span class="row-flex">${s.hidden ? tag('скрыт', 'bad') : s.status === 'published' ? tag('в каталоге', 'good') : tag('черновик')}${icon.chev}</span></a>`).join('')}
          ${d.applications.map((a) => `<div class="row"><span style="display:flex;flex-direction:column"><span>Заявка «${esc(a.name)}»</span><span class="small muted">${dateShort(a.created_at)}</span></span>${tag(MODERATION_STATUS[a.status] || a.status, a.status === 'approved' ? 'good' : a.status === 'rejected' ? 'bad' : 'warn')}</div>`).join('')}
          ${!d.services.length && !d.applications.length ? '<div class="row muted">Нет сервисов и заявок</div>' : ''}
        </div>
      </section>
    </div>
    <div class="grid-2">
      <section><h2 class="section-title">Отзывы</h2><div id="tRev"></div></section>
      <section><h2 class="section-title">Переходы в боты</h2><div id="tClicks"></div></section>
    </div>`;
  dataTable($('#tRev', root), {
    rows: d.reviews, empty: 'Отзывов нет', columns: [
      { key: 'service_name', title: 'Сервис' },
      { key: 'rating', title: 'Оценка', render: (r) => stars(r.rating) },
      { key: 'text', title: 'Текст', cls: 'text' },
      { key: 'status', title: 'Статус', render: (r) => tag(r.status === 'approved' ? 'опубликован' : MODERATION_STATUS[r.status], r.status === 'approved' ? 'good' : r.status === 'rejected' ? 'bad' : 'warn') }
    ]
  });
  dataTable($('#tClicks', root), {
    rows: d.clicks, empty: 'Переходов нет', columns: [
      { key: 'name', title: 'Сервис' },
      { key: 'n', title: 'Раз', num: true },
      { key: 'last_at', title: 'Последний', num: true, render: (c) => dateTime(c.last_at) }
    ]
  });
  $$('[data-role]', root).forEach((b) => b.addEventListener('click', async () => {
    const grant = b.dataset.grant === '1';
    const label = b.dataset.role === 'admin' ? 'администратора' : 'VPN-сервиса';
    if (!(await confirmDialog(`${grant ? 'Выдать' : 'Снять'} роль ${label} для ${who(u).replace(/&[^;]+;/g, '')}?`))) return;
    if (await act(() => post(`/api/admin/users/${id}/roles`, { role: b.dataset.role, grant }), 'Роли обновлены')) refresh();
  }));
  $('#block', root)?.addEventListener('click', async () => {
    const reason = await reasonSheet('Заблокировать пользователя');
    if (reason && (await act(() => post(`/api/admin/users/${id}/block`, { reason }), 'Пользователь заблокирован'))) refresh();
  });
  $('#unblock', root)?.addEventListener('click', async () => { if (await act(() => post(`/api/admin/users/${id}/unblock`), 'Пользователь разблокирован')) refresh(); });
}

/* ---------------- Reviews ---------------- */
export async function reviews(root, { query }) {
  let status = query.status || '';
  let q = '';
  let items = [];
  let total = 0;
  const STATUSES = [['', 'Все'], ['pending', 'На модерации'], ['approved', 'Опубликованы'], ['rejected', 'Отклонены']];
  root.innerHTML = `
    ${head('Отзывы', exportButton('reviews'))}
    <div class="toolbar">
      <form class="lg search" id="rSearch" role="search">${icon.search}<input type="search" placeholder="Сервис, текст или @username" aria-label="Поиск отзывов" autocomplete="off"></form>
      <div id="rStatus">${chips(STATUSES, status, 'data-st')}</div>
    </div>
    <div class="muted small" id="rTotal"></div>
    <div id="rTable"></div>
    <div class="more-row"><button type="button" class="fill btn press" id="rMore" hidden>Показать ещё</button></div>`;
  const table = dataTable($('#rTable', root), {
    rows: [],
    columns: [
      { key: 'service_name', title: 'Сервис', render: (r) => `<a href="#/admin/services/${r.service_id}">${esc(r.service_name)}</a>` },
      { key: 'rating', title: 'Оценка', num: true, render: (r) => stars(r.rating) },
      { key: 'text', title: 'Текст', cls: 'text', render: (r) => `${esc(r.text)}${r.status === 'rejected' && r.reject_reason ? `<br><span class="small" style="color:var(--bad)">Причина: ${esc(r.reject_reason)}</span>` : ''}` },
      { key: 'username', title: 'Автор', render: (r) => `<a href="#/admin/users/${r.user_id}">${who(r)}</a>` },
      { key: 'updated_at', title: 'Дата', num: true, render: (r) => dateShort(r.updated_at) },
      { key: 'status', title: 'Статус', render: (r) => tag(r.status === 'approved' ? 'опубликован' : MODERATION_STATUS[r.status], r.status === 'approved' ? 'good' : r.status === 'rejected' ? 'bad' : 'warn') },
      { key: 'actions', title: '', sortable: false, render: (r) => `<span class="row-flex" style="justify-content:flex-end">${r.status !== 'approved' ? `<button type="button" class="lgb btn sm press" data-approve="${r.id}">Опубликовать</button>` : ''}${r.status !== 'rejected' ? `<button type="button" class="fill btn sm press danger" data-reject="${r.id}">Скрыть</button>` : ''}</span>` }
    ]
  });
  const load = async (reset) => {
    const data = await get(`/api/admin/reviews?status=${status}&q=${encodeURIComponent(q)}&offset=${reset ? 0 : items.length}`);
    items = reset ? data.items : [...items, ...data.items];
    total = data.total;
    table.update(items);
    $('#rTotal', root).textContent = `${fmt(total)} ${plural(total, 'отзыв', 'отзыва', 'отзывов')}`;
    $('#rMore', root).hidden = items.length >= total;
  };
  // #view outlives this screen, so the delegated listener is removed on leave.
  const ac = new AbortController();
  root.addEventListener('click', async (e) => {
    const ap = e.target.closest('[data-approve]');
    const rj = e.target.closest('[data-reject]');
    if (ap && (await act(() => post(`/api/admin/reviews/${ap.dataset.approve}/status`, { status: 'approved' }), 'Отзыв опубликован'))) load(true);
    if (rj) {
      const reason = await reasonSheet('Скрыть отзыв', 'Причина — автор увидит её в профиле');
      if (reason && (await act(() => post(`/api/admin/reviews/${rj.dataset.reject}/status`, { status: 'rejected', reason }), 'Отзыв скрыт'))) load(true);
    }
  }, { signal: ac.signal });
  let t;
  $('#rSearch input', root).addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { q = e.target.value.trim(); load(true).catch(toastError); }, 300); });
  $('#rSearch', root).addEventListener('submit', (e) => e.preventDefault());
  $('#rStatus', root).addEventListener('click', (e) => {
    const b = e.target.closest('[data-st]');
    if (!b) return;
    haptic.select();
    status = b.dataset.st;
    $('#rStatus', root).innerHTML = chips(STATUSES, status, 'data-st');
    load(true).catch(toastError);
  });
  $('#rMore', root).addEventListener('click', () => load(false).catch(toastError));
  bindExports(root);
  await load(true);
  return () => { clearTimeout(t); ac.abort(); };
}

/* ---------------- Broadcast ---------------- */
export async function broadcast(root) {
  let audience = 'all';
  let reach = null;
  root.innerHTML = `
    ${head('Рассылка')}
    <p class="note" style="font-size:15px;padding:0">Сообщение уйдёт от бота Линзы с кнопкой «Открыть Линзу». Его не получат те, кто отключил «Новости Линзы» в профиле, и те, кому бот не может писать. Отправка идёт очередью — около 25 сообщений в секунду.</p>
    <label class="field"><span>Текст сообщения</span><textarea class="input" id="bText" maxlength="3000" style="min-height:180px" placeholder="Например: в Линзе появились акции на годовые тарифы — загляните в «Скидки и акции»."></textarea></label>
    <div class="small muted" id="bCount" style="text-align:right;margin-top:-14px">0 / 3000</div>
    <div><p class="label">Кому</p><div id="bAud">${segHTML([{ id: 'all', name: 'Всем' }, { id: 'clients', name: 'Клиентам' }, { id: 'owners', name: 'Владельцам VPN' }], audience)}</div></div>
    <div class="card panel row-flex between"><span id="bReach" class="muted">Нажмите «Проверить охват», чтобы узнать число получателей</span><button type="button" class="fill btn sm press" id="bCheck">Проверить охват</button></div>`;
  const text = $('#bText', root);
  const refreshMain = () => setMain({ text: reach === null ? 'Отправить рассылку' : `Отправить ${fmt(reach)} ${plural(reach, 'получателю', 'получателям', 'получателям')}`, onClick: send, disabled: text.value.trim().length < 5 });
  const check = async () => {
    try {
      const r = await post('/api/admin/broadcast', { text: text.value || 'проверка охвата', audience, dry_run: true });
      reach = r.recipients;
      $('#bReach', root).innerHTML = `Получат: <b>${fmt(reach)}</b> ${plural(reach, 'человек', 'человека', 'человек')}`;
      refreshMain();
    } catch (e) { toastError(e); }
  };
  async function send() {
    const body = text.value.trim();
    if (body.length < 5) { toast('Напишите текст сообщения', 'error'); return; }
    if (!(await confirmDialog(`Отправить сообщение ${reach !== null ? `${reach} получателям` : 'выбранной аудитории'}? Отменить рассылку после отправки нельзя.`))) return;
    mainProgress(true);
    const r = await act(() => post('/api/admin/broadcast', { text: body, audience }));
    mainProgress(false);
    if (r) {
      toast(`Поставлено в очередь: ${fmt(r.recipients)}`);
      text.value = '';
      reach = null;
      $('#bReach', root).textContent = 'Отправлено. Ход доставки — в разделе «Уведомления».';
      refreshMain();
    }
  }
  text.addEventListener('input', () => { $('#bCount', root).textContent = `${text.value.length} / 3000`; refreshMain(); });
  bindSeg($('#bAud .seg', root), (v) => { audience = v; reach = null; check(); });
  $('#bCheck', root).addEventListener('click', check);
  refreshMain();
  check();
}

/* ---------------- Notifications outbox ---------------- */
const TYPE_NAMES = { moderation: 'модерация', news: 'рассылка', ...Object.fromEntries(NOTIFY_TYPES.map((t) => [t.id, t.name.toLowerCase()])) };
const STATUS_NAMES = { queued: ['в очереди', 'warn'], sent: ['отправлено', 'good'], failed: ['ошибка', 'bad'], skipped: ['пропущено', 'neutral'] };

export async function notifications(root, { query }) {
  let status = query.status || '';
  const draw = async () => {
    const d = await get(`/api/admin/notifications${status ? `?status=${status}` : ''}`);
    const all = Object.values(d.counts).reduce((a, b) => a + b, 0);
    root.innerHTML = `
      ${head('Уведомления')}
      <p class="note" style="font-size:15px;padding:0">Последние 100 сообщений бота. «Пропущено» — человек не запускал бота или запретил ему писать.</p>
      <div id="nStatus">${chips([['', `Все <span class="n">${all}</span>`], ...Object.entries(STATUS_NAMES).map(([k, [n]]) => [k, `${n[0].toUpperCase() + n.slice(1)} <span class="n">${d.counts[k] || 0}</span>`])], status, 'data-st')}</div>
      <div id="nTable"></div>`;
    dataTable($('#nTable', root), {
      rows: d.items, empty: 'Сообщений нет', columns: [
        { key: 'created_at', title: 'Создано', num: true, render: (n) => dateTime(n.created_at) },
        { key: 'user_id', title: 'Кому', render: (n) => `<a href="#/admin/users/${n.user_id}">${who({ username: n.username, first_name: n.first_name, id: n.user_id })}</a>` },
        { key: 'type', title: 'Тип', render: (n) => esc(TYPE_NAMES[n.type] || n.type) },
        { key: 'text', title: 'Текст', cls: 'text', render: (n) => esc(n.text.replace(/<[^>]+>/g, '').slice(0, 160)) },
        { key: 'status', title: 'Статус', render: (n) => tag(...(STATUS_NAMES[n.status] || [n.status, 'neutral'])) },
        { key: 'error', title: 'Ошибка', cls: 'text', render: (n) => esc(n.error || '') }
      ]
    });
    $('#nStatus', root).addEventListener('click', (e) => {
      const b = e.target.closest('[data-st]');
      if (!b) return;
      haptic.select();
      status = b.dataset.st;
      history.replaceState(null, '', `#/admin/notifications${status ? `?status=${status}` : ''}`);
      draw().catch(toastError);
    });
  };
  await draw();
}

/* ---------------- Settings ---------------- */
export async function settings(root, { refresh }) {
  const [s, sess] = await Promise.all([get('/api/admin/settings'), get('/api/admin/sessions')]);
  const me = store.me;
  root.innerHTML = `
    ${head('Настройки')}
    <div class="grid-2">
      <section><h2 class="section-title">Рейтинг и рынок</h2>
        <div class="card panel stack">
          <label class="field"><span>Сглаживание оценки в топе месяца</span><input class="input" id="sPrior" type="number" min="0" max="50" step="1" value="${s.top_rating_prior}"></label>
          <p class="note" style="padding:0;margin-top:-6px">Сколько «средних» отзывов добавляется к каждому сервису при расчёте оценки за месяц. Чем больше, тем меньше влияние единичных отзывов. По умолчанию 3.</p>
          <label class="field"><span>Порог метки «ниже / выше рынка», %</span><input class="input" id="sBand" type="number" min="2" max="50" step="1" value="${Math.round(s.market_band * 100)}"></label>
          <p class="note" style="padding:0;margin-top:-6px">Цена дешевле средней больше чем на этот процент — «ниже рынка», дороже — «выше рынка». По умолчанию 10%.</p>
          <p class="note" style="padding:0">Веса сводного балла (сейчас ${Math.round(s.top_weights.rating * 100)}/${Math.round(s.top_weights.clients * 100)}/${Math.round(s.top_weights.stability * 100)}) настраиваются в разделе <a href="#/admin/top">Топ месяца</a>.</p>
          <button type="button" class="lgb btn press" id="sSave" style="align-self:flex-start">Сохранить</button>
        </div>
      </section>
      <section><h2 class="section-title">Администраторы</h2>
        <div class="card group">
          ${s.admins.map((a) => `<div class="row"><a class="cell-main" href="#/admin/users/${a.id}" style="color:inherit;min-width:0">${avatarHTML(a)}<span><b>${esc([a.first_name, a.last_name].filter(Boolean).join(' ') || '—')}</b><small>${a.username ? '@' + esc(a.username) + ' · ' : ''}${a.id}</small></span></a>
            ${a.env ? tag('ADMIN_IDS') : a.id === me.id ? tag('это вы') : `<button type="button" class="fill btn sm press danger" data-unadmin="${a.id}">Снять</button>`}</div>`).join('')}
        </div>
        <div class="row-flex" style="margin-top:12px">
          <input class="input" id="newAdmin" inputmode="numeric" placeholder="Telegram ID нового админа" style="flex:1">
          <button type="button" class="lgb btn press" id="addAdmin">Назначить</button>
        </div>
        <p class="note" style="margin-top:8px">Человек должен хотя бы раз открыть Линзу. Админы из ADMIN_IDS задаются на сервере в .env.</p>
      </section>
    </div>
    <div class="grid-2">
      <section><h2 class="section-title">Мои входы в панель</h2>
        <div class="card group">
          ${sess.items.length ? sess.items.map((x) => `<div class="row"><span style="display:flex;flex-direction:column;min-width:0"><span>${esc((x.user_agent || 'Браузер').replace(/\s*\(.*?\)\s*/g, ' ').slice(0, 60))}</span>
            <span class="small muted">вход ${dateTime(x.created_at)} · активность ${dateTime(x.last_used_at || x.created_at)}</span></span>${x.current ? tag('эта сессия', 'good') : ''}</div>`).join('')
            : '<div class="row muted">Вы вошли через Telegram — браузерных сессий нет.</div>'}
        </div>
        ${sess.items.length ? '<button type="button" class="fill btn press danger" id="revokeAll" style="margin-top:12px">Выйти на всех устройствах</button>' : ''}
        <p class="note" style="margin-top:8px">Новая ссылка для входа — команда /admin в боте. Сессия живёт 7 дней.</p>
      </section>
      <section><h2 class="section-title">Выгрузки CSV</h2>
        <div class="card panel stack-sm">
          <p class="note" style="padding:0">Файлы открываются в Excel и Google Таблицах.</p>
          <div class="chips">${exportButton('services', 'Сервисы')}${exportButton('users', 'Пользователи')}${exportButton('reviews', 'Отзывы')}${exportButton('clicks', 'Переходы в боты')}</div>
        </div>
      </section>
    </div>
    <section><h2 class="section-title">Перед запуском</h2>
      <div class="card panel stack-sm danger-zone" style="max-width:760px">
        <h3>Удалить тестовые данные</h3>
        <p class="note" style="padding:0">Удаляет демо-сервисы из <code>npm run seed</code> (боты linza_demo_…), их отзывы, переходы, акции и вымышленных пользователей. Реальные пользователи, их избранное и настройки остаются. Отменить нельзя.</p>
        <div class="row-flex"><input class="input" id="purgeWord" placeholder="Введите УДАЛИТЬ" autocomplete="off" style="flex:1"><button type="button" class="fill btn press danger" id="purge">Удалить</button></div>
      </div>
    </section>`;

  $('#sSave', root).addEventListener('click', async () => {
    if (await act(() => api('/api/admin/settings', { method: 'PUT', body: { top_rating_prior: Number($('#sPrior', root).value), market_band: Number($('#sBand', root).value) / 100 } }), 'Настройки сохранены')) refresh();
  });
  $('#addAdmin', root).addEventListener('click', async () => {
    const id = $('#newAdmin', root).value.trim();
    if (!/^\d+$/.test(id)) { toast('Введите числовой Telegram ID', 'error'); return; }
    if (!(await confirmDialog(`Назначить пользователя ${id} администратором? Он получит полный доступ к панели.`))) return;
    if (await act(() => post(`/api/admin/users/${id}/roles`, { role: 'admin', grant: true }), 'Администратор назначен')) refresh();
  });
  $$('[data-unadmin]', root).forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmDialog('Снять роль администратора? Его сессии в панели будут завершены.'))) return;
    if (await act(() => post(`/api/admin/users/${b.dataset.unadmin}/roles`, { role: 'admin', grant: false }), 'Роль снята')) refresh();
  }));
  $('#revokeAll', root)?.addEventListener('click', async () => {
    if (!(await confirmDialog('Завершить все ваши сессии в браузерах, включая эту?'))) return;
    if (await act(() => post('/api/admin/sessions/revoke-all'), 'Сессии завершены')) location.reload();
  });
  $('#purge', root).addEventListener('click', async () => {
    const word = $('#purgeWord', root).value.trim();
    if (word !== 'УДАЛИТЬ') { toast('Введите слово УДАЛИТЬ', 'error'); return; }
    if (!(await confirmDialog('Удалить все тестовые данные? Это необратимо.'))) return;
    const r = await act(() => post('/api/admin/maintenance/purge-demo', { confirm: word }));
    if (r) { toast(`Удалено: ${r.services} ${plural(r.services, 'сервис', 'сервиса', 'сервисов')}, ${r.users} ${plural(r.users, 'пользователь', 'пользователя', 'пользователей')}`); refresh(); }
  });
  bindExports(root);
}

/* ---------------- Health: disputes, anomalies, incidents ---------------- */
const STATUS_TONE = { operational: 'good', issues: 'warn', outage: 'bad' };
const CHANGE_REASON = { votes: 'по голосам', recovered: '«работает» перевесило', timeout: 'нет новых сигналов', admin_clear: 'снял администратор' };

function statusActions(id, status, verify = true) {
  return `<span class="row-flex" style="justify-content:flex-end;flex-wrap:nowrap;gap:6px">
    ${status && status !== 'operational' ? `<button type="button" class="lgb btn sm press" data-clear="${id}">Снять статус</button><button type="button" class="fill btn sm press" data-confirm="${id}">Подтвердить</button>` : ''}
    ${verify ? `<button type="button" class="fill btn sm press" data-verify="${id}">${icon.shield} Проверено</button>` : ''}</span>`;
}

// Delegated handlers for the three admin actions; resolves to true when something changed.
function bindStatusActions(root, onDone) {
  const ac = new AbortController();
  root.addEventListener('click', async (e) => {
    const clear = e.target.closest('[data-clear]');
    const confirm = e.target.closest('[data-confirm]');
    const verify = e.target.closest('[data-verify]');
    const keep = e.target.closest('[data-keep]');
    if (keep && (await confirmDialog('Сигналы честные? Аномалия закроется, голоса продолжат учитываться.'))) {
      if (await act(() => post(`/api/admin/status/anomalies/${keep.dataset.keep}/keep`), 'Аномалия закрыта')) onDone();
    }
    if (clear) {
      const note = await reasonSheet(clear.textContent.trim(), 'Комментарий для журнала: что проверили');
      if (note && (await act(() => post(`/api/admin/services/${clear.dataset.clear}/status/clear`, { note }), 'Статус снят — голоса до этого момента больше не учитываются'))) onDone();
    }
    if (confirm && (await confirmDialog('Подтвердить статус? Споры и аномалии по сервису будут закрыты, статус снимется сам, когда клиенты отметят, что всё работает.'))) {
      if (await act(() => post(`/api/admin/services/${confirm.dataset.confirm}/status/confirm`), 'Статус подтверждён')) onDone();
    }
    if (verify && (await confirmDialog('Поставить отметку «Проверено администратором» с сегодняшней датой?'))) {
      if (await act(() => post(`/api/admin/services/${verify.dataset.verify}/checks`, { passed: true }), 'Отметка поставлена')) onDone();
    }
  }, { signal: ac.signal });
  return () => ac.abort();
}

const num = (v) => String(Math.round(v * 100) / 100).replace('.', ',');
// Counts in the text, weights in the tooltip.
const windowText = (w) => `<span title="Вес: сбои ${num(w.down_w)}, работает ${num(w.up_w)}">${w.down_n} о сбоях · ${w.up_n} работает</span>`;

export async function statusScreen(root, { refresh }) {
  const d = await get('/api/admin/status');
  const cfg = d.config;
  // Empty sections are not shown: the screen lists only what needs attention.
  const calm = !d.disputes.length && !d.anomalies.length;
  root.innerHTML = `
    ${head('Статусы', '<a class="fill btn sm press" href="#/admin/status/settings">Настройки</a>')}
    ${calm ? '<p class="note" style="font-size:15px;padding:0">Споров и аномалий нет — вмешиваться не нужно.</p>' : ''}
    ${d.disputes.length ? '<section><h2 class="section-title">Споры владельцев</h2><div id="tDisputes"></div></section>' : ''}
    ${d.anomalies.length ? '<section><h2 class="section-title">Аномалии</h2><div id="tAnomalies"></div></section>' : ''}
    <section><h2 class="section-title">Сейчас со сбоями</h2><div id="tIncidents"></div></section>
    ${d.changes.length ? '<section><h2 class="section-title">Последние изменения</h2><div id="tChanges"></div></section>' : ''}`;
  if (d.disputes.length) dataTable($('#tDisputes', root), {
    rows: d.disputes, empty: 'Открытых споров нет', columns: [
      { key: 'name', title: 'Сервис', render: (x) => `<a href="#/admin/services/${x.service_id}">${esc(x.name)}</a>` },
      { key: 'status', title: 'Оспорен', render: (x) => healthTag(x.status) },
      { key: 'comment', title: 'Комментарий владельца', cls: 'text', render: (x) => esc(x.comment || '—') },
      { key: 'owner_username', title: 'Владелец', render: (x) => `<a href="#/admin/users/${x.owner_id}">${who({ username: x.owner_username, first_name: x.owner_name, id: x.owner_id })}</a>` },
      { key: 'created_at', title: 'Когда', num: true, render: (x) => dateTime(x.created_at) },
      { key: 'act', title: '', sortable: false, render: (x) => statusActions(x.service_id, x.status, false) }
    ]
  });
  if (d.anomalies.length) dataTable($('#tAnomalies', root), {
    rows: d.anomalies, empty: 'Аномалий нет', columns: [
      { key: 'name', title: 'Сервис', render: (x) => `<a href="#/admin/services/${x.service_id}">${esc(x.name)}</a>` },
      { key: 'kind', title: 'Что заметили', cls: 'text', render: (x) => (x.kind === 'spike'
        ? `Всплеск: ${x.details?.votes} голосов за ${x.details?.minutes} мин`
        : `${x.details?.low} из ${x.details?.down} сигналов о сбоях — от аккаунтов с низким доверием`) },
      { key: 'created_at', title: 'Когда', num: true, render: (x) => dateTime(x.created_at) },
      // On a failure status the usual actions apply; otherwise decide about the votes themselves.
      { key: 'act', title: '', sortable: false, render: (x) => {
        const st = d.incidents.find((i) => i.service_id === x.service_id)?.status;
        return st ? statusActions(x.service_id, st, false) : `<span class="row-flex" style="justify-content:flex-end;flex-wrap:nowrap;gap:6px">
          <button type="button" class="fill btn sm press" data-keep="${x.id}">Сигналы честные</button>
          <button type="button" class="lgb btn sm press" data-clear="${x.service_id}">Аннулировать голоса</button></span>`;
      } }
    ]
  });
  dataTable($('#tIncidents', root), {
    rows: d.incidents, empty: 'Все сервисы работают', columns: [
      { key: 'name', title: 'Сервис', render: (x) => `<a class="cell-main" href="#/admin/services/${x.service_id}" style="color:inherit">${logoHTML(x, 'sm')}<b>${esc(x.name)}</b></a>` },
      { key: 'status', title: 'Статус', render: (x) => `${healthTag(x.status)}${x.confirmed_at ? '<br><span class="small muted">подтверждён</span>' : ''}` },
      { key: 'since', title: 'С', num: true, render: (x) => dateTime(x.since) },
      { key: 'window', title: 'Голоса за окно', sortable: false, render: (x) => windowText(x.window) },
      { key: 'act', title: '', sortable: false, render: (x) => statusActions(x.service_id, x.status) }
    ]
  });
  if (d.changes.length) dataTable($('#tChanges', root), {
    rows: d.changes.slice(0, 15), empty: 'Изменений ещё не было', columns: [
      { key: 'changed_at', title: 'Когда', num: true, render: (x) => dateTime(x.changed_at) },
      { key: 'name', title: 'Сервис', render: (x) => `<a href="#/admin/services/${x.service_id}">${esc(x.name)}</a>` },
      { key: 'status', title: 'Стал', render: (x) => healthTag(x.status) },
      { key: 'reason', title: 'Почему', render: (x) => esc(CHANGE_REASON[x.reason] || x.reason) }
    ]
  });
  return bindStatusActions(root, refresh);
}

export async function statusSettings(root, { refresh }) {
  const { config } = await get('/api/admin/status/config');
  const groups = [...new Set(STATUS_CONFIG_FIELDS.map((f) => f[5]))];
  root.innerHTML = `
    <div class="crumbs"><a href="#/admin/status">Статусы</a> / настройки</div>
    ${head('Настройки статусов')}
    <p class="note" style="font-size:15px;padding:0">Вес голоса = базовый вес × доверие аккаунта.</p>
    <form id="cfgForm" class="grid-2">${groups.map((g) => `
      <section class="card panel stack-sm"><h3>${g}</h3>${STATUS_CONFIG_FIELDS.filter((f) => f[5] === g).map(([key, label, min, max, step]) => `
        <label class="field"><span>${label}</span><input class="input" type="number" name="${key}" min="${min}" max="${max}" step="${step}" value="${config[key]}" required></label>`).join('')}
      </section>`).join('')}</form>
    <div class="err" id="cfgErr" hidden></div>`;
  const save = async () => {
    const body = Object.fromEntries([...new FormData($('#cfgForm', root))].map(([k, v]) => [k, Number(v)]));
    mainProgress(true);
    try {
      await api('/api/admin/status/config', { method: 'PUT', body });
      haptic.notify('success');
      toast('Настройки статусов сохранены');
      refresh();
    } catch (e) {
      mainProgress(false);
      $('#cfgErr', root).textContent = e.message;
      $('#cfgErr', root).hidden = false;
    }
  };
  setMain({ text: 'Сохранить настройки', onClick: save });
}

// Service page section: current status, votes behind it, admin actions.
export async function serviceVotes(box, serviceId, onDone) {
  const d = await get(`/api/admin/services/${serviceId}/votes`);
  const st = d.status.status;
  box.innerHTML = `
    <div class="card panel stack-sm status-card">
      <div class="row-flex between" style="flex-wrap:wrap;gap:10px"><span style="display:flex;flex-direction:column;gap:4px">${healthTag(st, true)}
        <span class="small muted">${st !== 'operational' && d.status.since ? `с ${dateTime(d.status.since)} · ` : ''}${windowText(d.window)}</span></span>
        ${statusActions(serviceId, st)}</div>
      ${uptimeBarHTML(d.health.days, d.health.uptime30)}
    </div>
    ${d.items.length ? '<div id="tVotes" style="margin-top:12px"></div>' : ''}`;
  bindUptimeBar(box, d.health.days, d.health.uptime30);
  if (!d.items.length) return bindStatusActions(box, onDone);
  const EXCLUDED = { new_account: 'новый аккаунт', owner: 'владелец VPN' };
  dataTable($('#tVotes', box), {
    rows: d.items.slice(0, 20), columns: [
      { key: 'created_at', title: 'Когда', num: true, render: (v) => dateTime(v.created_at) },
      { key: 'user_id', title: 'Кто', render: (v) => `<a href="#/admin/users/${v.user_id}">${who({ username: v.username, first_name: v.first_name, id: v.user_id })}</a>` },
      { key: 'value', title: 'Голос', render: (v) => (v.value ? tag('работает', 'good') : tag('не работает', 'warn')) },
      { key: 'network', title: 'Сеть', render: (v) => esc(NETWORK[v.network]?.name || '—') },
      { key: 'trust_score', title: 'Доверие', num: true, render: (v) => `<span style="color:${v.trust_score < 0.5 ? 'var(--bad)' : 'inherit'}">${num(v.trust_score)}</span>` },
      // Weight = base × trust; the reason is shown only when a vote doesn't count or weighs less.
      { key: 'weight', title: 'Вес', num: true, value: (v) => (v.excluded ? -1 : v.weight), render: (v) => (v.excluded
        ? `<span class="muted">не учтён — ${EXCLUDED[v.excluded] || v.excluded}</span>`
        : `${num(v.weight)}${v.base_weight < 1 ? ' <span class="muted small">без перехода</span>' : ''}`) }
    ]
  });
  return bindStatusActions(box, onDone);
}
