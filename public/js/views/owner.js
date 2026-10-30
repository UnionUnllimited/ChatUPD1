import { get, post, del } from '../api.js';
import { store, loadMe, ensureBotChat } from '../store.js';
import { haptic, setMain, mainProgress, confirmDialog } from '../tg.js';
import {
  $, $$, esc, rub, fmt, plural, icon, logoHTML, emptyHTML, dateShort, dateLong, segHTML, bindSeg,
  openSheet, closeSheet, setSheetMain, toast, toastError, monthsWord, replay,
  ago, duration, healthTag, uptimeBarHTML, bindUptimeBar
} from '../ui.js';
import { PROTOCOLS, COUNTRIES, PLATFORMS, PAYMENTS, TARIFF_MONTHS, MODERATION_STATUS, HEALTH, NETWORK, monthLabel } from '../dict.js';

/* ---------------- Health from client signals ---------------- */
async function drawHealth(box, serviceId) {
  const { health: h, window: w, window_min: wm, dispute } = await get(`/api/owner/services/${serviceId}/health`);
  const failing = h.status !== 'operational';
  const nets = Object.entries(w.down_networks || {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, c]) => `${NETWORK[n]?.name || n} — ${c}`).join(', ');
  const openDispute = dispute?.state === 'open';
  // Calm when all is well; details and the dispute button only during a failure.
  box.innerHTML = `
    ${healthTag(h.status, true)}
    <span class="small muted">${h.last_signal_at ? `Последний сигнал клиента ${ago(h.last_signal_at)}` : 'Клиенты ещё не отмечали статус'}</span>
    ${uptimeBarHTML(h.days, h.uptime30)}
    ${failing ? `<span class="small">${w.down_n} ${plural(w.down_n, 'сигнал', 'сигнала', 'сигналов')} о сбоях за ${duration(wm)}${nets ? `: ${esc(nets)}` : ''}</span>` : ''}
    ${openDispute ? '<span class="tag warn" style="align-self:flex-start">Спор у администратора</span>'
      : failing ? '<button type="button" class="fill btn press" id="dispute" style="align-self:flex-start">Оспорить</button>' : ''}`;
  bindUptimeBar(box, h.days, h.uptime30);
  $('#dispute', box)?.addEventListener('click', () => openSheet('Оспорить статус', `
      <p class="note" style="font-size:15px">Администратор получит уведомление, проверит сервис и снимет статус «${HEALTH[h.status].name}», если он ошибочный.</p>
      <label class="field"><span>Комментарий — необязательно</span><textarea class="input" id="dispText" maxlength="500" placeholder="Например: серверы работают, проблема у одного провайдера"></textarea></label>
      <div class="err" id="dispErr" hidden></div>`, (sheet) => {
    setSheetMain({
      text: 'Отправить администратору',
      onClick: async () => {
        try {
          await post(`/api/owner/services/${serviceId}/dispute`, { comment: $('#dispText', sheet).value });
          haptic.notify('success');
          closeSheet(true);
          toast('Спор отправлен администратору');
          drawHealth(box, serviceId);
        } catch (e) { $('#dispErr', sheet).textContent = e.message; $('#dispErr', sheet).hidden = false; }
      }
    });
  }));
}

const statusTag = (st) => `<span class="tag ${st === 'approved' ? 'good' : st === 'rejected' ? 'bad' : st === 'pending' ? 'warn' : 'neutral'}">${MODERATION_STATUS[st] || st}</span>`;

function serviceStatus(s) {
  if (s.hidden) return '<span class="tag bad">Скрыт</span>';
  if (s.revision?.status === 'pending') return statusTag('pending');
  if (s.revision?.status === 'rejected') return statusTag('rejected');
  return s.status === 'published' ? statusTag('approved') : '<span class="tag neutral">Черновик</span>';
}

/* ---------------- Workspace (profile → «VPN-сервис») ---------------- */
export async function renderOwnerWorkspace(box) {
  const { applications, services } = await get('/api/owner');
  const pendingApps = applications.filter((a) => a.status !== 'approved');
  box.innerHTML = `
    ${services.length ? `<section><p class="label">Мои сервисы</p><div class="card group">${services.map((s) => `
      <button type="button" class="row press" data-nav="/owner/${s.id}">
        <span class="row-flex grow">${logoHTML(s, 'sm')}<span class="grow" style="display:flex;flex-direction:column"><b>${esc(s.name)}</b>
          <span class="small muted">${s.min_monthly ? `от ${rub(s.min_monthly)}/мес` : 'Карточка не заполнена'}</span></span></span>
        ${serviceStatus(s)}${icon.chev}
      </button>`).join('')}</div></section>
    <section><p class="label">Реклама в Telegram-каналах</p><div class="card group">
      <button type="button" class="row press" data-nav="/ads"><span>Биржа рекламы</span><span class="row-flex"><span class="v small">каналы, охват, CPM</span>${icon.chev}</span></button>
      <button type="button" class="row press" data-nav="/ads/deals?as=buyer"><span>Мои сделки</span><span class="row-flex">${store.me?.counts?.ad_deals ? `<span class="tag">${store.me.counts.ad_deals}</span>` : ''}${icon.chev}</span></button>
    </div></section>` : ''}
    ${pendingApps.length ? `<section><p class="label">Заявки на подключение</p><div class="stack-sm">${pendingApps.map((a) => `
      <div class="card panel stack-sm">
        <div class="row-flex between"><b>${esc(a.name)}</b>${statusTag(a.status)}</div>
        <span class="small muted">${esc(a.link.replace('https://', ''))} · ${dateShort(a.created_at)}</span>
        ${a.status === 'pending' ? '<span class="small">Администратор проверит, что сервис принадлежит вам, и откроет кабинет. Обычно это занимает до суток.</span>' : ''}
        ${a.status === 'rejected' && a.reject_reason ? `<span class="small" style="color:var(--bad)">Причина: ${esc(a.reject_reason)}</span>` : ''}
      </div>`).join('')}</div></section>` : ''}
    ${!services.length && !pendingApps.length ? `
      <div class="card empty"><span class="lgs ico">${icon.plus}</span>
        <p><b>Разместите свой VPN в Линзе</b><br>Бесплатно. Клиенты находят сервисы по цене и параметрам и переходят прямо в ваш бот.</p></div>
      <div class="card group">
        <div class="row"><span>1. Заявка: название, бот и контакт</span></div>
        <div class="row"><span>2. Администратор подтверждает, что сервис ваш</span></div>
        <div class="row"><span>3. Заполняете карточку и тарифы — после модерации они в каталоге</span></div>
      </div>` : ''}
    <button type="button" class="lgb cta press" data-nav="/owner/apply">${icon.plus} Добавить VPN</button>
    <p class="note">Любое изменение карточки публикуется только после модерации. Рейтинг нельзя купить: он строится по отзывам, переходам и стабильности по сигналам клиентов.</p>`;
}

export async function ownerHome(root) {
  root.innerHTML = '<div class="topbar"><h1 class="title">Кабинет VPN</h1></div><div id="ws" class="stack" style="gap:22px"></div>';
  if (!store.me) { $('#ws', root).innerHTML = emptyHTML('Откройте Линзу в Telegram, чтобы управлять своим VPN.'); return; }
  await renderOwnerWorkspace($('#ws', root));
}

/* ---------------- «Добавить VPN» ---------------- */
export async function ownerApply(root, { navigate }) {
  root.innerHTML = `
    <div class="topbar"><h1 class="title">Добавить VPN</h1></div>
    <p class="note" style="font-size:15px">Заполните заявку. Администратор свяжется с вами и проверит, что вы владеете сервисом — например, попросит поменять описание бота. После подтверждения откроется кабинет.</p>
    <form class="stack" id="appForm" novalidate>
      <label class="field"><span>Название сервиса</span><input class="input" name="name" maxlength="60" required placeholder="Например, Аврора VPN"></label>
      <label class="field"><span>Бот или канал сервиса</span><input class="input" name="link" required placeholder="@my_vpn_bot или t.me/my_vpn_bot" autocapitalize="off" autocorrect="off"></label>
      <label class="field"><span>Контакт для связи</span><input class="input" name="contact" maxlength="120" required placeholder="@username, телефон или почта" value="${store.me?.username ? '@' + esc(store.me.username) : ''}"></label>
      <label class="field"><span>Комментарий — необязательно</span><textarea class="input" name="comment" maxlength="500" placeholder="Сколько работаете, сколько клиентов, что важно знать"></textarea></label>
      <div class="err" id="appErr" hidden></div>
    </form>`;
  const form = $('#appForm', root);
  const submit = async () => {
    const data = Object.fromEntries(new FormData(form));
    mainProgress(true);
    try {
      await post('/api/owner/applications', data);
      haptic.notify('success');
      toast('Заявка отправлена — пришлём ответ в бот');
      await ensureBotChat();
      await loadMe();
      navigate('/profile', { replace: true });
    } catch (e) {
      mainProgress(false);
      $('#appErr', root).textContent = e.message;
      $('#appErr', root).hidden = false;
      haptic.notify('error');
    }
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  setMain({ text: 'Отправить заявку', onClick: submit });
}

/* ---------------- Card editor ---------------- */
function chipsField(name, list, selected, withFlag) {
  return `<div class="chips" data-chips="${name}">${list.map((it) => {
    const on = selected.includes(it.id);
    return `<button type="button" class="${on ? 'sel' : 'fill'} chip press" aria-pressed="${on}" data-v="${it.id}">${withFlag ? it.flag + ' ' : ''}${esc(it.name)}</button>`;
  }).join('')}</div>`;
}

// Square-crop and downscale in the browser so uploads stay small.
function readLogo(file) {
  return new Promise((resolve, reject) => {
    if (!/^image\//.test(file.type)) { reject(new Error('Выберите изображение')); return; }
    const img = new Image();
    img.onload = () => {
      const size = 256;
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const ctx = c.getContext('2d');
      const side = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
      let url = c.toDataURL('image/webp', 0.86);
      if (!url.startsWith('data:image/webp')) url = c.toDataURL('image/png');
      URL.revokeObjectURL(img.src);
      resolve(url);
    };
    img.onerror = () => reject(new Error('Не удалось прочитать изображение'));
    img.src = URL.createObjectURL(file);
  });
}

export function editorHTML(d) {
  return `
    <form class="stack" id="cardForm" novalidate style="gap:20px">
      <div class="card panel logo-pick">
        <span id="logoPreview">${logoHTML({ name: d.name || '?', logo_url: d.logo }, 'xl')}</span>
        <div class="stack-sm grow">
          <b>Логотип</b><span class="small muted">Квадрат, PNG/JPEG, мы уменьшим до 256 px</span>
          <label class="fill btn sm press" style="align-self:flex-start">Выбрать файл<input type="file" accept="image/png,image/jpeg,image/webp" id="logoFile" hidden></label>
        </div>
      </div>
      <label class="field"><span>Название</span><input class="input" name="name" maxlength="60" value="${esc(d.name || '')}"></label>
      <label class="field"><span>Описание — что отличает ваш сервис</span><textarea class="input" name="description" maxlength="600">${esc(d.description || '')}</textarea></label>
      <div class="grid2">
        <label class="field"><span>Бот</span><input class="input" name="bot_url" value="${esc(d.bot_url || '')}" placeholder="@my_vpn_bot" autocapitalize="off"></label>
        <label class="field"><span>Канал</span><input class="input" name="channel_url" value="${esc(d.channel_url || '')}" placeholder="@my_vpn" autocapitalize="off"></label>
      </div>
      <label class="field"><span>Поддержка</span><input class="input" name="support_contact" maxlength="120" value="${esc(d.support_contact || '')}" placeholder="@support"></label>

      <section><p class="label">Тарифы — полная цена за период, ₽</p>
        <div class="grid4">${TARIFF_MONTHS.map((m) => `
          <label class="field"><span>${monthsWord(m)}</span><input class="input" type="number" inputmode="numeric" min="1" data-tariff="${m}" value="${d.tariffs?.[m] ?? ''}" placeholder="—">
          <span class="small muted" data-per="${m}" style="padding:0 6px"></span></label>`).join('')}</div>
        <p class="note" style="margin-top:8px">Пустое поле — тарифа нет. Цена «от … ₽/мес» и метка относительно рынка считаются автоматически.</p>
      </section>

      <label class="field"><span>Устройств на одну подписку</span><input class="input" type="number" inputmode="numeric" min="1" max="100" name="devices" value="${d.devices || 1}"></label>
      <section><p class="label">Протоколы</p>${chipsField('protocols', PROTOCOLS, d.protocols || [])}</section>
      <section><p class="label">Страны серверов</p>${chipsField('countries', COUNTRIES, d.countries || [], true)}</section>
      <section><p class="label">Платформы</p>${chipsField('platforms', PLATFORMS, d.platforms || [])}</section>
      <section><p class="label">Способы оплаты</p>${chipsField('payments', PAYMENTS, d.payments || [])}</section>

      <div class="card group">
        <label class="row"><span>Обход белых списков</span><input class="sw" type="checkbox" name="whitelist_bypass" ${d.whitelist_bypass ? 'checked' : ''}></label>
        <div class="row" data-when="whitelist_bypass" style="display:block"><input class="input" name="whitelist_note" maxlength="200" value="${esc(d.whitelist_note || '')}" placeholder="Как работает: отдельные серверы, операторы…"></div>
        <label class="row"><span>Пробный период</span><input class="sw" type="checkbox" name="trial" ${d.trial ? 'checked' : ''}></label>
        <div class="row" data-when="trial" style="display:block">
          <div class="stack-sm">
            <input class="input" type="number" inputmode="numeric" min="1" max="90" name="trial_days" value="${d.trial_days ?? ''}" placeholder="Сколько дней">
            <input class="input" name="trial_terms" maxlength="300" value="${esc(d.trial_terms || '')}" placeholder="Условия: без карты, одно устройство…">
          </div>
        </div>
      </div>
      <div class="err" id="cardErr" hidden></div>
    </form>`;
}

export function bindEditor(root, draft, onSubmit) {
  const form = $('#cardForm', root);
  const lists = { protocols: [...(draft.protocols || [])], countries: [...(draft.countries || [])], platforms: [...(draft.platforms || [])], payments: [...(draft.payments || [])] };
  let logo = draft.logo || null;

  $$('[data-chips]', form).forEach((group) => group.addEventListener('click', (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    haptic.select();
    const k = group.dataset.chips, v = b.dataset.v;
    lists[k] = lists[k].includes(v) ? lists[k].filter((x) => x !== v) : [...lists[k], v];
    const on = lists[k].includes(v);
    b.className = `${on ? 'sel' : 'fill'} chip press`;
    b.setAttribute('aria-pressed', on);
    replay(b, 'bump');
  }));

  const perMonth = () => TARIFF_MONTHS.forEach((m) => {
    const v = Number($(`[data-tariff="${m}"]`, form).value);
    $(`[data-per="${m}"]`, form).textContent = v > 0 && m > 1 ? `${rub(Math.round(v / m))}/мес` : '';
  });
  $$('[data-tariff]', form).forEach((i) => i.addEventListener('input', perMonth));
  perMonth();

  const toggles = () => $$('[data-when]', form).forEach((el) => { el.hidden = !form.elements[el.dataset.when].checked; });
  $$('.sw', form).forEach((c) => c.addEventListener('change', () => { haptic.select(); toggles(); }));
  toggles();

  $('#logoFile', form).addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      logo = await readLogo(file);
      $('#logoPreview', form).innerHTML = logoHTML({ name: form.elements.name.value, logo_url: logo }, 'xl');
    } catch (err) { toastError(err); }
  });

  const collect = () => {
    const el = form.elements;
    return {
      name: el.name.value, description: el.description.value, logo,
      bot_url: el.bot_url.value, channel_url: el.channel_url.value, support_contact: el.support_contact.value,
      tariffs: Object.fromEntries(TARIFF_MONTHS.map((m) => [m, $(`[data-tariff="${m}"]`, form).value ? Number($(`[data-tariff="${m}"]`, form).value) : null])),
      devices: Number(el.devices.value),
      ...lists,
      whitelist_bypass: el.whitelist_bypass.checked, whitelist_note: el.whitelist_note.value,
      trial: el.trial.checked, trial_days: el.trial_days.value ? Number(el.trial_days.value) : null, trial_terms: el.trial_terms.value
    };
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); onSubmit(collect()); });
  return collect;
}

/* ---------------- Promotions ---------------- */
// <input type="date"> value -> start or end of that day in Moscow time.
const mskDayTs = (value, endOfDay) => {
  const [y, m, d] = value.split('-').map(Number);
  return Date.UTC(y, m - 1, d) - 3 * 3600_000 + (endOfDay ? 86_400_000 - 1 : 0);
};
const todayInput = (offsetDays = 0) => new Date(Date.now() + 3 * 3600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);

function promoSheet(serviceId, onSaved) {
  openSheet('Новая акция', `
    <label class="field"><span>Заголовок</span><input class="input" id="pTitle" maxlength="80" placeholder="Например, −30% на годовой тариф"></label>
    <label class="field"><span>Описание — необязательно</span><textarea class="input" id="pDesc" maxlength="400" placeholder="Условия акции"></textarea></label>
    <div class="grid2">
      <label class="field"><span>Скидка, %</span><input class="input" id="pPct" type="number" inputmode="numeric" min="1" max="99" placeholder="—"></label>
      <label class="field"><span>Промокод</span><input class="input" id="pCode" maxlength="32" placeholder="—" autocapitalize="characters"></label>
    </div>
    <div class="grid2">
      <label class="field"><span>Начало</span><input class="input" id="pStart" type="date" value="${todayInput()}"></label>
      <label class="field"><span>Окончание</span><input class="input" id="pEnd" type="date" value="${todayInput(14)}"></label>
    </div>
    <div class="err" id="pErr" hidden></div>
    <p class="note">Акция появится в блоке «Скидки и акции» после модерации и снимется автоматически после даты окончания. Клиенты, добавившие вас в избранное, получат уведомление.</p>`,
  (root) => {
    const submit = async () => {
      const v = (id) => $(id, root).value.trim();
      if (!v('#pStart') || !v('#pEnd')) { $('#pErr', root).textContent = 'Укажите даты'; $('#pErr', root).hidden = false; return; }
      setSheetMain({ text: 'Отправляем…', progress: true, onClick: () => {} });
      try {
        await post(`/api/owner/services/${serviceId}/promos`, {
          title: v('#pTitle'), description: v('#pDesc'), discount_percent: v('#pPct') ? Number(v('#pPct')) : null, promo_code: v('#pCode'),
          starts_at: mskDayTs(v('#pStart'), false), ends_at: mskDayTs(v('#pEnd'), true)
        });
        haptic.notify('success');
        closeSheet(true);
        toast('Акция отправлена на модерацию');
        onSaved();
      } catch (e) {
        setSheetMain({ text: 'Отправить на модерацию', onClick: submit });
        $('#pErr', root).textContent = e.message; $('#pErr', root).hidden = false;
      }
    };
    setSheetMain({ text: 'Отправить на модерацию', onClick: submit });
  });
}

async function drawPromos(box, service) {
  const { items } = await get(`/api/owner/services/${service.id}/promos`);
  const now = Date.now();
  const label = (p) => p.status === 'approved' ? (p.starts_at > now ? '<span class="tag neutral">Запланирована</span>' : '<span class="tag good">Идёт</span>') : statusTag(p.status === 'cancelled' ? 'expired' : p.status);
  box.innerHTML = `
    ${service.status !== 'published' ? '<p class="callout">Акции станут доступны после публикации карточки.</p>' : '<button type="button" class="lgb cta press" id="newPromo">' + icon.plus + ' Новая акция</button>'}
    ${items.length ? items.map((p) => `
      <div class="card panel stack-sm">
        <div class="row-flex between"><b>${esc(p.title)}</b>${label(p)}</div>
        <span class="small muted">${dateShort(p.starts_at)} – ${dateShort(p.ends_at)}${p.discount_percent ? ` · −${p.discount_percent}%` : ''}${p.promo_code ? ` · <span class="code">${esc(p.promo_code)}</span>` : ''}</span>
        ${p.status === 'rejected' && p.reject_reason ? `<span class="small" style="color:var(--bad)">Причина: ${esc(p.reject_reason)}</span>` : ''}
        ${['pending', 'approved'].includes(p.status) && p.ends_at > now ? `<button type="button" class="link-btn danger" data-cancel="${p.id}" style="align-self:flex-start">Снять акцию</button>` : ''}
      </div>`).join('') : '<p class="note">Акций пока не было.</p>'}`;
  $('#newPromo', box)?.addEventListener('click', () => promoSheet(service.id, () => drawPromos(box, service)));
  $$('[data-cancel]', box).forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmDialog('Снять акцию с публикации?'))) return;
    try { await del(`/api/owner/promos/${b.dataset.cancel}`); toast('Акция снята'); drawPromos(box, service); } catch (e) { toastError(e); }
  }));
}

/* ---------------- Statistics ---------------- */
const niceMax = (v) => {
  if (v <= 5) return 5;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
};

// One series per chart: bars <= 24px with a 2px gap, 4px rounded tops anchored to the baseline,
// hairline grid, tap a day for its value.
export function barChart(box, daily, key, unitForms) {
  const W = Math.max(280, Math.round(box.clientWidth)), H = 150, top = 16, bottom = 22;
  const n = daily.length;
  const max = niceMax(Math.max(...daily.map((d) => d[key])));
  const slot = W / n;
  const bw = Math.min(24, Math.max(3, slot - 2));
  const y = (v) => H - bottom - (v / max) * (H - top - bottom);
  const bar = (d, i) => {
    const v = d[key];
    if (!v) return '';
    const x = i * slot + (slot - bw) / 2, yy = y(v), h = H - bottom - yy, r = Math.min(4, bw / 2, h);
    return `<path class="b" data-i="${i}" d="M${x},${H - bottom}V${yy + r}Q${x},${yy} ${x + r},${yy}H${x + bw - r}Q${x + bw},${yy} ${x + bw},${yy + r}V${H - bottom}Z"/>`;
  };
  const word = (v) => plural(v, ...unitForms);
  box.innerHTML = `
    <div class="readout" aria-live="polite"></div>
    <svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="По дням, максимум ${fmt(Math.max(...daily.map((d) => d[key])))}">
      <line class="grid" x1="0" x2="${W}" y1="${y(max)}" y2="${y(max)}"/><line class="grid" x1="0" x2="${W}" y1="${H - bottom}" y2="${H - bottom}"/>
      <text x="0" y="${y(max) - 4}">${fmt(max)}</text>
      ${daily.map(bar).join('')}
      ${daily.map((d, i) => `<rect class="hit" data-i="${i}" x="${i * slot}" y="0" width="${slot}" height="${H}"/>`).join('')}
      <text x="0" y="${H - 6}">${dateShort(Date.parse(daily[0].day))}</text>
      <text x="${W}" y="${H - 6}" text-anchor="end">${dateShort(Date.parse(daily[n - 1].day))}</text>
    </svg>`;
  const svg = $('svg', box), readout = $('.readout', box);
  const total = daily.reduce((s, d) => s + d[key], 0);
  readout.textContent = `${fmt(total)} ${word(total)} за ${n} дней`;
  svg.addEventListener('click', (e) => {
    const hit = e.target.closest('.hit');
    if (!hit) return;
    haptic.select();
    const i = Number(hit.dataset.i);
    const d = daily[i];
    svg.classList.add('picked');
    $$('.b', svg).forEach((b) => b.classList.toggle('on', Number(b.dataset.i) === i));
    readout.innerHTML = `<b>${dateShort(Date.parse(d.day))}</b> · ${fmt(d[key])} ${word(d[key])}`;
  });
}

async function drawStats(box, service) {
  const st = await get(`/api/owner/services/${service.id}/stats?days=30`);
  const ctr = st.totals.impressions ? ((st.totals.clicks / st.totals.impressions) * 100).toFixed(1).replace('.', ',') : '0';
  const c = st.top.components;
  const w = st.top.weights;
  const comp = (label, value, weight, detail) => `
    <div class="stack-sm" style="padding:10px 0">
      <div class="row-flex between"><span>${label} <span class="muted small">· вес ${Math.round(weight * 100)}%</span></span><b>${Math.round(value * 100)}%</b></div>
      <div class="bar"><i style="width:${Math.round(value * 100)}%"></i></div>
      <span class="small muted">${detail}</span>
    </div>`;
  box.innerHTML = `
    <div class="kpis">
      <div class="card kpi"><div class="k">Показы</div><div class="v">${fmt(st.totals.impressions)}</div></div>
      <div class="card kpi"><div class="k">Переходы в бот</div><div class="v">${fmt(st.totals.clicks)}</div></div>
      <div class="card kpi"><div class="k">Конверсия</div><div class="v">${ctr}%</div></div>
      <div class="card kpi"><div class="k">В избранном</div><div class="v">${fmt(st.favorites)}</div></div>
    </div>
    <div class="card panel stack-sm"><h3>Показы карточки</h3><div class="chart-box" id="chImp"></div></div>
    <div class="card panel stack-sm"><h3>Переходы в бот</h3><div class="chart-box" id="chClk"></div></div>
    <details class="card panel"><summary>Таблица по дням</summary>
      <table class="data-table"><thead><tr><th>День</th><th>Показы</th><th>Открытия</th><th>Переходы</th></tr></thead>
      <tbody>${st.daily.slice().reverse().map((d) => `<tr><td>${dateShort(Date.parse(d.day))}</td><td>${fmt(d.impressions)}</td><td>${fmt(d.views)}</td><td>${fmt(d.clicks)}</td></tr>`).join('')}</tbody></table>
    </details>
    <div class="card panel row-flex between">
      <div><div class="small muted">Средняя оценка</div><div style="font-size:24px;font-weight:700"><span class="star">★</span> ${st.rating.avg ? String(st.rating.avg).replace('.', ',') : '—'}</div></div>
      <div class="small muted" style="text-align:right">${fmt(st.rating.n)} ${plural(st.rating.n, 'отзыв', 'отзыва', 'отзывов')}${st.pending_reviews ? `<br>${st.pending_reviews} на модерации` : ''}</div>
    </div>
    <section>
      <p class="label">Топ месяца · ${esc(monthLabel(st.top.period))}, текущий расчёт</p>
      <div class="card panel">
        ${st.top.rank ? `
          <div class="row-flex between"><span style="font-size:15px">Место</span><span><b style="font-size:28px;letter-spacing:-.03em">${st.top.rank}</b> <span class="muted">из ${st.top.total}</span></span></div>
          <div class="row-flex between" style="padding-bottom:6px"><span class="muted small">Сводный балл</span><b>${String(st.top.score).replace('.', ',')}</b></div>
          ${comp('Оценки', c.rating, w.rating, c.rating_n ? `${String(c.rating_avg).replace('.', ',')}★ · ${c.rating_n} ${plural(c.rating_n, 'отзыв', 'отзыва', 'отзывов')} за месяц` : 'Нет отзывов за месяц')}
          ${comp('Клиенты', c.clients, w.clients, `${fmt(c.clients_n)} уникальных переходов в бот`)}
          ${comp('Стабильность', c.stability, w.stability, `${String(c.uptime_pct ?? 100).replace('.', ',')}% времени без сбоев по сигналам клиентов${c.downtime_min ? ` · сбои ${duration(c.downtime_min)}` : ''}`)}
        ` : '<p class="note">Сервис попадёт в расчёт после публикации карточки.</p>'}
      </div>
      <p class="note" style="margin-top:8px">Итоговый топ-10 публикуется 1-го числа. Позицию нельзя купить.</p>
    </section>`;
  const draw = () => {
    barChart($('#chImp', box), st.daily, 'impressions', ['показ', 'показа', 'показов']);
    barChart($('#chClk', box), st.daily, 'clicks', ['переход', 'перехода', 'переходов']);
  };
  requestAnimationFrame(draw);
  let lastW = 0;
  const ro = new ResizeObserver(() => { const w = box.clientWidth; if (w !== lastW) { lastW = w; draw(); } });
  ro.observe(box);
  return () => ro.disconnect();
}

/* ---------------- Service dashboard ---------------- */
export async function ownerService(root, { params, navigate }) {
  const id = Number(params.id);
  const data = await get(`/api/owner/services/${id}`);
  const s = data.service;
  const rev = data.revision;
  let tab = 'card';
  let stopStats = null;

  const statusBox = () => {
    if (s.hidden) return `<div class="callout bad"><b>Карточка скрыта администратором</b><br>${esc(s.hidden_reason || '')}</div>`;
    if (rev?.status === 'pending') return `<div class="callout"><b>На проверке</b> с ${dateLong(rev.created_at)}.<br>${s.status === 'published' ? 'Пока модератор не одобрит изменения, клиенты видят прежнюю версию.' : 'После одобрения карточка появится в каталоге.'}</div>`;
    if (rev?.status === 'rejected') return `<div class="callout bad"><b>Отклонено</b>${rev.reject_reason ? `: ${esc(rev.reject_reason)}` : ''}<br>Исправьте карточку и отправьте снова.</div>`;
    if (s.status === 'published') return `<div class="callout"><b>Опубликовано</b> · обновлено ${dateLong(s.updated_at || s.published_at)}</div>`;
    return '<div class="callout"><b>Черновик</b><br>Заполните карточку и тарифы и отправьте на проверку.</div>';
  };

  root.innerHTML = `
    <div class="svc-head">${logoHTML({ name: s.name, logo_url: s.logo_url }, 'xl')}<div class="grow"><h1 class="vpn-name">${esc(s.name)}</h1>
      ${s.status === 'published' && !s.hidden ? `<button type="button" class="link-btn" data-nav="/service/${s.id}">Открыть в каталоге ${icon.chev}</button>` : ''}</div></div>
    ${statusBox()}
    ${s.status === 'published' ? '<section class="card panel stack-sm status-card" id="healthBox"><div class="skeleton" style="min-height:90px"></div></section>' : ''}
    <div id="tabs">${segHTML([{ id: 'card', name: 'Карточка' }, { id: 'promos', name: 'Акции' }, { id: 'stats', name: 'Статистика' }], tab)}</div>
    <div id="tabBody" class="stack"></div>`;

  const submit = async (card) => {
    const err = $('#cardErr', root);
    err.hidden = true;
    mainProgress(true);
    try {
      await post(`/api/owner/services/${id}/revisions`, card);
      haptic.notify('success');
      toast('Отправлено на модерацию');
      navigate(`/owner/${id}`, { replace: true });
    } catch (e) {
      mainProgress(false);
      err.textContent = e.message;
      err.hidden = false;
      haptic.notify('error');
      err.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  const drawTab = async () => {
    stopStats?.();
    stopStats = null;
    const body = $('#tabBody', root);
    if (tab === 'card') {
      body.innerHTML = editorHTML(data.draft) + '<p class="note">Изменения публикуются после модерации. До одобрения клиенты видят прежнюю версию карточки.</p>';
      const collect = bindEditor(body, data.draft, submit);
      setMain({ text: rev?.status === 'pending' ? 'Обновить заявку на проверку' : 'Отправить на проверку', onClick: () => submit(collect()) });
      return;
    }
    setMain(null);
    body.innerHTML = '<div class="skeleton"></div>';
    try {
      if (tab === 'promos') await drawPromos(body, s);
      else stopStats = await drawStats(body, s);
    } catch (e) { body.innerHTML = emptyHTML(esc(e.message)); }
  };
  if (s.status === 'published') drawHealth($('#healthBox', root), id).catch(() => { $('#healthBox', root).remove(); });
  bindSeg($('#tabs .seg', root), (v) => { tab = v; drawTab(); });
  await drawTab();
  return () => stopStats?.();
}
