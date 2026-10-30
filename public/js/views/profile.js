import { get, put, patch, post, del } from '../api.js';
import { store, hasRole } from '../store.js';
import { haptic, confirmDialog, requestWriteAccess, inTelegram, themePref, setThemePref } from '../tg.js';
import { $, $$, esc, fmt, icon, logoHTML, emptyHTML, stars, dateShort, dateTime, segHTML, bindSeg, toast, toastError, plural, avatarHTML } from '../ui.js';
import { MODERATION_STATUS, NOTIFY_TYPES } from '../dict.js';
import { topExplainer } from './home.js';
import { reviewSheet } from './service.js';
import { renderOwnerWorkspace } from './owner.js';

const statusTag = (st) => `<span class="tag ${st === 'approved' ? 'good' : st === 'rejected' ? 'bad' : 'warn'}">${st === 'approved' ? 'Опубликован' : MODERATION_STATUS[st] || st}</span>`;

function needTelegram(root, title) {
  root.innerHTML = `<div class="topbar"><h1 class="title">${title}</h1></div>` +
    emptyHTML(store.meError?.status === 403 ? esc(store.meError.message) : 'Профиль доступен в Telegram: откройте Линзу через бота @linza_app_bot — вход произойдёт автоматически.');
}

const row = (nav, label, value = '', extra = '') =>
  `<button type="button" class="row press" data-nav="${nav}" ${extra}><span>${label}</span><span class="row-flex"><span class="v">${value}</span>${icon.chev}</span></button>`;

export async function profile(root) {
  const me = store.me;
  if (!me) return needTelegram(root, 'Профиль');
  const name = [me.first_name, me.last_name].filter(Boolean).join(' ');
  const role = me.active_role === 'vpn_owner' ? 'vpn_owner' : 'client';

  root.innerHTML = `
    <div class="center stack-sm" style="align-items:center;padding-top:8px">
      ${avatarHTML(me, 'lg-size')}
      <h1 style="font-size:26px;font-weight:700">${esc(name)}</h1>
      ${me.username ? `<span class="muted">@${esc(me.username)}</span>` : ''}
    </div>
    <div id="roleBox">${segHTML([{ id: 'client', name: 'Клиент' }, { id: 'vpn_owner', name: 'VPN-сервис' }], role)}</div>
    <div id="workspace" class="stack" style="gap:22px"></div>`;

  const drawClient = () => {
    $('#workspace', root).innerHTML = `
      <div class="card group">
        ${row('/favorites', 'Избранное', fmt(store.favorites.size))}
        ${row('/profile/reviews', 'Мои отзывы', fmt(me.counts.reviews))}
        ${row('/profile/history', 'История переходов', fmt(me.counts.history))}
        ${row('/profile/notify', 'Уведомления', me.bot_chat_allowed ? '' : '<span class="tag warn">выключены</span>')}
      </div>
      ${hasRole('admin') ? `<div class="card group"><a class="row press" href="admin/#/admin" style="color:inherit"><span><b>Админ-панель</b></span><span class="row-flex"><span class="tag">отдельная панель</span>${icon.chev}</span></a></div>` : ''}
      <section>
        <p class="label">Оформление</p>
        <div id="themeBox">${segHTML([{ id: 'auto', name: 'Авто' }, { id: 'light', name: 'Светлая' }, { id: 'dark', name: 'Тёмная' }], themePref())}</div>
        <p class="note" style="margin-top:8px">«Авто» — как в Telegram.</p>
      </section>
      <section>
        <p class="label">Скоро в Линзе</p>
        <div class="card group">
          ${['Биржа рекламы в Telegram-каналах', 'Серверы и хостинг', 'Биржа работы: панели, боты, поддержка', 'Готовые решения и проекты'].map((t) =>
            `<div class="row disabled"><span>${t}</span><span class="tag neutral">скоро</span></div>`).join('')}
        </div>
      </section>
      <div class="card group">
        <button type="button" class="row press" id="howTop"><span>Как устроен рейтинг</span>${icon.chev}</button>
      </div>`;
    $('#howTop', root).addEventListener('click', () => topExplainer());
    bindSeg($('#themeBox .seg', root), (v) => setThemePref(v));
  };

  const draw = async (r) => {
    if (r === 'vpn_owner') await renderOwnerWorkspace($('#workspace', root));
    else drawClient();
  };

  bindSeg($('#roleBox .seg', root), async (v) => {
    patch('/api/me', { active_role: v === 'vpn_owner' && !hasRole('vpn_owner') ? 'client' : v }).catch(() => {});
    me.active_role = v;
    await draw(v);
  });
  await draw(role);
}

export async function myReviews(root) {
  if (!store.me) return needTelegram(root, 'Мои отзывы');
  root.innerHTML = '<div class="topbar"><h1 class="title">Мои отзывы</h1></div><div class="list" id="rvList"></div>';
  const draw = async () => {
    const { items } = await get('/api/me/reviews');
    const box = $('#rvList', root);
    if (!items.length) {
      box.innerHTML = emptyHTML('Вы ещё не оставляли отзывов. Отзыв можно написать после перехода в бот VPN через Линзу.', '<button type="button" class="lgb btn press" data-nav="/profile/history">История переходов</button>');
      return;
    }
    box.innerHTML = items.map((r) => `
      <article class="card review" data-id="${r.id}">
        <div class="row-flex">${logoHTML(r, 'sm')}<button type="button" class="grow tap" style="font-weight:600;text-align:left" data-open="${r.service_id}">${esc(r.name)}</button>${statusTag(r.status)}</div>
        ${stars(r.rating)}<p>${esc(r.text)}</p>
        ${r.status === 'rejected' && r.reject_reason ? `<p class="small" style="color:var(--bad)">Причина: ${esc(r.reject_reason)}</p>` : ''}
        <div class="row-flex between"><span class="small muted">${dateShort(r.updated_at)}</span>
          <span class="row-flex"><button type="button" class="link-btn" data-edit="${r.id}">Изменить</button><button type="button" class="link-btn danger" data-del="${r.id}">Удалить</button></span></div>
      </article>`).join('');
    $$('[data-edit]', box).forEach((b) => b.addEventListener('click', () => {
      const r = items.find((x) => x.id === Number(b.dataset.edit));
      reviewSheet({ id: r.service_id, name: r.name }, r, () => draw());
    }));
    $$('[data-del]', box).forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmDialog('Удалить отзыв? Это действие нельзя отменить.'))) return;
      try { await del(`/api/me/reviews/${b.dataset.del}`); haptic.notify('success'); toast('Отзыв удалён'); draw(); } catch (e) { toastError(e); }
    }));
  };
  await draw();
}

export async function history(root) {
  if (!store.me) return needTelegram(root, 'История');
  const { items } = await get('/api/me/history');
  root.innerHTML = `<div class="topbar"><h1 class="title">История переходов</h1></div>
    ${items.length ? `<div class="card group">${items.map((h) => `
      <div class="row">
        <button type="button" class="row-flex grow tap" style="text-align:left" data-open="${h.service_id}">${logoHTML(h, 'sm')}
          <span class="grow" style="display:flex;flex-direction:column"><span style="font-weight:600">${esc(h.name)}</span>
          <span class="small muted">${dateTime(h.last_at)}${h.times > 1 ? ` · ${h.times} ${plural(h.times, 'переход', 'перехода', 'переходов')}` : ''}</span></span></button>
        ${h.review_status ? statusTag(h.review_status) : `<button type="button" class="lgb btn sm press" data-review="${h.service_id}" data-name="${esc(h.name)}">Отзыв</button>`}
      </div>`).join('')}</div>
      <p class="note">Переходы в бот через Линзу дают право оставить отзыв и учитываются в топе месяца.</p>`
    : emptyHTML('Здесь будут VPN, в чьи боты вы переходили из Линзы.', '<button type="button" class="lgb btn press" data-nav="/catalog">Открыть каталог</button>')}`;
  $$('[data-review]', root).forEach((b) => b.addEventListener('click', () =>
    reviewSheet({ id: Number(b.dataset.review), name: b.dataset.name }, null, () => { b.outerHTML = statusTag('pending'); })));
}

export async function notifySettings(root) {
  if (!store.me) return needTelegram(root, 'Уведомления');
  const me = store.me;
  root.innerHTML = `<div class="topbar"><h1 class="title">Уведомления</h1></div>
    <div id="botAccess"></div>
    <div class="card group">${NOTIFY_TYPES.map((t) => `
      <label class="row"><span style="display:flex;flex-direction:column"><span>${t.name}</span><span class="small muted">${t.hint}</span></span>
        <input class="sw" type="checkbox" data-type="${t.id}" ${me.notify[t.id] ? 'checked' : ''}></label>`).join('')}</div>
    <p class="note">Уведомления присылает бот Линзы. Статусы модерации для владельцев VPN приходят всегда.</p>`;

  const drawAccess = () => {
    $('#botAccess', root).innerHTML = me.bot_chat_allowed ? '' : `
      <div class="callout stack-sm"><b>Бот пока не может вам писать</b><span>Разрешите сообщения от @linza_app_bot, чтобы получать уведомления.</span>
        <button type="button" class="lgb btn press" id="allowBot" style="align-self:flex-start">Разрешить</button></div>`;
    $('#allowBot', root)?.addEventListener('click', async () => {
      if (!inTelegram) { toast('Откройте Линзу в Telegram'); return; }
      if (await requestWriteAccess()) {
        await post('/api/me/bot-access').catch(() => {});
        me.bot_chat_allowed = true;
        haptic.notify('success');
        toast('Готово — уведомления включены');
        drawAccess();
      }
    });
  };
  drawAccess();
  $$('[data-type]', root).forEach((c) => c.addEventListener('change', async () => {
    haptic.select();
    try {
      const { notify } = await put('/api/me/notify', { [c.dataset.type]: c.checked });
      me.notify = notify;
      if (c.checked && !me.bot_chat_allowed) $('#allowBot', root)?.click();
    } catch (e) { c.checked = !c.checked; toastError(e); }
  }));
}
