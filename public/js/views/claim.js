// «Это ваш VPN?»: the owner of a card Линза added proves it and takes the card over.
// Arrives with ?token= (a personal invitation link) or ?service= (the button on the card).
import { get, post } from '../api.js';
import { store, loadMe, ensureBotChat } from '../store.js';
import { haptic, setMain, mainProgress, openLink, copyText } from '../tg.js';
import { $, esc, icon, logoHTML, emptyHTML, errorHTML, skeletonHTML, openSheet, closeSheet, sheetIsOpen, setSheetMain, toast, toastError } from '../ui.js';

const head = (s, title) => `
  <div class="svc-head">${logoHTML(s, 'xl')}<div class="grow"><h1 class="vpn-name" style="font-size:24px">${title}</h1></div></div>`;
const KEEP = 'Данные карточки, отзывы и статистика сохранятся, а ваши правки будут публиковаться после модерации, как у всех владельцев.';

export default async function claim(root, { query, navigate }) {
  if (!store.me) {
    root.innerHTML = `<div class="topbar"><h1 class="title">Ваш VPN</h1></div>${emptyHTML('Откройте Линзу в Telegram — там можно подтвердить, что сервис ваш.')}`;
    return;
  }
  root.innerHTML = skeletonHTML(2);
  let poll = null;
  let tick = null; // the «Проверить через N с» countdown
  const stop = () => { clearInterval(poll); poll = null; clearInterval(tick); };

  const done = async (serviceId, name) => {
    stop();
    await loadMe().catch(() => {});
    haptic.notify('success');
    root.innerHTML = `
      <div class="card empty"><span class="lgs ico">${icon.check}</span>
        <p><b>Готово! «${esc(name)}» теперь ваш</b><br>Проверьте тарифы и добавьте логотип. ${KEEP}</p></div>`;
    setMain({ text: 'Открыть кабинет', onClick: () => navigate(`/owner/${serviceId}`, { replace: true }), shine: true });
  };

  /* -------- A personal invitation: one tap -------- */
  if (query.token) {
    let p;
    try { p = await get(`/api/claims/link/${encodeURIComponent(query.token)}`); } catch (e) { root.innerHTML = errorHTML(e, false); return; }
    const s = p.service;
    root.innerHTML = `
      ${head(s, `Подтвердите, что «${esc(s.name)}» — ваш VPN`)}
      <p style="margin:0">Это персональное приглашение от команды Линзы. После подтверждения карточка перейдёт в ваш кабинет.</p>
      <p class="note" style="margin:0">${KEEP}</p>`;
    setMain({
      text: 'Подтвердить', shine: true,
      onClick: async () => {
        mainProgress(true);
        try {
          const r = await post('/api/claims', { token: query.token });
          await ensureBotChat();
          if (r.status === 'approved' || r.status === 'owner') return done(s.id, s.name);
          setMain(null);
          root.innerHTML = `${head(s, 'Заявка у администратора')}<div class="callout warn">Карточку «${esc(s.name)}» уже подтвердил другой пользователь. Мы передали ваш запрос администратору — он разберётся и напишет в бот.</div>`;
        } catch (e) { mainProgress(false); toastError(e); }
      }
    });
    return stop;
  }

  /* -------- From the card -------- */
  const serviceId = Number(query.service);
  if (!serviceId) { navigate('/', { replace: true }); return; }
  let r;
  try { r = await post('/api/claims', { service_id: serviceId }); } catch (e) { root.innerHTML = errorHTML(e); return; }
  const card = await get(`/api/services/${serviceId}`).catch(() => ({ id: serviceId, name: 'VPN' }));

  if (r.status === 'owner') {
    root.innerHTML = `${head(card, `«${esc(card.name)}» — ваш VPN`)}<p style="margin:0">Карточка уже в вашем кабинете.</p>`;
    setMain({ text: 'Открыть кабинет', onClick: () => navigate(`/owner/${serviceId}`, { replace: true }) });
    return;
  }

  if (r.status === 'claimed_by_other') {
    root.innerHTML = `
      ${head(card, 'Карточку уже подтвердил владелец')}
      <p style="margin:0">Если «${esc(card.name)}» — ваш сервис, опишите ситуацию: администратор свяжется с вами и разберётся.</p>
      <label class="field"><span>Почему сервис ваш</span><textarea class="input" id="dNote" maxlength="500" placeholder="Например: я создал бота, могу показать панель или поменять описание по просьбе"></textarea></label>
      <div class="err" id="dErr" hidden></div>`;
    setMain({
      text: 'Оспорить',
      onClick: async () => {
        mainProgress(true);
        try {
          await post('/api/claims', { service_id: serviceId, dispute: true, note: $('#dNote', root).value });
          await ensureBotChat();
          setMain(null);
          root.innerHTML = `${head(card, 'Спор у администратора')}<p style="margin:0">Мы сообщили администратору. Ответ придёт в бот.</p>`;
        } catch (e) { mainProgress(false); $('#dErr', root).textContent = e.message; $('#dErr', root).hidden = false; }
      }
    });
    return;
  }

  let c = r.claim;
  ensureBotChat();

  const draw = () => {
    const s = { ...card, ...c.service, logo_url: card.logo_url };
    if (c.status === 'approved') return done(s.id, s.name);
    if (c.status === 'manual' || c.status === 'dispute') {
      stop();
      setMain(null);
      root.innerHTML = `${head(s, 'Заявка у администратора')}
        <p style="margin:0">${c.status === 'dispute' ? 'Карточку уже подтвердил другой пользователь — администратор разберётся.' : 'Администратор проверит, что сервис ваш, и свяжется с вами, если понадобится.'} Ответ придёт в бот.</p>
        ${c.note ? `<p class="note" style="margin:0">Ваш комментарий: «${esc(c.note)}»</p>` : ''}`;
      return;
    }
    if (c.status !== 'pending') {
      stop();
      setMain(null);
      root.innerHTML = `${head(s, 'Заявка закрыта')}<p style="margin:0">${c.status === 'rejected' ? `Администратор отклонил заявку${c.note ? `: ${esc(c.note)}` : '.'}` : 'Срок заявки истёк.'}</p>`;
      return;
    }
    root.innerHTML = `
      ${head(s, `Подтвердите, что «${esc(s.name)}» — ваш VPN`)}
      <p class="note" style="margin:0">${KEEP}</p>
      <section class="card panel stack-sm">
        <b>Код в профиле бота</b>
        <button type="button" class="fill btn press code-chip" id="copyCode">${esc(c.code)} <span class="small muted">скопировать</span></button>
        <ol class="steps">
          <li>Откройте @BotFather, отправьте <b>/setabouttext</b> и выберите ${s.bot ? `<b>@${esc(s.bot)}</b>` : 'бота сервиса'}.</li>
          <li>Добавьте код в текст и сохраните.</li>
          <li>Нажмите «Проверить». После подтверждения код можно удалить.</li>
        </ol>
        <button type="button" class="fill btn sm press" id="openBF" style="align-self:flex-start">Открыть @BotFather</button>
        <span class="small muted" id="checkNote"></span>
      </section>
      ${s.channel ? `
      <section class="card panel stack-sm">
        <b>Или через канал сервиса</b>
        <span>Добавьте ${c.our_bot ? `<b>@${esc(c.our_bot)}</b>` : 'бота Линзы'} администратором канала <b>@${esc(s.channel)}</b> — права не нужны. Подтвердится автоматически, этот экран обновится сам.</span>
      </section>` : ''}
      <button type="button" class="link-btn press" id="manual" style="align-self:center">Не получается — отправить администратору</button>`;

    $('#copyCode', root).addEventListener('click', async () => { haptic.select(); toast((await copyText(c.code)) ? 'Код скопирован' : c.code); });
    $('#openBF', root).addEventListener('click', () => openLink('https://t.me/BotFather'));
    $('#manual', root).addEventListener('click', () => {
      openSheet('Отправить администратору', `
        <p class="note" style="margin:0">Администратор свяжется с вами и проверит, что сервис ваш, — например, попросит поменять описание бота.</p>
        <label class="field"><span>Комментарий — необязательно</span><textarea class="input" id="mNote" maxlength="500" placeholder="Как с вами связаться, что можете показать"></textarea></label>`,
      (sheet) => setSheetMain({
        text: 'Отправить',
        onClick: async () => {
          try {
            const res = await post(`/api/claims/${c.id}/verify`, { method: 'manual', note: $('#mNote', sheet).value });
            closeSheet(true);
            c = res.claim;
            draw();
          } catch (e) { toastError(e); }
        }
      }));
    });
    paintCheck();
  };

  // «Проверить» with the 30-second pause between checks shown on the button.
  const paintCheck = () => {
    clearInterval(tick);
    const wait = () => Math.max(0, Math.ceil(((c.next_check_at || 0) - Date.now()) / 1000));
    const paint = () => {
      if (sheetIsOpen()) return; // the sheet owns the main button meanwhile
      const w = wait();
      setMain(w ? { text: `Проверить через ${w} с`, disabled: true, onClick: () => {} } : { text: 'Проверить', onClick: check });
      if (!w) clearInterval(tick);
    };
    paint();
    if (wait()) tick = setInterval(paint, 1000);
  };
  const check = async () => {
    mainProgress(true);
    try {
      const res = await post(`/api/claims/${c.id}/verify`, { method: 'code' });
      c = res.claim;
      if (res.approved) return draw();
      haptic.notify('warning');
      $('#checkNote', root).textContent = res.profile_empty
        ? 'В профиле бота пока пусто. Telegram обновляет страницу за минуту-две — проверьте ещё раз.'
        : 'Код пока не виден в профиле бота. Telegram обновляет страницу за минуту-две — проверьте ещё раз.';
      paintCheck();
    } catch (e) {
      toastError(e);
      const fresh = await get(`/api/claims/${c.id}`).catch(() => null);
      if (fresh) c = fresh.claim;
      paintCheck();
    }
  };

  draw();
  // The channel way settles on the server; look every 5 s while the screen is open (up to 10 minutes).
  if (c.status === 'pending' && c.service.channel) {
    let left = 120;
    poll = setInterval(async () => {
      if (--left <= 0) return stop();
      const fresh = await get(`/api/claims/${c.id}`).catch(() => null);
      if (fresh && fresh.claim.status !== c.status) { c = fresh.claim; draw(); }
    }, 5000);
  }
  return stop;
}
