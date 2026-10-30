import { get, post, api, patch } from '../api.js';
import { store, trackView } from '../store.js';
import { haptic, openLink, setMain, copyText } from '../tg.js';
import {
  $, $$, esc, rub, fmt, plural, icon, logoHTML, marketTag, topTag, ratingStr, dateLong, dateShort, stars,
  openSheet, closeSheet, setSheetMain, toast, toastError, monthsWord, paymentsText,
  ago, healthTag, uptimeBarHTML, bindUptimeBar
} from '../ui.js';
import { PROTOCOL, COUNTRY, PLATFORM, TARIFF_MONTHS, MODERATION_STATUS, NETWORKS, NETWORK } from '../dict.js';

const timeMsk = (ts) => new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });

// Status from client signals + the two one-tap votes. Re-rendered after each vote.
function renderStatus(box, h, verifiedAt, serviceId) {
  const mine = h.my_vote;
  box.innerHTML = `
    <div class="row-flex between" style="align-items:flex-start">
      <span style="display:flex;flex-direction:column;gap:4px">${healthTag(h.status, true)}
        <span class="small muted">${h.status !== 'operational' && h.since ? `с ${timeMsk(h.since)} · ` : ''}${h.last_signal_at ? `последний сигнал ${ago(h.last_signal_at)}` : 'сигналов от клиентов пока нет'}</span></span>
    </div>
    ${uptimeBarHTML(h.days, h.uptime30)}
    <div class="legend"><span><i></i>без сбоев</span><span><i class="issues"></i>сообщения о сбоях</span><span><i class="outage"></i>массовый сбой</span></div>
    ${h.networks ? `<div class="nets" style="margin-top:6px"><span class="small muted">По сетям за ${h.networks.hours} ч</span>${h.networks.items.map((n) => {
      const total = n.up + n.down;
      return `<div class="net-row"><span>${esc(NETWORK[n.network]?.name || n.network)}</span><span class="split"><b style="width:${(n.up / total) * 100}%"></b><s style="width:${(n.down / total) * 100}%"></s></span><span class="n">работает у ${n.up} · сбои у ${n.down}</span></div>`;
    }).join('')}</div>` : ''}
    <p class="label" style="margin:10px 0 0">Как у вас сейчас?</p>
    <div class="vote-row">
      <button type="button" class="${mine?.value === 'up' ? 'sel' : 'fill'} btn press" data-vote="up" aria-pressed="${mine?.value === 'up'}">✓ Работает у меня</button>
      <button type="button" class="${mine?.value === 'down' ? 'sel' : 'fill'} btn press" data-vote="down" aria-pressed="${mine?.value === 'down'}">✕ Не работает у меня</button>
    </div>
    <div class="net-pick" id="netPick" hidden>
      <div class="row-flex between"><span class="small muted">Где проверяли? Можно пропустить</span><button type="button" class="fill circle press" id="netClose" aria-label="Пропустить">${icon.x}</button></div>
      <div class="chips">${NETWORKS.map((n) => `<button type="button" class="${mine?.network === n.id ? 'sel' : 'fill'} chip press" data-net="${n.id}">${n.name}</button>`).join('')}</div>
    </div>
    ${mine ? `<span class="small muted">Ваша отметка: ${mine.value === 'up' ? '«Работает у меня»' : '«Не работает у меня»'}${mine.network ? `, ${esc(NETWORK[mine.network]?.name || '')}` : ''} · ${ago(mine.created_at)}</span>` : ''}
    ${verifiedAt ? `<span class="verified-line">${icon.shield} Проверено администратором · ${dateLong(verifiedAt)}</span>` : ''}`;
  bindUptimeBar(box, h.days, h.uptime30);

  box.querySelectorAll('[data-vote]').forEach((b) => b.addEventListener('click', async () => {
    if (!store.me) { toast('Отмечать статус можно в Линзе внутри Telegram'); return; }
    haptic.impact('medium');
    try {
      const r = await post(`/api/services/${serviceId}/vote`, { value: b.dataset.vote });
      renderStatus(box, r.health, verifiedAt, serviceId);
      if (r.repeated) { toast('Ваша отметка уже учтена'); return; }
      haptic.notify('success');
      toast('Спасибо! Это помогает другим');
      $('#netPick', box).hidden = false;
    } catch (e) { toastError(e); }
  }));
  $('#netClose', box).addEventListener('click', () => { haptic.select(); $('#netPick', box).hidden = true; });
  box.querySelectorAll('[data-net]').forEach((b) => b.addEventListener('click', async () => {
    haptic.select();
    try {
      const r = await patch(`/api/services/${serviceId}/vote`, { network: b.dataset.net });
      renderStatus(box, r.health, verifiedAt, serviceId);
    } catch (e) { toastError(e); }
  }));
}

export function goToBot(s, source = 'card') {
  haptic.impact('medium');
  // Logged with keepalive so the request survives Telegram switching to the VPN bot.
  if (store.me) api(`/api/services/${s.id}/click`, { method: 'POST', body: { source }, keepalive: true }).catch(() => {});
  openLink(s.bot_url);
}

const yes = (v, a = 'Есть', b = 'Нет') => `<span class="${v ? 'ok' : 'no'}">${v ? a : b}</span>`;

export function reviewSheet(service, existing, onSaved) {
  let rating = existing?.rating || 0;
  openSheet(existing ? 'Изменить отзыв' : 'Ваш отзыв', `
    <div class="center"><div style="font-weight:600">${esc(service.name)}</div><div class="small muted">Оцените сервис от 1 до 5</div></div>
    <div class="rate-pick" role="radiogroup" aria-label="Оценка">${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="press" role="radio" data-rate="${n}" aria-checked="${n <= rating}" aria-label="${n}">★</button>`).join('')}</div>
    <label class="field"><span>Отзыв</span><textarea class="input" id="rvText" maxlength="2000" placeholder="Как работает: скорость, стабильность, поддержка, оплата">${esc(existing?.text || '')}</textarea></label>
    <div class="err" id="rvErr" hidden></div>
    <p class="note">Отзыв появится после модерации${existing ? ' — отредактированный отзыв проверяется заново' : ''}. Не указывайте личные данные и промокоды.</p>`,
  (root) => {
    const paint = () => $$('[data-rate]', root).forEach((b) => b.setAttribute('aria-checked', Number(b.dataset.rate) <= rating));
    $$('[data-rate]', root).forEach((b) => b.addEventListener('click', () => { haptic.select(); rating = Number(b.dataset.rate); paint(); }));
    const submit = async () => {
      const text = $('#rvText', root).value.trim();
      const err = $('#rvErr', root);
      if (!rating) { err.textContent = 'Поставьте оценку'; err.hidden = false; return; }
      if (text.length < 10) { err.textContent = 'Напишите хотя бы пару предложений'; err.hidden = false; return; }
      setSheetMain({ text: 'Отправляем…', progress: true, onClick: () => {} });
      try {
        const { review } = await post(`/api/services/${service.id}/reviews`, { rating, text });
        haptic.notify('success');
        closeSheet(true);
        toast('Спасибо! Отзыв отправлен на модерацию');
        onSaved?.(review);
      } catch (e) {
        setSheetMain({ text: 'Отправить на модерацию', onClick: submit });
        err.textContent = e.message; err.hidden = false;
      }
    };
    setSheetMain({ text: 'Отправить на модерацию', onClick: submit });
  });
}

function tariffRows(s, selected) {
  const months = TARIFF_MONTHS.filter((m) => s.tariffs[m]);
  const baseMonthly = s.tariffs[months[0]] / months[0];
  return months.map((m) => {
    const total = s.tariffs[m];
    const monthly = Math.round(total / m);
    const save = Math.round((1 - monthly / baseMonthly) * 100);
    return `<button type="button" class="row plan" role="radio" aria-checked="${m === selected}" data-plan="${m}">
      <span><span style="font-weight:600">${monthsWord(m)}</span>${save > 0 ? `<span class="save">−${save}%</span>` : ''}
      <span class="sub">${rub(monthly)} в месяц · ${rub(total)} за период</span></span><span class="radio"></span></button>`;
  }).join('');
}

export default async function service(root, { params }) {
  const id = Number(params.id);
  const s = await get(`/api/services/${id}`);
  trackView(id);
  const me = s.me;
  const countries = s.countries.map((c) => COUNTRY[c]).filter(Boolean);
  const verified = s.verified_at;
  const plans = TARIFF_MONTHS.filter((m) => s.tariffs[m]);

  root.innerHTML = `
    <div class="svc-head">
      ${logoHTML(s, 'xl')}
      <div class="grow">
        <h1 class="vpn-name">${esc(s.name)}</h1>
        <div class="meta"><span><span class="star">★</span> ${ratingStr(s.rating)} · ${fmt(s.reviews)} ${plural(s.reviews, 'отзыв', 'отзыва', 'отзывов')}</span></div>
        <div class="badges" style="margin-top:8px">${topTag(s.top)}${marketTag(s.market)}</div>
      </div>
    </div>

    <div class="stats">
      <div class="card stat"><span class="k">Цена</span><span class="v">от ${rub(s.min_monthly)}</span></div>
      <div class="card stat"><span class="k">Устройств</span><span class="v">до ${s.devices}</span></div>
      <div class="card stat"><span class="k">Стран</span><span class="v">${countries.length}</span></div>
    </div>

    <button type="button" class="cta-bot press" id="goBot">${icon.bot}<span>Перейти в бот<small>${esc(s.bot_url.replace('https://t.me/', '@').split('?')[0])} · оплата и подключение там</small></span></button>

    <section class="card panel stack-sm status-card" id="statusBox"></section>

    ${s.promo ? `
    <div class="card panel stack-sm">
      <div class="row-flex between"><span class="tag">${s.promo.discount_percent ? `−${s.promo.discount_percent}%` : 'Акция'}</span><span class="small muted">до ${dateLong(s.promo.ends_at)}</span></div>
      <div style="font-size:17px;font-weight:600">${esc(s.promo.title)}</div>
      ${s.promo.description ? `<div class="small muted">${esc(s.promo.description)}</div>` : ''}
      ${s.promo.promo_code ? `<button type="button" class="fill btn press" id="copyCode" style="align-self:flex-start">Промокод <span class="code">${esc(s.promo.promo_code)}</span></button>` : ''}
    </div>` : ''}

    <section>
      <p class="label">Тарифы</p>
      <div class="card group" role="radiogroup" aria-label="Тариф">${tariffRows(s, plans[0])}</div>
      <p class="note" style="margin-top:8px">Оплата происходит в боте сервиса — Линза не берёт комиссию.</p>
    </section>

    ${s.description ? `<section><p class="label">О сервисе</p><div class="card panel" style="font-size:15px;line-height:1.5;color:var(--text-2)">${esc(s.description)}</div></section>` : ''}

    <section>
      <p class="label">Параметры</p>
      <div class="card group">
        <div class="row"><span>Протоколы</span><span class="v">${esc(s.protocols.map((p) => PROTOCOL[p]?.name || p).join(', '))}</span></div>
        <div class="row" style="align-items:flex-start"><span>Страны</span><span class="v"><span class="flags">${countries.map((c) => c.flag).join(' ')}</span><br><span class="small">${esc(countries.map((c) => c.name).join(', '))}</span></span></div>
        <div class="row"><span>Устройства</span><span class="v">до ${s.devices}</span></div>
        <div class="row"><span>Платформы</span><span class="v">${esc(s.platforms.map((p) => PLATFORM[p]?.name || p).join(', '))}</span></div>
        <div class="row"><span>Оплата</span><span class="v">${esc(paymentsText(s.payments))}</span></div>
        <div class="row" style="align-items:flex-start"><span>Обход белых списков</span><span class="v">${yes(s.whitelist_bypass, 'Да', 'Нет')}${s.whitelist_note ? `<br><span class="small">${esc(s.whitelist_note)}</span>` : ''}</span></div>
        <div class="row" style="align-items:flex-start"><span>Пробный период</span><span class="v">${s.trial ? `<span class="ok">${s.trial_days ? `${s.trial_days} ${plural(s.trial_days, 'день', 'дня', 'дней')}` : 'Есть'}</span>${s.trial_terms ? `<br><span class="small">${esc(s.trial_terms)}</span>` : ''}` : yes(false)}</span></div>
        ${s.channel_url ? `<button type="button" class="row" data-link="${esc(s.channel_url)}"><span>Канал</span><span class="v" style="color:var(--accent-ink)">${esc(s.channel_url.replace('https://', ''))}</span></button>` : ''}
        ${s.support_contact ? `<div class="row"><span>Поддержка</span><span class="v">${esc(s.support_contact)}</span></div>` : ''}
      </div>
    </section>

    <div class="grid2">
      <button type="button" class="fill btn press" data-fav="${s.id}" aria-pressed="${store.favorites.has(s.id)}">${icon.heart(store.favorites.has(s.id))}${store.favorites.has(s.id) ? 'В избранном' : 'В избранное'}</button>
      <button type="button" class="${store.compare.includes(s.id) ? 'sel' : 'fill'} btn press cmp-btn" data-cmp="${s.id}" aria-pressed="${store.compare.includes(s.id)}">${icon.compare(store.compare.includes(s.id))}${store.compare.includes(s.id) ? 'В сравнении' : 'Сравнить'}</button>
    </div>

    <section id="reviewsSec">
      <div class="sec-head"><h2>Отзывы</h2><span class="muted small">${fmt(s.reviews)}</span></div>
      <div id="myReview"></div>
      <div id="reviewsList" class="stack"></div>
    </section>`;

  renderStatus($('#statusBox', root), s.health, verified, id);

  $$('[data-plan]', root).forEach((b) => b.addEventListener('click', () => {
    haptic.select();
    $$('[data-plan]', root).forEach((x) => x.setAttribute('aria-checked', x === b));
  }));
  $$('[data-link]', root).forEach((b) => b.addEventListener('click', () => openLink(b.dataset.link)));
  $('#copyCode', root)?.addEventListener('click', async () => {
    haptic.impact('light');
    toast((await copyText(s.promo.promo_code)) ? 'Промокод скопирован' : `Промокод: ${s.promo.promo_code}`);
  });

  let canReview = Boolean(me?.can_review);
  let myReview = me?.review || null;
  const renderMine = () => {
    const box = $('#myReview', root);
    if (!store.me) { box.innerHTML = ''; return; }
    if (myReview) {
      const st = myReview.status;
      box.innerHTML = `<div class="card review" style="margin-bottom:14px">
        <div class="row-flex between"><b>Ваш отзыв</b><span class="tag ${st === 'approved' ? 'good' : st === 'rejected' ? 'bad' : 'warn'}">${st === 'approved' ? 'Опубликован' : MODERATION_STATUS[st]}</span></div>
        ${stars(myReview.rating)}<p>${esc(myReview.text)}</p>
        ${st === 'rejected' && myReview.reject_reason ? `<p class="small" style="color:var(--bad)">Причина: ${esc(myReview.reject_reason)}</p>` : ''}
        <button type="button" class="link-btn" id="editReview" style="align-self:flex-start">Изменить</button></div>`;
    } else {
      box.innerHTML = canReview
        ? '<button type="button" class="lgb cta press" id="editReview" style="margin-bottom:14px">Оставить отзыв</button>'
        : '<p class="callout" style="margin:0 0 14px">Отзыв можно оставить после перехода в бот этого VPN через Линзу — так отзывы пишут реальные клиенты.</p>';
    }
    $('#editReview', box)?.addEventListener('click', () => reviewSheet(s, myReview, (r) => { myReview = r; renderMine(); }));
  };
  renderMine();

  let offset = 0;
  const loadReviews = async () => {
    const data = await get(`/api/services/${id}/reviews?offset=${offset}`);
    const list = $('#reviewsList', root);
    $('#moreReviews', list)?.remove();
    if (!offset && s.reviews) {
      const total = Object.values(data.distribution).reduce((a, b) => a + b, 0) || 1;
      list.insertAdjacentHTML('beforeend', `<div class="card panel dist">${[5, 4, 3, 2, 1].map((n) =>
        `<span>${n}★</span><span class="bar"><i style="width:${Math.round(((data.distribution[n] || 0) / total) * 100)}%"></i></span><span style="text-align:right">${data.distribution[n] || 0}</span>`).join('')}</div>`);
    }
    if (!offset && !data.items.length) list.insertAdjacentHTML('beforeend', '<p class="note">Отзывов пока нет.</p>');
    list.insertAdjacentHTML('beforeend', data.items.map((r) => `
      <article class="card review">
        <div class="row-flex between"><span class="row-flex"><b>${esc(r.first_name || 'Клиент')}</b>${stars(r.rating)}</span><span class="small muted">${dateShort(r.created_at)}</span></div>
        <p>${esc(r.text)}</p>
      </article>`).join(''));
    offset += data.items.length;
    if (data.items.length === 20) {
      list.insertAdjacentHTML('beforeend', '<button type="button" class="fill btn block press" id="moreReviews">Показать ещё</button>');
      $('#moreReviews', list).addEventListener('click', () => loadReviews().catch(toastError));
    }
  };
  loadReviews().catch(() => {});

  const go = () => {
    goToBot(s, 'card');
    if (store.me && !canReview) { canReview = true; setTimeout(renderMine, 600); }
  };
  $('#goBot', root).addEventListener('click', go);
  setMain({ text: 'Перейти в бот', onClick: go, shine: true });
}
