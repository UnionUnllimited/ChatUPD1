// Ad exchange: channel admins list ad slots, VPN owners book them. Deals are settled
// directly in Telegram for now; Линза shows CPM, opens contacts and collects buyers' reviews.
import { get, post, put, del, qs } from '../api.js';
import { store, hasRole, loadMe } from '../store.js';
import { haptic, setMain, mainProgress, confirmDialog, openLink } from '../tg.js';
import {
  $, $$, esc, rub, plural, icon, logoHTML, emptyHTML, skeletonHTML, errorHTML, segHTML, bindSeg, renderList,
  openSheet, closeSheet, setSheetMain, reasonSheet, toast, toastError
} from '../ui.js';
import { AD_TOPICS, AD_TOPIC, AD_FORMATS, AD_FORMAT, AD_DEAL_STATUS, AD_COMPLAINT_REASONS, AD_REACH_MATCH, CPM_LIGHT } from '../dict.js';

/* ---------------- Helpers ---------------- */

// 195000 → «195K», 4500 → «4,5K», 1200000 → «1,2M».
export const kfmt = (n) => {
  if (n >= 1e6) return `${String(Math.round(n / 1e5) / 10).replace('.', ',')}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}K`;
  if (n >= 1e3) return `${String(Math.round(n / 100) / 10).replace('.', ',')}K`;
  return String(n);
};
const dayLabel = (d, month = 'long') => new Date(`${d}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month, timeZone: 'UTC' }).replace('.', '');
const mskToday = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const channelLogo = (c, size = '') => logoHTML({ name: c.title, logo_url: c.photo_url }, size);
const verifiedTag = (c) => (c.verified ? `<span class="tag good" title="Продавец добавил бота Линзы админом канала">${icon.check}канал</span>` : '');

export function cpmHTML(offer) {
  if (!offer || offer.cpm === null) return '<span class="small muted">CPM —</span>';
  const l = CPM_LIGHT[offer.light];
  return `<span class="cpm"><span>CPM <b>${rub(offer.cpm)}</b></span><span class="light ${l.tone}"><i aria-hidden="true"></i>${l.name}</span></span>`;
}

function buyersLine(c) {
  if (!c.placements) return 'Пока без размещений через Линзу';
  return `Покупатели: ${c.placements} ${plural(c.placements, 'размещение', 'размещения', 'размещений')}${c.rating ? ` · <span class="star">★</span> ${String(c.rating).replace('.', ',')}` : ''}`;
}

export function channelCardHTML(c) {
  const b = c.best;
  return `
  <article class="card vpn ad press" data-key="${c.id}" data-ad="${c.id}">
    <div class="vpn-head">
      ${channelLogo(c)}
      <div class="grow">
        <div class="vpn-name">${esc(c.title)} ${verifiedTag(c)}</div>
        <div class="meta"><span>${esc(AD_TOPIC[c.topic]?.name || '')} · ${kfmt(c.subscribers)} ${plural(c.subscribers, 'подписчик', 'подписчика', 'подписчиков')}</span></div>
      </div>
    </div>
    <div class="ad-reach">Охват 24ч: <b>${kfmt(c.reach_24)}</b> &nbsp; 48ч: <b>${kfmt(c.reach_48)}</b>${c.stats_url ? '' : ' <span class="muted">· со слов продавца</span>'}</div>
    ${b ? `<div class="ad-offer"><span><b>${esc(AD_FORMAT[b.id].name)} — ${rub(b.price)}</b></span>${cpmHTML(b)}</div>` : ''}
    <span class="small muted">${buyersLine(c)}</span>
    <div class="vpn-foot" style="justify-content:flex-end">
      <div class="vpn-actions">
        <button type="button" class="fill circle press" data-adfav="${c.id}" aria-pressed="${Boolean(c.fav)}" aria-label="${c.fav ? 'Убрать из избранного' : 'В избранное'}">${icon.heart(c.fav)}</button>
        <button type="button" class="fill btn sm press" data-ad="${c.id}">Подробнее</button>
      </div>
    </div>
  </article>`;
}

// Shared clicks for channel cards: open, favourite.
function bindCards(root, navigate) {
  const ac = new AbortController();
  root.addEventListener('click', async (e) => {
    const fav = e.target.closest('[data-adfav]');
    if (fav) {
      e.stopPropagation();
      const on = fav.getAttribute('aria-pressed') !== 'true';
      haptic.select();
      fav.setAttribute('aria-pressed', on);
      fav.innerHTML = icon.heart(on);
      post(`/api/ads/channels/${fav.dataset.adfav}/favorite`, { on }).catch((err) => { fav.setAttribute('aria-pressed', !on); fav.innerHTML = icon.heart(!on); toastError(err); });
      return;
    }
    const open = e.target.closest('[data-ad]');
    if (open) { haptic.impact('light'); navigate(`/ads/${open.dataset.ad}`); }
  }, { signal: ac.signal });
  return () => ac.abort();
}

const needTelegram = (root, title) => {
  root.innerHTML = `<div class="topbar"><h1 class="title">${title}</h1></div>${emptyHTML('Биржа рекламы доступна в Telegram: откройте Линзу через бота — вход произойдёт автоматически.')}`;
};

/* ---------------- Feed ---------------- */

const SORTS = [{ id: 'cpm', name: 'Дешёвый CPM' }, { id: 'reach', name: 'Охват' }, { id: 'rating', name: 'Рейтинг' }];
const FLAGS = [['verified', 'Только подтверждённые каналы'], ['had_vpn', 'Уже были VPN-размещения']];
const emptyFilters = () => ({ topics: [], format: '', reach_min: '', price_max: '', cpm_max: '', date: '', verified: false, had_vpn: false });

function filterCount(f) {
  return f.topics.length + ['format', 'reach_min', 'price_max', 'cpm_max', 'date'].filter((k) => f[k]).length + FLAGS.filter(([k]) => f[k]).length;
}

export async function adsFeed(root, { navigate, query }) {
  if (!store.me) return needTelegram(root, 'Биржа рекламы');
  const f = { ...emptyFilters(), sort: SORTS.some((s) => s.id === query.sort) ? query.sort : 'cpm', favorites: query.favorites === '1' };
  root.innerHTML = `
    <div class="topbar"><h1 class="title">Биржа рекламы</h1><span class="muted small" id="adCount"></span></div>
    <div id="adSort">${segHTML(SORTS, f.sort)}</div>
    <div class="row-flex between">
      <button type="button" class="fill btn press" id="adFilters">${icon.filter} Фильтры <span class="dot" id="adDot" hidden></span></button>
      <button type="button" class="${f.favorites ? 'sel' : 'fill'} chip press" id="adFavs" aria-pressed="${f.favorites}">${icon.heart(f.favorites)} Избранные</button>
    </div>
    <div class="list" id="adList">${skeletonHTML(3)}</div>`;

  let seq = 0;
  let cfg = { cpm_good: 250, cpm_ok: 350 };
  async function load() {
    const my = ++seq;
    const n = filterCount(f);
    $('#adDot', root).hidden = !n;
    $('#adDot', root).textContent = n;
    const params = { sort: f.sort, topics: f.topics.join(','), format: f.format, reach_min: f.reach_min, price_max: f.price_max, cpm_max: f.cpm_max, date: f.date, verified: f.verified ? '1' : '', had_vpn: f.had_vpn ? '1' : '', favorites: f.favorites ? '1' : '' };
    try {
      const d = await get('/api/ads/channels' + qs(params));
      if (my !== seq) return;
      cfg = d.config;
      $('#adCount', root).textContent = `${d.items.length} из ${d.total}`;
      renderList($('#adList', root), d.items.length ? d.items.map(channelCardHTML).join('')
        : emptyHTML(d.total ? 'Под эти условия каналов нет. Ослабьте фильтры.' : 'На бирже пока нет каналов. Админы каналов могут разместиться в профиле → «Реклама».'));
    } catch (e) {
      if (my === seq) $('#adList', root).innerHTML = errorHTML(e);
    }
  }

  bindSeg($('#adSort .seg', root), (v) => { f.sort = v; load(); });
  $('#adFavs', root).addEventListener('click', (e) => {
    haptic.select();
    f.favorites = !f.favorites;
    e.currentTarget.className = `${f.favorites ? 'sel' : 'fill'} chip press`;
    e.currentTarget.setAttribute('aria-pressed', f.favorites);
    e.currentTarget.innerHTML = `${icon.heart(f.favorites)} Избранные`;
    load();
  });
  $('#adFilters', root).addEventListener('click', () => {
    haptic.impact('light');
    const draft = JSON.parse(JSON.stringify(f));
    const chip = (on, attrs, label) => `<button type="button" class="${on ? 'sel' : 'fill'} chip press" ${attrs}>${label}</button>`;
    openSheet('Фильтры', `
      <div><p class="label">Тематика</p><div class="chips" id="fTopics">${AD_TOPICS.map((t) => chip(draft.topics.includes(t.id), `data-topic="${t.id}"`, esc(t.name))).join('')}</div></div>
      <div><p class="label">Формат</p><div class="chips" id="fFormat">${[{ id: '', name: 'Любой' }, ...AD_FORMATS].map((x) => chip(draft.format === x.id, `data-format="${x.id}"`, esc(x.name))).join('')}</div></div>
      <div class="grid2">
        <label class="field"><span>Охват 24ч от</span><input class="input" type="number" inputmode="numeric" min="0" id="fReach" value="${esc(draft.reach_min)}" placeholder="10000"></label>
        <label class="field"><span>Цена до, ₽</span><input class="input" type="number" inputmode="numeric" min="0" id="fPrice" value="${esc(draft.price_max)}" placeholder="5000"></label>
      </div>
      <div><label class="field"><span>CPM до, ₽</span><input class="input" type="number" inputmode="numeric" min="0" id="fCpm" value="${esc(draft.cpm_max)}" placeholder="${cfg.cpm_ok}"></label>
        <div class="chips" style="margin-top:8px">${[cfg.cpm_good, cfg.cpm_ok].map((v) => chip(String(draft.cpm_max) === String(v), `data-cpm="${v}"`, `до ${v} ₽`)).join('')}</div></div>
      <label class="field"><span>Свободная дата</span><input class="input" type="date" id="fDate" min="${mskToday()}" value="${esc(draft.date)}"></label>
      <div class="card group">${FLAGS.map(([k, l]) => `<label class="row"><span>${l}</span><input class="sw" type="checkbox" data-flag="${k}" ${draft[k] ? 'checked' : ''}></label>`).join('')}</div>
      <button type="button" class="fill cta press" id="fReset">Сбросить фильтры</button>`, (sheet) => {
      const toggle = (b, on) => { b.className = `${on ? 'sel' : 'fill'} chip press`; };
      sheet.addEventListener('click', (e) => {
        const t = e.target.closest('[data-topic]');
        const fm = e.target.closest('[data-format]');
        const c = e.target.closest('[data-cpm]');
        if (t) { haptic.select(); const v = t.dataset.topic; draft.topics = draft.topics.includes(v) ? draft.topics.filter((x) => x !== v) : [...draft.topics, v]; toggle(t, draft.topics.includes(v)); }
        if (fm) { haptic.select(); draft.format = fm.dataset.format; $$('[data-format]', sheet).forEach((b) => toggle(b, b.dataset.format === draft.format)); }
        if (c) { haptic.select(); draft.cpm_max = c.dataset.cpm; $('#fCpm', sheet).value = draft.cpm_max; $$('[data-cpm]', sheet).forEach((b) => toggle(b, b === c)); }
      });
      $('#fReset', sheet).addEventListener('click', () => { haptic.impact('light'); Object.assign(f, emptyFilters()); closeSheet(); load(); });
      setSheetMain({
        text: 'Показать',
        onClick: () => {
          Object.assign(f, draft, {
            reach_min: $('#fReach', sheet).value, price_max: $('#fPrice', sheet).value, cpm_max: $('#fCpm', sheet).value, date: $('#fDate', sheet).value,
            ...Object.fromEntries($$('[data-flag]', sheet).map((i) => [i.dataset.flag, i.checked]))
          });
          closeSheet();
          load();
        }
      });
    });
  });
  const unbind = bindCards(root, navigate);
  await load();
  return unbind;
}

/* ---------------- Channel ---------------- */

export async function adChannel(root, { params, navigate }) {
  if (!store.me) return needTelegram(root, 'Канал');
  const id = Number(params.id);
  const c = await get(`/api/ads/channels/${id}`);
  const me = c.me || {};
  const statsName = c.stats_url ? (c.stats_url.includes('tgstat') ? 'TGStat' : 'Telemetr') : '';
  const reachSrc = c.stats_url ? `по ${statsName}` : 'со слов продавца';
  const STATUS_NOTE = { hidden: 'Скрыт вами — покупатели его не видят.', review: 'Снят на проверку после жалоб покупателей.', blocked: `Снят с биржи${c.block_reason ? `: ${esc(c.block_reason)}` : '.'}` };

  root.innerHTML = `
    <div class="svc-head">
      ${channelLogo(c, 'xl')}
      <div class="grow">
        <h1 class="vpn-name">${esc(c.title)}</h1>
        <div class="meta"><span>${esc(AD_TOPIC[c.topic]?.name || '')}</span>${verifiedTag(c)}</div>
        <a class="link-btn" href="${esc(c.link)}" data-ext="${esc(c.link)}" style="padding:0">${esc(c.link.replace('https://', ''))}</a>
      </div>
      <button type="button" class="fill circle press" id="chFav" aria-pressed="${Boolean(me.fav)}" aria-label="В избранное" style="align-self:flex-start">${icon.heart(me.fav)}</button>
    </div>
    ${c.status !== 'active' ? `<div class="callout warn">${STATUS_NOTE[c.status] || ''}</div>` : ''}

    <div class="stats">
      <div class="card stat"><span class="k">Подписчики</span><span class="v">${kfmt(c.subscribers)}</span><span class="small muted">${c.subscribers_from_tg ? 'из Telegram' : 'со слов продавца'}</span></div>
      <div class="card stat"><span class="k">Охват 24ч</span><span class="v">${kfmt(c.reach_24)}</span><span class="small muted">${reachSrc}</span></div>
      <div class="card stat"><span class="k">Охват 48ч</span><span class="v">${kfmt(c.reach_48)}</span><span class="small muted">${reachSrc}</span></div>
    </div>
    ${c.stats_url ? `<a class="link-btn" href="${esc(c.stats_url)}" data-ext="${esc(c.stats_url)}" style="align-self:flex-start;margin-top:-10px">Статистика канала в ${statsName} ↗</a>` : ''}

    <section>
      <p class="label">Форматы и цены</p>
      <div class="card group">${c.formats.map((x) => `
        <div class="row" style="align-items:flex-start">
          <span style="display:flex;flex-direction:column;gap:2px"><b>${esc(AD_FORMAT[x.id].name)} — ${rub(x.price)}</b><span class="small muted">${esc(AD_FORMAT[x.id].hint)}</span></span>
          ${cpmHTML(x)}
        </div>`).join('')}</div>
      <p class="note">CPM — цена за 1000 просмотров: цена ÷ охват × 1000. До ${rub(c.config.cpm_good)} — выгодно, до ${rub(c.config.cpm_ok)} — норма, дороже — дорого.</p>
    </section>

    <section>
      <p class="label">Свободные даты</p>
      <p style="margin:0">${c.free_dates.length ? `${c.free_dates.slice(0, 12).map((d) => dayLabel(d, 'short')).join(' · ')}${c.free_dates.length > 12 ? ` и ещё ${c.free_dates.length - 12}` : ''}` : '<span class="muted">Продавец не указал даты — договоритесь в заявке.</span>'}</p>
      <p class="small muted" style="margin-top:8px">VPN-размещения в канале ${c.had_vpn ? '<b>уже были</b>' : '<b>ещё не было</b>'}</p>
    </section>

    <section>
      <p class="label">Отзывы покупателей</p>
      <div class="card panel stack-sm">
        <span>${c.rating ? `<span class="star">★</span> <b>${String(c.rating).replace('.', ',')}</b> · ` : ''}${c.placements ? `${c.placements} ${plural(c.placements, 'размещение', 'размещения', 'размещений')} через Линзу` : 'Размещений через Линзу ещё не было'}</span>
        ${c.reviews.length ? `<span class="small muted">${[
          c.avg_came != null ? `в среднем пришло ${kfmt(c.avg_came)}` : '',
          c.avg_payments != null ? `оплат ${c.avg_payments}` : '',
          c.reach_match ? `охват совпал у ${c.reach_match.yes} из ${c.reach_match.of}` : ''
        ].filter(Boolean).join(' · ')}</span>` : '<span class="small muted">Оценки ставят только покупатели, чьё размещение состоялось.</span>'}
      </div>
      <div class="list" style="margin-top:10px">${c.reviews.map((r) => `
        <article class="card review">
          <div class="row-flex between"><span class="row-flex"><b>${r.service_name ? esc(r.service_name) : 'Покупатель'}</b><span class="star">${'★'.repeat(r.rating)}</span></span><span class="small muted">${AD_FORMAT[r.format]?.name || ''}</span></div>
          <span class="small muted">${[r.came != null ? `пришло ${kfmt(r.came)}` : '', r.payments != null ? `оплат ${r.payments}` : '', r.reach_match ? `охват: ${AD_REACH_MATCH.find((m) => m.id === r.reach_match)?.name.toLowerCase()}` : ''].filter(Boolean).join(' · ')}</span>
          ${r.text ? `<p>${esc(r.text)}</p>` : ''}
        </article>`).join('')}</div>
    </section>

    ${!me.mine && !hasRole('vpn_owner') ? '<p class="note center">Бронировать размещения могут владельцы VPN: подключите свой сервис в профиле → «VPN-сервис».</p>' : ''}
    ${!me.mine && !me.complained ? '<button type="button" class="link-btn press" id="chComplain" style="align-self:center">Пожаловаться</button>' : ''}`;

  $$('[data-ext]', root).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openLink(a.dataset.ext); }));
  $('#chFav', root).addEventListener('click', (e) => {
    const b = e.currentTarget;
    const on = b.getAttribute('aria-pressed') !== 'true';
    haptic.select();
    b.setAttribute('aria-pressed', on);
    b.innerHTML = icon.heart(on);
    post(`/api/ads/channels/${id}/favorite`, { on }).catch(toastError);
  });
  $('#chComplain', root)?.addEventListener('click', () => complaintSheet(id, () => { $('#chComplain', root)?.remove(); }));

  if (me.mine) setMain({ text: 'Редактировать канал', onClick: () => navigate(`/ads/my/${id}`) });
  else if (me.open_deal) setMain({ text: 'Открыть мою заявку', onClick: () => navigate(`/ads/deals/${me.open_deal.id}`) });
  else if (me.can_book) setMain({ text: 'Забронировать', onClick: () => bookingSheet(c, navigate), shine: true });
}

function bookingSheet(c, navigate) {
  haptic.impact('light');
  const services = c.me.services || [];
  const pick = { format: c.best?.id || c.formats[0]?.id, date: c.free_dates[0] || '', service_id: services.length === 1 ? services[0].id : '' };
  const chips = (items, key, label) => `<div class="chips">${items.map((x) => `<button type="button" class="${String(pick[key]) === String(x.id) ? 'sel' : 'fill'} chip press" data-pick="${key}" data-v="${esc(x.id)}">${label(x)}</button>`).join('')}</div>`;
  openSheet('Заявка на размещение', `
    <div><p class="label">Формат</p>${chips(c.formats, 'format', (x) => `${esc(AD_FORMAT[x.id].name)} · ${rub(x.price)}`)}</div>
    <div><p class="label">Дата</p>${c.free_dates.length ? chips(c.free_dates.slice(0, 21).map((d) => ({ id: d })), 'date', (x) => dayLabel(x.id, 'short'))
      : `<input class="input" type="date" id="bDate" min="${mskToday()}" max="${addDays(mskToday(), 90)}">`}</div>
    ${services.length ? `<div><p class="label">Какой VPN рекламируете</p>${chips(services, 'service_id', (x) => esc(x.name))}</div>` : ''}
    <label class="field"><span>Комментарий — необязательно</span><textarea class="input" id="bComment" maxlength="500" placeholder="Тематика креатива, пожелания по времени"></textarea></label>
    <div class="err" id="bErr" hidden></div>
    <p class="note">Продавцу придёт уведомление. После согласования откроются контакты: креатив и оплату обсуждаете напрямую в Telegram. Сейчас Линза ничего за это не берёт.</p>`,
  (sheet) => {
    sheet.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pick]');
      if (!b) return;
      haptic.select();
      pick[b.dataset.pick] = b.dataset.v;
      $$(`[data-pick="${b.dataset.pick}"]`, sheet).forEach((x) => { x.className = `${x === b ? 'sel' : 'fill'} chip press`; });
    });
    setSheetMain({
      text: 'Отправить заявку',
      onClick: async () => {
        const body = { format: pick.format, date: $('#bDate', sheet)?.value || pick.date, service_id: pick.service_id || null, comment: $('#bComment', sheet).value };
        try {
          const r = await post(`/api/ads/channels/${c.id}/deals`, body);
          haptic.notify('success');
          closeSheet(true);
          toast('Заявка отправлена продавцу');
          navigate(`/ads/deals/${r.id}`);
        } catch (e) { $('#bErr', sheet).textContent = e.message; $('#bErr', sheet).hidden = false; }
      }
    });
  });
}

function complaintSheet(id, onDone) {
  haptic.impact('light');
  let reason = '';
  openSheet('Пожаловаться на канал', `
    <div class="chips">${AD_COMPLAINT_REASONS.map((r) => `<button type="button" class="fill chip press" data-reason="${r.id}">${esc(r.name)}</button>`).join('')}</div>
    <label class="field"><span>Подробности — необязательно</span><textarea class="input" id="cText" maxlength="500" placeholder="Что случилось"></textarea></label>
    <div class="err" id="cErr" hidden></div>
    <p class="note">Если на канал пожалуются несколько покупателей, он уйдёт с биржи на проверку.</p>`,
  (sheet) => {
    sheet.addEventListener('click', (e) => {
      const b = e.target.closest('[data-reason]');
      if (!b) return;
      haptic.select();
      reason = b.dataset.reason;
      $$('[data-reason]', sheet).forEach((x) => { x.className = `${x === b ? 'sel' : 'fill'} chip press`; });
    });
    setSheetMain({
      text: 'Отправить жалобу',
      onClick: async () => {
        if (!reason) { $('#cErr', sheet).textContent = 'Выберите причину'; $('#cErr', sheet).hidden = false; return; }
        try {
          await post(`/api/ads/channels/${id}/complaints`, { reason, text: $('#cText', sheet).value });
          haptic.notify('success');
          closeSheet(true);
          toast('Жалоба отправлена');
          onDone();
        } catch (e) { $('#cErr', sheet).textContent = e.message; $('#cErr', sheet).hidden = false; }
      }
    });
  });
}

/* ---------------- Deals ---------------- */

const statusTag = (st) => `<span class="tag ${AD_DEAL_STATUS[st]?.tone || 'neutral'}">${AD_DEAL_STATUS[st]?.name || st}</span>`;

export async function adDeals(root, { query, navigate }) {
  if (!store.me) return needTelegram(root, 'Мои сделки');
  const both = hasRole('vpn_owner') && (hasRole('ad_seller') || store.me.counts?.ad_channels);
  let as = query.as === 'seller' || (!hasRole('vpn_owner') && query.as !== 'buyer') ? 'seller' : 'buyer';
  root.innerHTML = `
    <div class="topbar"><h1 class="title">${both ? 'Сделки' : as === 'seller' ? 'Заявки и сделки' : 'Мои сделки'}</h1></div>
    ${both ? `<div id="dealSeg">${segHTML([{ id: 'buyer', name: 'Покупаю' }, { id: 'seller', name: 'Продаю' }], as)}</div>` : ''}
    <div class="list" id="dealList">${skeletonHTML(2)}</div>
    <p class="note center">Заявка → Согласовано → Опубликовано → Отзыв. Оплата и креатив — напрямую между вами; гарант появится позже.</p>`;
  const load = async () => {
    const { items } = await get(`/api/ads/deals?as=${as}`);
    history.replaceState(history.state, '', `#/ads/deals?as=${as}`);
    renderList($('#dealList', root), items.length ? items.map((d) => `
      <button type="button" class="card deal-row press" data-key="${d.id}" data-deal="${d.id}">
        ${channelLogo({ title: d.channel_title, photo_url: d.photo_url }, 'sm')}
        <span class="grow" style="display:flex;flex-direction:column;gap:2px;text-align:left">
          <b>${esc(d.channel_title)}</b>
          <span class="small muted">${esc(AD_FORMAT[d.format]?.name || d.format)} · ${dayLabel(d.date)} · ${rub(d.price)}${d.service_name ? ` · ${esc(d.service_name)}` : ''}</span>
        </span>
        ${statusTag(d.status)}
      </button>`).join('')
      : emptyHTML(as === 'seller' ? 'Заявок пока нет. Они придут сюда и в бот, когда владельцы VPN забронируют размещение.' : 'Сделок пока нет. Найдите канал на бирже и отправьте заявку.',
        as === 'seller' ? '' : '<button type="button" class="lgb btn press" data-nav="/ads">Открыть биржу</button>'));
  };
  if (both) bindSeg($('#dealSeg .seg', root), (v) => { as = v; load().catch(toastError); });
  // #view outlives this screen, so its listener is removed on leave.
  const ac = new AbortController();
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-deal]');
    if (b) { haptic.impact('light'); navigate(`/ads/deals/${b.dataset.deal}`); }
  }, { signal: ac.signal });
  await load();
  return () => ac.abort();
}

const STEPS = ['requested', 'agreed', 'published', 'reviewed'];

export async function adDeal(root, { params, refresh }) {
  if (!store.me) return needTelegram(root, 'Сделка');
  const id = Number(params.id);
  const d = await get(`/api/ads/deals/${id}`);
  const stepAt = STEPS.indexOf(d.status);
  const tg = (u) => `https://t.me/${u.replace(/^@/, '')}`;
  const contact = d.seller_contact
    ? `<div class="row"><span>Продавец</span><button type="button" class="link-btn press" data-tg="${esc(tg(d.seller_contact))}">${esc(d.seller_contact)} · написать</button></div>`
    : d.buyer_contact ? `<div class="row"><span>Покупатель</span>${d.buyer_contact.username
      ? `<button type="button" class="link-btn press" data-tg="${esc(tg(d.buyer_contact.username))}">@${esc(d.buyer_contact.username)} · написать</button>`
      : `<span class="v small">${esc(d.buyer_contact.first_name || '')}, без @username — напишет вам сам</span>`}</div>` : '';

  root.innerHTML = `
    <div class="topbar"><h1 class="title" style="font-size:28px">${d.role === 'seller' ? 'Заявка' : 'Сделка'}</h1>${statusTag(d.status)}</div>
    ${stepAt >= 0 ? `<div class="stack-sm" style="gap:8px"><ol class="stepper" aria-label="Шаг ${stepAt + 1} из 4">${STEPS.map((s, i) => `<li class="${i <= stepAt ? 'on' : ''}"><i></i></li>`).join('')}</ol>
      <span class="small muted">${['Дальше: продавец согласует заявку', 'Дальше: публикация поста', 'Дальше: отзыв покупателя', 'Сделка завершена'][stepAt]}</span></div>` : ''}
    ${d.status === 'declined' ? `<div class="callout warn">Продавец отклонил заявку${d.decline_reason ? `: ${esc(d.decline_reason)}` : '.'}</div>` : ''}
    ${d.status === 'failed' ? '<div class="callout warn">Покупатель отметил, что пост не вышел.</div>' : ''}
    <div class="card group">
      <button type="button" class="row press" data-nav="/ads/${d.channel.id}"><span class="row-flex">${channelLogo(d.channel, 'sm')}<b>${esc(d.channel.title)}</b></span>${icon.chev}</button>
      <div class="row"><span>Формат</span><span class="v">${esc(AD_FORMAT[d.format]?.name || d.format)}</span></div>
      <div class="row"><span>Дата</span><span class="v">${dayLabel(d.date)}</span></div>
      <div class="row"><span>Цена</span><span class="v">${rub(d.price)}</span></div>
      ${d.service ? `<div class="row"><span>VPN</span><span class="v">${esc(d.service.name)}</span></div>` : ''}
      ${d.comment ? `<div class="row" style="align-items:flex-start"><span>Комментарий</span><span class="v small">${esc(d.comment)}</span></div>` : ''}
      ${contact}
    </div>
    ${d.status === 'requested' ? `<p class="note">${d.role === 'seller' ? 'После согласования покупатель увидит ваш контакт, а вы — его.' : 'Ждём ответа продавца — уведомление придёт в бот. Контакты откроются после согласования.'}</p>` : ''}
    ${['agreed', 'published'].includes(d.status) ? '<p class="note">Креатив и оплату обсуждайте напрямую в Telegram. После даты размещения покупатель оставит отзыв — из таких отзывов складывается рейтинг канала.</p>' : ''}
    ${d.review ? `<section><p class="label">Отзыв</p><div class="card review"><span class="star">${'★'.repeat(d.review.rating)}</span>
      <span class="small muted">${[d.review.came != null ? `пришло ${kfmt(d.review.came)}` : '', d.review.payments != null ? `оплат ${d.review.payments}` : '', d.review.reach_match ? `охват: ${AD_REACH_MATCH.find((m) => m.id === d.review.reach_match)?.name.toLowerCase()}` : ''].filter(Boolean).join(' · ')}</span>
      ${d.review.text ? `<p>${esc(d.review.text)}</p>` : ''}</div></section>` : ''}
    <div class="stack-sm" id="dealActs">
      ${d.can.decide ? '<button type="button" class="fill btn block press" id="dDecline">Отклонить</button>' : ''}
      ${d.can.publish && !d.can.review ? '<button type="button" class="fill btn block press" id="dPublished">Пост вышел</button>' : ''}
      ${d.can.cancel ? '<button type="button" class="link-btn press danger" id="dCancel" style="align-self:center">Отменить сделку</button>' : ''}
    </div>`;

  $$('[data-tg]', root).forEach((b) => b.addEventListener('click', () => { haptic.impact('light'); openLink(b.dataset.tg); }));
  const run = async (path, body, okText) => {
    mainProgress(true);
    try { await post(`/api/ads/deals/${id}/${path}`, body); haptic.notify('success'); toast(okText); refresh(); } catch (e) { mainProgress(false); toastError(e); }
  };
  $('#dDecline', root)?.addEventListener('click', async () => {
    const reason = await reasonSheet('Отклонить заявку', 'Например: дата занята, тематика не подходит');
    if (reason) run('decline', { reason }, 'Заявка отклонена');
  });
  $('#dPublished', root)?.addEventListener('click', () => run('published', {}, 'Отмечено: пост вышел'));
  $('#dCancel', root)?.addEventListener('click', async () => {
    if (await confirmDialog('Отменить сделку? Вторая сторона получит уведомление.')) run('cancel', {}, 'Сделка отменена');
  });
  if (d.can.decide) setMain({ text: 'Согласовать', onClick: () => run('agree', {}, 'Согласовано — контакты открыты'), shine: true });
  else if (d.can.review) setMain({ text: 'Оставить отзыв', onClick: () => reviewSheet(id, refresh), shine: true });
}

function reviewSheet(id, onDone) {
  haptic.impact('light');
  const r = { published: true, rating: 0, reach_match: '' };
  openSheet('Как прошло размещение', `
    <div id="rvPub">${segHTML([{ id: 'yes', name: 'Пост вышел' }, { id: 'no', name: 'Не вышел' }], 'yes')}</div>
    <div class="stack" id="rvBody">
      <div class="center"><div class="rate-pick" role="radiogroup" aria-label="Оценка">${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="press" role="radio" data-rate="${n}" aria-checked="false" aria-label="${n}">★</button>`).join('')}</div></div>
      <div class="grid2">
        <label class="field"><span>Сколько пришло</span><input class="input" type="number" inputmode="numeric" min="0" id="rvCame" placeholder="подписчиков или клиентов"></label>
        <label class="field"><span>Оплат</span><input class="input" type="number" inputmode="numeric" min="0" id="rvPay" placeholder="0"></label>
      </div>
      <div><p class="label">Охват совпал с заявленным?</p><div class="chips">${AD_REACH_MATCH.map((m) => `<button type="button" class="fill chip press" data-match="${m.id}">${m.name}</button>`).join('')}</div></div>
      <label class="field"><span>Комментарий — необязательно</span><textarea class="input" id="rvText" maxlength="1000" placeholder="Что сработало, что нет"></textarea></label>
    </div>
    <div class="err" id="rvErr" hidden></div>
    <p class="note">Отзыв увидят другие владельцы VPN на странице канала. Оценивать могут только покупатели, чьё размещение состоялось.</p>`,
  (sheet) => {
    bindSeg($('#rvPub .seg', sheet), (v) => { r.published = v === 'yes'; $('#rvBody', sheet).hidden = !r.published; });
    sheet.addEventListener('click', (e) => {
      const s = e.target.closest('[data-rate]');
      const m = e.target.closest('[data-match]');
      if (s) { haptic.select(); r.rating = Number(s.dataset.rate); $$('[data-rate]', sheet).forEach((b) => b.setAttribute('aria-checked', Number(b.dataset.rate) <= r.rating)); }
      if (m) { haptic.select(); r.reach_match = m.dataset.match; $$('[data-match]', sheet).forEach((b) => { b.className = `${b === m ? 'sel' : 'fill'} chip press`; }); }
    });
    setSheetMain({
      text: 'Отправить',
      onClick: async () => {
        const err = $('#rvErr', sheet);
        if (r.published && !r.rating) { err.textContent = 'Поставьте оценку'; err.hidden = false; return; }
        const body = r.published
          ? { published: true, rating: r.rating, came: $('#rvCame', sheet).value, payments: $('#rvPay', sheet).value, reach_match: r.reach_match || null, text: $('#rvText', sheet).value }
          : { published: false };
        try {
          await post(`/api/ads/deals/${id}/review`, body);
          haptic.notify('success');
          closeSheet(true);
          toast('Спасибо! Отзыв поможет другим владельцам VPN');
          onDone();
        } catch (e) { err.textContent = e.message; err.hidden = false; }
      }
    });
  });
}

/* ---------------- Seller: my channels ---------------- */

const CH_STATUS = { active: ['На бирже', 'good'], hidden: ['Скрыт', 'neutral'], review: ['На проверке', 'warn'], blocked: ['Снят', 'bad'] };

export async function renderSellerWorkspace(box) {
  const { channels } = await get('/api/ads/my');
  const requests = channels.reduce((n, c) => n + c.requests, 0);
  box.innerHTML = channels.length ? `
    <section><p class="label">Мои каналы</p><div class="card group">${channels.map((c) => `
      <button type="button" class="row press" data-nav="/ads/my/${c.id}">
        <span class="row-flex grow">${channelLogo(c, 'sm')}<span class="grow" style="display:flex;flex-direction:column"><b>${esc(c.title)}</b>
          <span class="small muted">${c.best ? `${esc(AD_FORMAT[c.best.id].name)} — ${rub(c.best.price)}` : ''}${c.verified ? ' · подтверждён' : ' · не подтверждён'}</span></span></span>
        ${c.requests ? `<span class="tag warn">${c.requests} ${plural(c.requests, 'заявка', 'заявки', 'заявок')}</span>` : `<span class="tag ${CH_STATUS[c.status][1]}">${CH_STATUS[c.status][0]}</span>`}${icon.chev}
      </button>`).join('')}</div></section>
    <div class="card group">
      <button type="button" class="row press" data-nav="/ads/deals?as=seller"><span>Заявки и сделки</span><span class="row-flex">${requests ? `<span class="tag warn">${requests} ${plural(requests, 'новая', 'новые', 'новых')}</span>` : ''}${icon.chev}</span></button>
      <button type="button" class="row press" data-nav="/ads"><span>Биржа — цены других каналов</span>${icon.chev}</button>
    </div>
    <button type="button" class="lgb cta press" data-nav="/ads/my/new">${icon.plus} Добавить канал</button>` : `
    <div class="card empty"><span class="lgs ico">${icon.plus}</span>
      <p><b>Продавайте рекламу владельцам VPN</b><br>Укажите охват, форматы и цены — Линза посчитает CPM, а покупатели пришлют заявки. Сейчас бесплатно, сделка идёт напрямую в Telegram.</p></div>
    <button type="button" class="lgb cta press" data-nav="/ads/my/new">${icon.plus} Добавить канал</button>
    <div class="card group"><button type="button" class="row press" data-nav="/ads"><span>Посмотреть биржу</span>${icon.chev}</button></div>`;
}

export async function adMy(root) {
  if (!store.me) return needTelegram(root, 'Мои каналы');
  root.innerHTML = '<div class="topbar"><h1 class="title">Мои каналы</h1></div><div id="ws" class="stack" style="gap:22px"></div>';
  await renderSellerWorkspace($('#ws', root));
}

/* ---------------- Seller: listing editor ---------------- */

function calendarHTML(selected) {
  const start = mskToday();
  const offset = (new Date(`${start}T12:00:00Z`).getUTCDay() + 6) % 7; // Monday first
  const days = Array.from({ length: 35 }, (_, i) => addDays(start, i));
  return `<div class="cal">${['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'].map((w) => `<span class="cal-w">${w}</span>`).join('')}
    ${'<span></span>'.repeat(offset)}${days.map((d, i) => {
      const n = Number(d.slice(8));
      const month = i === 0 || n === 1 ? `<small>${dayLabel(d, 'short').split(' ')[1]}</small>` : '';
      return `<button type="button" class="cal-d press ${selected.includes(d) ? 'on' : ''}" data-day="${d}" aria-pressed="${selected.includes(d)}">${n}${month}</button>`;
    }).join('')}</div>`;
}

export async function adEditor(root, { params, navigate }) {
  if (!store.me) return needTelegram(root, 'Канал');
  const isNew = !params.id;
  const [{ config: cfg }, ch, meta] = await Promise.all([
    get('/api/ads/my').then((r) => ({ config: r.config })),
    isNew ? null : get(`/api/ads/my/${params.id}`),
    get('/api/meta').catch(() => ({ bot_username: '' }))
  ]);
  const thresholds = cfg || { cpm_good: 250, cpm_ok: 350 };
  const v = ch || { link: '', title: '', topic: '', subscribers: '', reach_24: '', reach_48: '', stats_url: '', formats: [], free_dates: [], had_vpn: false, contact: store.me.username ? `@${store.me.username}` : '' };
  const prices = Object.fromEntries((v.formats || []).map((f) => [f.id, f.price]));
  const topic = v.topic;
  let dates = [...(v.free_dates || [])];
  const bot = meta.bot_username ? `@${meta.bot_username}` : 'бота Линзы';

  root.innerHTML = `
    <div class="topbar"><h1 class="title" style="font-size:28px">${isNew ? 'Новый канал' : esc(v.title)}</h1></div>
    ${!isNew ? `
      <div class="card panel stack-sm">
        ${v.verified ? `<span class="verified-line">${icon.shield} Канал подтверждён — на карточке галочка${v.subscribers_from_tg ? ', подписчики берутся из Telegram' : ''}</span>`
          : `<b>Подтвердите, что канал ваш</b><span class="small">Добавьте ${esc(bot)} администратором канала — права не нужны. На карточке появится галочка «канал подтверждён», а перекупщики не смогут продавать ваш канал.</span>`}
        ${v.status === 'review' ? '<span class="small" style="color:var(--warn)">Канал на проверке после жалоб покупателей.</span>' : ''}
        ${v.status === 'blocked' ? `<span class="small" style="color:var(--bad)">Снят с биржи${v.block_reason ? `: ${esc(v.block_reason)}` : ''}</span>` : ''}
        ${['active', 'hidden'].includes(v.status) ? `<label class="row" style="padding:0;min-height:44px"><span>Показывать на бирже</span><input class="sw" type="checkbox" id="eVisible" ${v.status === 'active' ? 'checked' : ''}></label>` : ''}
      </div>` : '<p class="note" style="font-size:15px;margin:0">Покупатели увидят охват, форматы и цены. Контакт откроется только тому, чью заявку вы согласуете.</p>'}
    <form class="stack" id="eForm" novalidate>
      <label class="field"><span>Ссылка на канал</span><input class="input" name="link" value="${esc(v.link)}" placeholder="@channel или https://t.me/channel" autocapitalize="off" autocorrect="off" required></label>
      <label class="field"><span>Название</span><input class="input" name="title" maxlength="80" value="${esc(v.title)}" placeholder="Как в Telegram" required></label>
      <label class="field"><span>Тематика</span><select class="input" name="topic" required>
        <option value="" ${topic ? '' : 'selected'} disabled>Выберите</option>${AD_TOPICS.map((t) => `<option value="${t.id}" ${t.id === topic ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Подписчики</span><input class="input" name="subscribers" type="number" inputmode="numeric" min="1" value="${esc(v.subscribers)}" ${v.subscribers_from_tg ? 'readonly' : ''} required></label>
      <div class="grid2">
        <label class="field"><span>Охват поста за 24ч</span><input class="input" name="reach_24" type="number" inputmode="numeric" min="1" value="${esc(v.reach_24)}" required></label>
        <label class="field"><span>за 48ч</span><input class="input" name="reach_48" type="number" inputmode="numeric" min="1" value="${esc(v.reach_48)}" required></label>
      </div>
      <label class="field"><span>Статистика канала в Telemetr или TGStat</span><input class="input" name="stats_url" value="${esc(v.stats_url || '')}" placeholder="https://tgstat.ru/channel/@…" autocapitalize="off" autocorrect="off"></label>
      <p class="note" style="margin-top:-8px">Без ссылки рядом с охватом будет пометка «со слов продавца».</p>
      <div><p class="label">Форматы и цены, ₽ — оставьте пустым, если не продаёте</p>
        <div class="card group">${AD_FORMATS.map((f) => `
          <div class="row">
            <span style="display:flex;flex-direction:column;gap:2px"><b>${esc(f.name)}</b><span class="small muted" data-cpmfor="${f.id}">${esc(f.hint)}</span></span>
            <input class="input price-in" name="f_${f.id.replace('/', '_')}" data-format="${f.id}" type="number" inputmode="numeric" min="1" value="${esc(prices[f.id] ?? '')}" placeholder="—">
          </div>`).join('')}</div></div>
      <div><p class="label">Свободные даты</p>${calendarHTML(dates)}</div>
      <div class="card group"><label class="row"><span>VPN-размещения уже были</span><input class="sw" type="checkbox" name="had_vpn" ${v.had_vpn ? 'checked' : ''}></label></div>
      <label class="field"><span>Контакт для связи</span><input class="input" name="contact" value="${esc(v.contact || '')}" placeholder="@username" autocapitalize="off" autocorrect="off" required></label>
      <div class="err" id="eErr" hidden></div>
    </form>
    ${!isNew ? '<button type="button" class="link-btn press danger" id="eDelete" style="align-self:center">Удалить канал</button>' : ''}`;

  const form = $('#eForm', root);
  // Live CPM next to each price, from the reach the seller typed in.
  const paintCpm = () => {
    const r24 = Number(form.reach_24.value) || 0;
    const r48 = Number(form.reach_48.value) || 0;
    for (const f of AD_FORMATS) {
      const el = $(`[data-cpmfor="${f.id}"]`, root);
      const price = Number($(`[data-format="${f.id}"]`, root).value);
      const reach = f.reach === 24 ? r24 : f.reach === 48 ? r48 : 0;
      if (!price || !reach) { el.textContent = f.hint; el.className = 'small muted'; continue; }
      const cpm = Math.round((price / reach) * 1000);
      const light = cpm <= thresholds.cpm_good ? 'good' : cpm <= thresholds.cpm_ok ? 'ok' : 'high';
      el.innerHTML = `CPM ${rub(cpm)} · <span class="light ${CPM_LIGHT[light].tone}"><i aria-hidden="true"></i>${CPM_LIGHT[light].name}</span>`;
      el.className = 'small';
    }
  };
  form.addEventListener('input', paintCpm);
  paintCpm();
  const ac = new AbortController();
  root.addEventListener('click', (e) => {
    const day = e.target.closest('[data-day]');
    if (day) {
      haptic.select();
      const d = day.dataset.day;
      dates = dates.includes(d) ? dates.filter((x) => x !== d) : [...dates, d];
      day.classList.toggle('on', dates.includes(d));
      day.setAttribute('aria-pressed', dates.includes(d));
    }
  }, { signal: ac.signal });
  $('#eVisible', root)?.addEventListener('change', async (e) => {
    try { await post(`/api/ads/my/${params.id}/visibility`, { visible: e.target.checked }); haptic.notify('success'); toast(e.target.checked ? 'Канал снова на бирже' : 'Канал скрыт с биржи'); }
    catch (err) { e.target.checked = !e.target.checked; toastError(err); }
  });
  $('#eDelete', root)?.addEventListener('click', async () => {
    if (!(await confirmDialog('Удалить канал с биржи? Отзывы и история сделок пропадут.'))) return;
    try { await del(`/api/ads/my/${params.id}`); haptic.notify('success'); toast('Канал удалён'); navigate('/ads/my', { replace: true }); } catch (err) { toastError(err); }
  });

  const save = async () => {
    const fd = new FormData(form);
    const body = {
      link: fd.get('link'), title: fd.get('title'), topic: fd.get('topic'), subscribers: fd.get('subscribers'), reach_24: fd.get('reach_24'), reach_48: fd.get('reach_48'),
      stats_url: fd.get('stats_url'), had_vpn: fd.get('had_vpn') === 'on', contact: fd.get('contact'), free_dates: dates,
      formats: Object.fromEntries(AD_FORMATS.map((f) => [f.id, $(`[data-format="${f.id}"]`, root).value]).filter(([, p]) => p !== ''))
    };
    mainProgress(true);
    try {
      const r = isNew ? await post('/api/ads/my', body) : await put(`/api/ads/my/${params.id}`, body);
      haptic.notify('success');
      if (isNew) {
        await loadMe().catch(() => {});
        toast('Канал на бирже. Подтвердите его — добавьте бота админом канала');
        navigate(`/ads/my/${r.id}`, { replace: true });
      } else {
        toast('Сохранено');
        mainProgress(false);
      }
    } catch (e) {
      mainProgress(false);
      $('#eErr', root).textContent = e.message;
      $('#eErr', root).hidden = false;
      haptic.notify('error');
    }
  };
  setMain({ text: isNew ? 'Разместить на бирже' : 'Сохранить', onClick: save });
  return () => ac.abort();
}
