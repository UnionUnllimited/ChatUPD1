import { get } from '../api.js';
import { store, trackImpressions } from '../store.js';
import { $, esc, rub, fmt, plural, icon, logoHTML, skeletonHTML, dateShort, openSheet, applyLens, ratingStr, marketTag, avatarHTML } from '../ui.js';
import { monthLabel } from '../dict.js';
import { radarMiniHTML } from './radar.js';

export function topExplainer(weights = { rating: 0.4, clients: 0.3, stability: 0.3 }) {
  const pct = (v) => Math.round(v * 100) + '%';
  openSheet('Как считается топ', `
    <p class="note" style="font-size:15px;color:var(--text-2)">Рейтинг пересчитывается 1-го числа по итогам прошлого месяца. Его нельзя купить: рекламные места, когда появятся, будут идти отдельно с пометкой «Реклама».</p>
    <div class="card group">
      <div class="row"><span><b>${pct(weights.rating)}</b> · Оценки</span><span class="v small">средняя оценка отзывов за месяц</span></div>
      <div class="row"><span><b>${pct(weights.clients)}</b> · Клиенты</span><span class="v small">уникальные переходы в бот через Линзу</span></div>
      <div class="row"><span><b>${pct(weights.stability)}</b> · Стабильность</span><span class="v small">доля времени без сбоев по сигналам клиентов</span></div>
    </div>
    <p class="note">Отзывы оставляют только те, кто перешёл в бот сервиса через Линзу, и каждый отзыв проходит модерацию. Чтобы один отзыв не решал исход месяца, средняя оценка сглаживается.</p>`);
}

export function topRowHTML(e) {
  const s = e.service;
  return `
    <button type="button" class="row press" data-open="${s.id}" data-impression="${s.id}">
      <span class="rank ${e.rank <= 3 ? 'gold' : ''}">${e.rank}</span>
      ${logoHTML(s, 'sm')}
      <span class="grow" style="display:flex;flex-direction:column;gap:2px">
        <span style="font-weight:600">${esc(s.name)}</span>
        <span class="small muted"><span class="star">★</span> ${ratingStr(s.rating)} · от ${rub(s.min_monthly)}/мес</span>
      </span>
      <span class="small muted" style="font-variant-numeric:tabular-nums">${String(e.score).replace('.', ',')}</span>
      ${icon.chev}
    </button>`;
}

function promoCardHTML(s) {
  const p = s.promo;
  return `
    <button type="button" class="card promo press" data-open="${s.id}" data-impression="${s.id}">
      <div class="row-flex">${logoHTML(s, 'sm')}<span class="grow" style="font-weight:600">${esc(s.name)}</span></div>
      <div class="pct">${p.discount_percent ? `−${p.discount_percent}%` : 'Акция'}</div>
      <div style="font-size:15px;font-weight:500;line-height:1.3">${esc(p.title)}</div>
      <div class="row-flex between small muted"><span>от ${rub(s.min_monthly)}/мес</span><span>до ${dateShort(p.ends_at)}</span></div>
    </button>`;
}

export default async function home(root, { navigate }) {
  const me = store.me;
  root.innerHTML = `
    <div class="topbar">
      <span class="brand"><img src="img/logo.svg" alt="">Линза</span>
      <button type="button" class="press" data-nav="/profile" aria-label="Профиль" style="border-radius:50%">${avatarHTML(me || { first_name: 'Я' })}</button>
    </div>
    <section class="hero">
      <h1>Работающий VPN.<br><span>По честной цене.</span></h1>
      <p id="heroLead">Сравните цены, протоколы и проверки VPN-сервисов из Telegram в одном месте.</p>
      <form class="lg search" id="homeSearch" data-lens="18" role="search">
        ${icon.search}
        <input type="search" name="q" placeholder="Название VPN" enterkeyhint="search" autocomplete="off" aria-label="Поиск по названию">
        <button type="submit" class="solid btn sm press">Найти</button>
      </form>
      <button type="button" class="lgb btn press pick-entry" data-nav="/pick">Подобрать VPN за 30 секунд</button>
    </section>
    <div class="chips scroll" id="quick" style="margin-top:-12px"></div>
    <div id="radarSec"></div>
    <section id="topSec">${skeletonHTML(1)}</section>
    <section id="promoSec"></section>
    <p class="note center">Рейтинг строится по отзывам, переходам и стабильности по сигналам клиентов. Платные места всегда отмечены «Реклама» и не влияют на него.</p>`;

  applyLens($('#homeSearch', root));
  $('#homeSearch', root).addEventListener('submit', (e) => {
    e.preventDefault();
    const q = e.target.q.value.trim();
    navigate(q ? `/catalog?q=${encodeURIComponent(q)}` : '/catalog');
  });

  const data = await get('/api/home');
  $('#heroLead', root).textContent = `Сравните цены, протоколы и проверки ${data.total} ${plural(data.total, 'VPN-сервиса', 'VPN-сервисов', 'VPN-сервисов')} из Telegram. Рейтинг не продаётся.`;
  $('#quick', root).innerHTML = [
    ['Дешёвые', 'sort=price&below_market=1', data.quick.cheap],
    ['С триалом', 'trial=1', data.quick.trial],
    ['Оплата картой РФ', 'payments=card_ru', data.quick.card_ru]
  ].map(([label, q, n]) => `<button type="button" class="fill chip press" data-nav="/catalog?${q}">${label} <span class="n">${n}</span></button>`).join('');

  $('#radarSec', root).innerHTML = radarMiniHTML(data.radar);
  const top = data.top;
  $('#topSec', root).innerHTML = top ? `
    <div class="sec-head">
      <h2>Топ-10 за ${esc(monthLabel(top.period).split(' ')[0])}</h2>
      <button type="button" class="link-btn" id="howTop">${icon.info} Как считается</button>
    </div>
    <div class="card group">${top.entries.map(topRowHTML).join('')}</div>
    <div class="row-flex between" style="padding:6px 4px 0">
      <span class="small muted">Пересчёт 1-го числа каждого месяца</span>
      <button type="button" class="link-btn" data-nav="/top">Архив ${icon.chev}</button>
    </div>` : `
    <div class="sec-head"><h2>Топ-10 месяца</h2></div>
    <div class="card empty"><p>Первый рейтинг появится 1-го числа по итогам месяца.</p></div>`;
  $('#howTop', root)?.addEventListener('click', () => topExplainer(top?.weights));

  $('#promoSec', root).innerHTML = data.promos.length ? `
    <div class="sec-head"><h2>Скидки и акции</h2><button type="button" class="link-btn" data-nav="/catalog?promo=1">Все ${icon.chev}</button></div>
    <div class="promos">${data.promos.map(promoCardHTML).join('')}</div>` : '';

  if (data.market_avg) {
    $('#promoSec', root).insertAdjacentHTML('beforeend', `
      <div class="card panel row-flex between" style="margin-top:6px">
        <div><div class="small muted">Средняя цена по каталогу</div><div style="font-size:22px;font-weight:700;letter-spacing:-.02em">${rub(data.market_avg)}<span class="small muted" style="font-weight:500"> /мес</span></div></div>
        <div class="stack-sm" style="align-items:flex-end">${marketTag('below')}${marketTag('market')}${marketTag('above')}</div>
      </div>
      <p class="note" style="margin-top:8px">Метка у каждой карточки сравнивает цену за месяц со средней по ${fmt(data.total)} сервисам.</p>`);
  }
  trackImpressions(root);
}
