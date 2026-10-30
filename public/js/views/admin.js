import { get, post, put } from '../api.js';
import { hasRole } from '../store.js';
import { haptic, setMain, mainProgress, openLink, confirmDialog } from '../tg.js';
import {
  $, $$, esc, rub, fmt, plural, icon, logoHTML, emptyHTML, dateShort, dateTime, stars, segHTML, bindSeg,
  reasonSheet, toast, toastError, openSheet, monthsWord
} from '../ui.js';
import { PROTOCOL, COUNTRY, PLATFORM, PAYMENT, TARIFF_MONTHS, monthLabel } from '../dict.js';

function guard(root) {
  if (hasRole('admin')) return true;
  root.innerHTML = emptyHTML('Раздел доступен только администраторам Линзы.');
  return false;
}
const page = (title, extra = '') => `<div class="topbar"><h1 class="title">${title}</h1>${extra}</div>`;
const who = (u) => (u.username ? `@${esc(u.username)}` : esc([u.first_name, u.last_name].filter(Boolean).join(' ') || `id ${u.user_id}`));
const userLink = (u) => (u.username ? `https://t.me/${u.username}` : null);

// Run a moderation action with feedback; resolves true on success.
async function act(fn, okText) {
  try { await fn(); haptic.notify('success'); toast(okText); return true; } catch (e) { toastError(e); return false; }
}

/* ---------------- Dashboard ---------------- */
export async function adminHome(root) {
  if (!guard(root)) return;
  const s = await get('/api/admin/summary');
  const queue = s.revisions + s.promos + s.reviews;
  const tile = (nav, title, n, hint, hot) => `
    <button type="button" class="card tile press" data-nav="${nav}">
      <span class="row-flex between"><span class="n">${n}</span>${hot ? '<span class="dot">!</span>' : ''}</span>
      <span><span class="t">${title}</span><br><span class="small muted">${hint}</span></span>
    </button>`;
  root.innerHTML = page('Админка') + `
    <div class="tiles">
      ${tile('/admin/applications', 'Заявки', s.applications, 'на подключение', s.applications > 0)}
      ${tile('/admin/moderation', 'Модерация', queue, `${s.revisions} карт. · ${s.promos} акц. · ${s.reviews} отз.`, queue > 0)}
      ${tile('/admin/checks', 'Проверки', s.unchecked, 'без проверки 14+ дней', s.unchecked > 0)}
      ${tile('/admin/top', 'Топ месяца', s.top_pending ? 'Ждёт' : 'OK', s.top_pending ? 'прошлый месяц не опубликован' : 'опубликован', s.top_pending)}
      ${tile('/admin/users', 'Пользователи', fmt(s.users), `${s.services} сервисов · ${s.hidden} скрыто`)}
      ${tile('/admin/log', 'Журнал', '≡', 'действия администраторов')}
    </div>
    ${s.outbox ? `<p class="note">В очереди бота ${s.outbox} ${plural(s.outbox, 'сообщение', 'сообщения', 'сообщений')}.</p>` : ''}`;
}

/* ---------------- Applications ---------------- */
export async function adminApplications(root) {
  if (!guard(root)) return;
  let status = 'pending';
  root.innerHTML = page('Заявки') + `<div id="st">${segHTML([{ id: 'pending', name: 'Новые' }, { id: 'approved', name: 'Одобрены' }, { id: 'rejected', name: 'Отклонены' }], status)}</div><div class="list" id="apps"></div>`;
  const draw = async () => {
    const { items } = await get(`/api/admin/applications?status=${status}`);
    const box = $('#apps', root);
    if (!items.length) { box.innerHTML = emptyHTML(status === 'pending' ? 'Новых заявок нет.' : 'Пусто.'); return; }
    box.innerHTML = items.map((a) => `
      <article class="card panel stack-sm" data-id="${a.id}">
        <div class="row-flex between"><h3>${esc(a.name)}</h3><span class="small muted">${dateTime(a.created_at)}</span></div>
        <div class="card group" style="box-shadow:none;background:var(--well)">
          <button type="button" class="row" data-link="${esc(a.link)}"><span>Бот / канал</span><span class="v" style="color:var(--accent-ink)">${esc(a.link.replace('https://', ''))}</span></button>
          <div class="row"><span>Контакт</span><span class="v">${esc(a.contact)}</span></div>
          ${userLink(a) ? `<button type="button" class="row" data-link="${esc(userLink(a))}"><span>Заявитель</span><span class="v" style="color:var(--accent-ink)">${who(a)} · ${a.user_id}</span></button>`
            : `<div class="row"><span>Заявитель</span><span class="v">${who(a)} · ${a.user_id}</span></div>`}
        </div>
        ${a.comment ? `<p class="small" style="margin:0;color:var(--text-2)">${esc(a.comment)}</p>` : ''}
        ${a.status === 'pending' ? `
          <p class="note">Проверьте владение: попросите заявителя временно изменить описание бота или написать с аккаунта-владельца.</p>
          <div class="grid2"><button type="button" class="fill btn press danger" data-reject="${a.id}">Отклонить</button><button type="button" class="solid btn press" data-approve="${a.id}">Одобрить</button></div>`
          : a.status === 'rejected' ? `<span class="small" style="color:var(--bad)">Причина: ${esc(a.reject_reason || '')}</span>` : `<span class="tag good" style="align-self:flex-start">Кабинет открыт</span>`}
      </article>`).join('');
    $$('[data-link]', box).forEach((b) => b.addEventListener('click', () => openLink(b.dataset.link)));
    $$('[data-approve]', box).forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmDialog('Подтвердить, что заявитель владеет сервисом, и открыть ему кабинет?'))) return;
      if (await act(() => post(`/api/admin/applications/${b.dataset.approve}/approve`), 'Заявка одобрена')) draw();
    }));
    $$('[data-reject]', box).forEach((b) => b.addEventListener('click', async () => {
      const reason = await reasonSheet('Отклонить заявку');
      if (reason && (await act(() => post(`/api/admin/applications/${b.dataset.reject}/reject`, { reason }), 'Заявка отклонена'))) draw();
    }));
  };
  bindSeg($('#st .seg', root), (v) => { status = v; draw(); });
  await draw();
}

/* ---------------- Moderation queue ---------------- */
const FIELD_LABELS = {
  name: 'Название', description: 'Описание', logo: 'Логотип', bot_url: 'Бот', channel_url: 'Канал', support_contact: 'Поддержка',
  tariffs: 'Тарифы', devices: 'Устройства', protocols: 'Протоколы', countries: 'Страны', platforms: 'Платформы', payments: 'Оплата',
  whitelist_bypass: 'Обход белых списков', whitelist_note: 'Белые списки — пояснение', trial: 'Пробный период', trial_days: 'Дней триала', trial_terms: 'Условия триала'
};
const DICT_FOR = { protocols: PROTOCOL, countries: COUNTRY, platforms: PLATFORM, payments: PAYMENT };

function fieldValue(k, v) {
  if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) return '<span class="muted">—</span>';
  if (k === 'logo') return `<img src="${esc(v)}" alt="" style="width:48px;height:48px;border-radius:14px;object-fit:cover">`;
  if (k === 'tariffs') return TARIFF_MONTHS.filter((m) => v[m]).map((m) => `${monthsWord(m)}: ${rub(v[m])}`).join('<br>') || '—';
  if (DICT_FOR[k]) return esc(v.map((x) => (k === 'countries' ? `${COUNTRY[x]?.flag || ''} ` : '') + (DICT_FOR[k][x]?.name || x)).join(', '));
  if (typeof v === 'boolean') return v ? 'Да' : 'Нет';
  return esc(v);
}

// Lists show only what was added or removed; everything else shows был/стал.
function changeHTML(k, before, after) {
  if (DICT_FOR[k]) {
    const added = (after || []).filter((x) => !(before || []).includes(x));
    const removed = (before || []).filter((x) => !(after || []).includes(x));
    return `${added.length ? `<span class="now">+ ${fieldValue(k, added)}</span>` : ''}${removed.length ? `<span class="was">− ${fieldValue(k, removed)}</span>` : ''}`;
  }
  if (k === 'tariffs') {
    return TARIFF_MONTHS.filter((m) => (before || {})[m] !== (after || {})[m]).map((m) =>
      `<span>${monthsWord(m)}: <span class="was">${before?.[m] ? rub(before[m]) : '—'}</span> → <span class="now">${after?.[m] ? rub(after[m]) : '—'}</span></span>`).join('');
  }
  return `<span class="was">${fieldValue(k, before)}</span><span class="now">${fieldValue(k, after)}</span>`;
}

function diffHTML(diff) {
  const keys = diff.is_new ? Object.keys(FIELD_LABELS) : diff.changed;
  if (!keys.length) return '<p class="note">Изменений нет — повторная отправка той же версии.</p>';
  return `<div class="card group" style="box-shadow:none;background:var(--well)">${keys.map((k) => `
    <div class="diff-row"><span class="k">${FIELD_LABELS[k] || k}</span>${diff.is_new ? `<span>${fieldValue(k, diff.after[k])}</span>` : changeHTML(k, diff.before?.[k], diff.after[k])}</div>`).join('')}</div>`;
}

export async function adminModeration(root, { query }) {
  if (!guard(root)) return;
  let kind = ['revisions', 'promos', 'reviews'].includes(query.kind) ? query.kind : 'revisions';
  const s = await get('/api/admin/summary');
  root.innerHTML = page('Модерация') + `<div id="kinds">${segHTML([
    { id: 'revisions', name: `Карточки${s.revisions ? ` · ${s.revisions}` : ''}` },
    { id: 'promos', name: `Акции${s.promos ? ` · ${s.promos}` : ''}` },
    { id: 'reviews', name: `Отзывы${s.reviews ? ` · ${s.reviews}` : ''}` }], kind)}</div><div class="list" id="queue"></div>`;

  const bindActions = (box, base, draw) => {
    $$('[data-approve]', box).forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      if (await act(() => post(`/api/admin/${base}/${b.dataset.approve}/approve`), 'Одобрено')) draw(); else b.disabled = false;
    }));
    $$('[data-reject]', box).forEach((b) => b.addEventListener('click', async () => {
      const reason = await reasonSheet('Отклонить');
      if (reason && (await act(() => post(`/api/admin/${base}/${b.dataset.reject}/reject`, { reason }), 'Отклонено'))) draw();
    }));
  };
  const buttons = (id) => `<div class="grid2"><button type="button" class="fill btn press danger" data-reject="${id}">Отклонить</button><button type="button" class="solid btn press" data-approve="${id}">Одобрить</button></div>`;

  const draw = async () => {
    const { items } = await get(`/api/admin/moderation?kind=${kind}`);
    history.replaceState(history.state, '', `#/admin/moderation?kind=${kind}`);
    const box = $('#queue', root);
    if (!items.length) { box.innerHTML = emptyHTML('Очередь пуста — всё проверено.', '', icon.shield); return; }
    if (kind === 'revisions') {
      box.innerHTML = items.map((r) => `
        <article class="card panel stack-sm">
          <div class="row-flex between"><h3>${esc(r.service_name)}</h3><span class="tag ${r.diff.is_new ? '' : 'neutral'}">${r.diff.is_new ? 'Новая карточка' : `Изменено полей: ${r.diff.changed.length}`}</span></div>
          <span class="small muted">${who(r)} · ${dateTime(r.created_at)}</span>
          ${diffHTML(r.diff)}
          ${buttons(r.id)}
        </article>`).join('');
      bindActions(box, 'revisions', draw);
    } else if (kind === 'promos') {
      box.innerHTML = items.map((p) => `
        <article class="card panel stack-sm">
          <div class="row-flex between"><h3>${esc(p.service_name)}</h3>${p.discount_percent ? `<span class="tag">−${p.discount_percent}%</span>` : ''}</div>
          <b>${esc(p.title)}</b>
          ${p.description ? `<p class="small" style="margin:0;color:var(--text-2)">${esc(p.description)}</p>` : ''}
          <span class="small muted">${dateShort(p.starts_at)} – ${dateShort(p.ends_at)}${p.promo_code ? ` · промокод <span class="code">${esc(p.promo_code)}</span>` : ''}</span>
          ${buttons(p.id)}
        </article>`).join('');
      bindActions(box, 'promos', draw);
    } else {
      box.innerHTML = items.map((r) => `
        <article class="card panel stack-sm">
          <div class="row-flex between"><h3>${esc(r.service_name)}</h3>${stars(r.rating)}</div>
          <p style="margin:0;font-size:15px;line-height:1.45;white-space:pre-line">${esc(r.text)}</p>
          <span class="small muted">${who(r)} · ${dateTime(r.updated_at)} · переходов в бот: ${r.clicks}</span>
          ${buttons(r.id)}
        </article>`).join('');
      bindActions(box, 'reviews', draw);
    }
  };
  bindSeg($('#kinds .seg', root), (v) => { kind = v; draw(); });
  await draw();
}

/* ---------------- Manual checks ---------------- */
export async function adminChecks(root) {
  if (!guard(root)) return;
  root.innerHTML = page('Проверки') + `<p class="note" style="font-size:15px">Подключитесь к сервису и отметьте результат. Доля пройденных проверок за месяц — это «стабильность» в топе.</p><div class="list" id="checks"></div>`;
  const draw = async () => {
    const { items } = await get('/api/admin/checks');
    const box = $('#checks', root);
    box.innerHTML = items.map((s) => {
      const stale = !s.last_at || Date.now() - s.last_at > 14 * 86_400_000;
      return `
      <article class="card panel stack-sm">
        <div class="row-flex">${logoHTML(s, 'sm')}<span class="grow" style="display:flex;flex-direction:column"><b>${esc(s.name)}</b>
          <span class="small ${stale ? '' : 'muted'}" style="${stale ? 'color:var(--warn)' : ''}">${s.last_at ? `${s.last_passed ? '✓' : '✕'} ${dateShort(s.last_at)}` : 'Не проверялся'} · за 30 дней ${s.passed30}/${s.n30}</span></span>
          <button type="button" class="link-btn" data-hist="${s.id}" data-name="${esc(s.name)}">История</button></div>
        <div class="row-flex">
          <button type="button" class="fill btn sm press" data-link="${esc(s.bot_url)}">${icon.bot} Бот</button>
          <span class="grow"></span>
          <button type="button" class="fill btn sm press danger" data-fail="${s.id}">✕ Не работает</button>
          <button type="button" class="lgb btn sm press" data-pass="${s.id}">✓ Работает</button>
        </div>
      </article>`;
    }).join('') || emptyHTML('Опубликованных сервисов пока нет.');
    $$('[data-link]', box).forEach((b) => b.addEventListener('click', () => openLink(b.dataset.link)));
    $$('[data-pass]', box).forEach((b) => b.addEventListener('click', async () => {
      if (await act(() => post(`/api/admin/services/${b.dataset.pass}/checks`, { passed: true }), 'Проверка записана')) draw();
    }));
    $$('[data-fail]', box).forEach((b) => b.addEventListener('click', async () => {
      const note = await reasonSheet('Что не работает', 'Например: не подключается на МТС');
      if (note && (await act(() => post(`/api/admin/services/${b.dataset.fail}/checks`, { passed: false, note }), 'Проверка записана'))) draw();
    }));
    $$('[data-hist]', box).forEach((b) => b.addEventListener('click', async () => {
      const { items: hist } = await get(`/api/admin/services/${b.dataset.hist}/checks`);
      openSheet(b.dataset.name, hist.length ? `<div class="card group">${hist.map((c) => `
        <div class="row"><span style="display:flex;flex-direction:column"><span class="${c.passed ? 'ok' : ''}" style="${c.passed ? '' : 'color:var(--bad);font-weight:600'}">${c.passed ? '✓ Работает' : '✕ Не работает'}</span>
          ${c.note ? `<span class="small muted">${esc(c.note)}</span>` : ''}</span><span class="v small">${dateTime(c.checked_at)}<br>${c.username ? '@' + esc(c.username) : esc(c.first_name || '')}</span></div>`).join('')}</div>` : '<p class="note">Проверок ещё не было.</p>');
    }));
  };
  await draw();
}

/* ---------------- Monthly top ---------------- */
export async function adminTop(root, { query }) {
  if (!guard(root)) return;
  let period = query.period || null;
  root.innerHTML = page('Топ месяца') + '<div id="topBody" class="stack" style="gap:22px"></div>';
  const draw = async () => {
    const data = await get(`/api/admin/top${period ? `?period=${period}` : ''}`);
    period = data.period;
    const w = { ...data.weights };
    const months = [];
    for (let i = 0; i < 6; i++) {
      const [y, m] = data.current_period.split('-').map(Number);
      const d = new Date(Date.UTC(y, m - 1 - i, 1));
      months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
    }
    const isCurrent = period === data.current_period;
    const body = $('#topBody', root);
    body.innerHTML = `
      <div class="chips scroll">${months.map((p) => `<button type="button" class="${p === period ? 'sel' : 'fill'} chip press" data-period="${p}">${esc(monthLabel(p))}${p === data.current_period ? ' · идёт' : ''}</button>`).join('')}</div>
      <div class="callout">${isCurrent ? '<b>Месяц ещё идёт</b> — это промежуточный расчёт, публиковать можно после его окончания.'
        : data.published ? `<b>Опубликован</b> ${dateTime(data.published.published_at)}${data.published.published_by ? '' : ' автоматически'}. Можно переопубликовать с новыми весами — подписчики второй раз уведомление не получат.`
        : '<b>Не опубликован.</b> Проверьте расчёт и опубликуйте — клиенты получат уведомление в боте. Если не опубликовать, 1-го числа в 12:00 МСК это произойдёт автоматически.'}</div>
      <section>
        <p class="label">Веса сводного балла</p>
        <div class="card panel stack-sm" id="weights">
          ${[['rating', 'Оценки отзывов'], ['clients', 'Уникальные клиенты'], ['stability', 'Стабильность проверок']].map(([k, l]) => `
            <div><div class="row-flex between"><span>${l}</span><b data-wv="${k}">${Math.round(w[k] * 100)}%</b></div>
            <input class="range" type="range" min="0" max="100" step="5" value="${Math.round(w[k] * 100)}" data-w="${k}" style="--p:${Math.round(w[k] * 100)}%" aria-label="${l}"></div>`).join('')}
          <span class="small muted" id="wSum"></span>
          <button type="button" class="lgb btn press" id="saveW" style="align-self:flex-start">Сохранить и пересчитать</button>
        </div>
      </section>
      <section>
        <p class="label">Расчёт · ${esc(monthLabel(period))}</p>
        <div class="card cmp-wrap"><table class="cmp">
          <thead><tr><th>#</th><th>Сервис</th><th>Балл</th><th>Оценки</th><th>Клиенты</th><th>Стабильн.</th></tr></thead>
          <tbody>${data.rows.slice(0, 25).map((r) => `<tr class="${r.rank <= 10 && r.score > 0 ? 'diff' : ''}">
            <th>${r.rank}</th><td><b>${esc(r.name)}</b></td><td><b>${String(r.score).replace('.', ',')}</b></td>
            <td>${r.components.rating_n ? `${String(r.components.rating_avg).replace('.', ',')}★ · ${r.components.rating_n}` : '—'}</td>
            <td>${fmt(r.components.clients_n)}</td>
            <td>${r.components.checks_n ? `${r.components.checks_passed}/${r.components.checks_n}` : '—'}</td></tr>`).join('')}</tbody></table></div>
        <p class="note" style="margin-top:8px">Подсвечена десятка, которая попадёт в топ.</p>
      </section>
      ${data.archive.length ? `<section><p class="label">Архив</p><div class="card group">${data.archive.map((a) => `
        <button type="button" class="row press" data-period="${a.period}"><span><b>${esc(monthLabel(a.period))}</b><br><span class="small muted">${esc(a.leaders.join(', '))}</span></span>${icon.chev}</button>`).join('')}</div></section>` : ''}`;

    const sum = () => w.rating + w.clients + w.stability;
    const showSum = () => { $('#wSum', body).textContent = sum() ? `Веса нормализуются к 100% (сейчас ${Math.round(sum() * 100)}%)` : 'Хотя бы один вес должен быть больше нуля'; };
    showSum();
    $$('[data-w]', body).forEach((r) => r.addEventListener('input', () => {
      w[r.dataset.w] = Number(r.value) / 100;
      r.style.setProperty('--p', r.value + '%');
      $(`[data-wv="${r.dataset.w}"]`, body).textContent = r.value + '%';
      showSum();
    }));
    $('#saveW', body).addEventListener('click', async () => {
      if (await act(() => put('/api/admin/settings/top-weights', w), 'Веса сохранены')) draw();
    });
    $$('[data-period]', body).forEach((b) => b.addEventListener('click', () => { haptic.select(); period = b.dataset.period; history.replaceState(history.state, '', `#/admin/top?period=${period}`); draw(); }));

    if (isCurrent) setMain(null);
    else {
      setMain({
        text: data.published ? `Переопубликовать топ за ${monthLabel(period).split(' ')[0]}` : `Опубликовать топ за ${monthLabel(period).split(' ')[0]}`,
        onClick: async () => {
          if (!(await confirmDialog(`Опубликовать топ-10 за ${monthLabel(period)}?`))) return;
          mainProgress(true);
          const ok = await act(() => post(`/api/admin/top/${period}/publish`), 'Топ опубликован');
          mainProgress(false);
          if (ok) draw();
        }
      });
    }
  };
  await draw();
}

/* ---------------- Users & services ---------------- */
export async function adminUsers(root) {
  if (!guard(root)) return;
  root.innerHTML = page('Пользователи и сервисы') + `
    <form class="lg search" id="uSearch" role="search">${icon.search}<input type="search" name="q" placeholder="ID, @username, имя или название VPN" autocomplete="off" aria-label="Поиск"></form>
    <div id="uRes" class="stack" style="gap:22px"></div>`;
  let q = '';
  const draw = async () => {
    const { users, services } = await get(`/api/admin/search?q=${encodeURIComponent(q)}`);
    const box = $('#uRes', root);
    box.innerHTML = `
      <section><p class="label">Сервисы</p>${services.length ? `<div class="card group">${services.map((s) => `
        <div class="row"><span style="display:flex;flex-direction:column;min-width:0"><b>${esc(s.name)}</b>
          <span class="small muted">${s.status === 'published' ? 'опубликован' : 'черновик'}${s.owner_username ? ` · @${esc(s.owner_username)}` : ''}${s.hidden ? ` · <span style="color:var(--bad)">скрыт: ${esc(s.hidden_reason || '')}</span>` : ''}</span></span>
          ${s.hidden ? `<button type="button" class="fill btn sm press" data-unhide="${s.id}">Показать</button>` : `<button type="button" class="fill btn sm press danger" data-hide="${s.id}">Скрыть</button>`}
        </div>`).join('')}</div>` : '<p class="note">Не найдено.</p>'}</section>
      <section><p class="label">Пользователи</p>${users.length ? `<div class="card group">${users.map((u) => `
        <div class="row"><span style="display:flex;flex-direction:column;min-width:0"><b>${esc([u.first_name, u.last_name].filter(Boolean).join(' ') || '—')}</b>
          <span class="small muted">${u.username ? '@' + esc(u.username) + ' · ' : ''}${u.id}${u.roles ? ` · ${esc(u.roles.replace('vpn_owner', 'VPN').replace('admin', 'админ'))}` : ''}${u.is_blocked ? ` · <span style="color:var(--bad)">заблокирован</span>` : ''}</span></span>
          ${u.is_blocked ? `<button type="button" class="fill btn sm press" data-unblock="${u.id}">Разблок.</button>` : `<button type="button" class="fill btn sm press danger" data-block="${u.id}">Блок</button>`}
        </div>`).join('')}</div>` : '<p class="note">Не найдено.</p>'}</section>`;
    const bindReason = (attr, path, title, okText) => $$(`[${attr}]`, box).forEach((b) => b.addEventListener('click', async () => {
      const reason = await reasonSheet(title);
      if (reason && (await act(() => post(path(b.getAttribute(attr)), { reason }), okText))) draw();
    }));
    const bindPlain = (attr, path, okText) => $$(`[${attr}]`, box).forEach((b) => b.addEventListener('click', async () => {
      if (await act(() => post(path(b.getAttribute(attr))), okText)) draw();
    }));
    bindReason('data-hide', (id) => `/api/admin/services/${id}/hide`, 'Скрыть карточку из каталога', 'Карточка скрыта');
    bindPlain('data-unhide', (id) => `/api/admin/services/${id}/unhide`, 'Карточка снова в каталоге');
    bindReason('data-block', (id) => `/api/admin/users/${id}/block`, 'Заблокировать пользователя', 'Пользователь заблокирован');
    bindPlain('data-unblock', (id) => `/api/admin/users/${id}/unblock`, 'Пользователь разблокирован');
  };
  let t;
  $('#uSearch input', root).addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { q = e.target.value.trim(); draw().catch(toastError); }, 300); });
  $('#uSearch', root).addEventListener('submit', (e) => e.preventDefault());
  await draw();
  return () => clearTimeout(t);
}

/* ---------------- Audit log ---------------- */
const ACTIONS = {
  'application.approve': 'одобрил заявку', 'application.reject': 'отклонил заявку',
  'revision.approve': 'опубликовал изменения карточки', 'revision.reject': 'отклонил изменения карточки',
  'promo.approve': 'одобрил акцию', 'promo.reject': 'отклонил акцию',
  'review.approve': 'одобрил отзыв', 'review.reject': 'отклонил отзыв',
  'check.pass': 'отметил проверку: работает', 'check.fail': 'отметил проверку: не работает',
  'top.publish': 'опубликовал топ', 'top.republish': 'переопубликовал топ', 'settings.top_weights': 'изменил веса топа',
  'user.block': 'заблокировал пользователя', 'user.unblock': 'разблокировал пользователя',
  'service.hide': 'скрыл карточку', 'service.unhide': 'вернул карточку в каталог'
};

function detailText(l) {
  const d = l.details || {};
  const parts = [];
  if (d.name) parts.push(`«${d.name}»`);
  if (d.title) parts.push(`«${d.title}»`);
  if (d.period) parts.push(monthLabel(d.period));
  if (l.entity_type === 'service' && l.entity_id) parts.push(`сервис #${l.entity_id}`);
  if (l.entity_type === 'user' && l.entity_id) parts.push(`id ${l.entity_id}`);
  if (d.after) parts.push(`веса ${Math.round(d.after.rating * 100)}/${Math.round(d.after.clients * 100)}/${Math.round(d.after.stability * 100)}`);
  if (d.reason) parts.push(`причина: ${d.reason}`);
  if (d.note) parts.push(d.note);
  return parts.join(' · ');
}

export async function adminLog(root) {
  if (!guard(root)) return;
  root.innerHTML = page('Журнал') + '<div class="card group" id="log"></div><button type="button" class="fill btn block press" id="more" hidden>Показать ещё</button>';
  let offset = 0;
  const load = async () => {
    const { items } = await get(`/api/admin/log?offset=${offset}`);
    offset += items.length;
    $('#log', root).insertAdjacentHTML('beforeend', items.map((l) => `
      <div class="row" style="align-items:flex-start"><span style="display:flex;flex-direction:column;min-width:0">
        <span><b>${l.admin_id ? (l.username ? '@' + esc(l.username) : esc(l.first_name || l.admin_id)) : 'Система'}</b> ${ACTIONS[l.action] || esc(l.action)}</span>
        <span class="small muted">${esc(detailText(l))}</span></span><span class="v small" style="white-space:nowrap">${dateTime(l.created_at)}</span></div>`).join(''));
    if (!offset) $('#log', root).outerHTML = emptyHTML('Действий пока не было.');
    $('#more', root).hidden = items.length < 50;
  };
  $('#more', root).addEventListener('click', () => load().catch(toastError));
  await load();
}
