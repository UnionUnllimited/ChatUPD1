// «Подобрать VPN»: a few one-tap questions, then the best matches with the reasons why.
import { get } from '../api.js';
import { store, trackImpressions } from '../store.js';
import { haptic } from '../tg.js';
import { $, $$, esc, plural, vpnCardHTML, emptyHTML, skeletonHTML, errorHTML, setRouteBack, currentRouteBack } from '../ui.js';
import { PICK_QUESTIONS } from '../dict.js';

const RELAXED = { budget: 'дороже выбранного бюджета', devices: 'на меньшее число устройств' };

export default async function pick(root) {
  const answers = {};
  const exit = currentRouteBack();
  let step = 0;
  // Back steps through the questions before leaving the screen.
  setRouteBack(() => {
    if (step > 0) { haptic.impact('light'); ask(step - 1); } else exit?.();
  });

  function ask(i) {
    step = i;
    const q = PICK_QUESTIONS[i];
    root.innerHTML = `
      <div class="pick">
        <div class="pick-steps" role="progressbar" aria-valuemin="1" aria-valuemax="${PICK_QUESTIONS.length}" aria-valuenow="${i + 1}" aria-label="Вопрос ${i + 1} из ${PICK_QUESTIONS.length}">
          ${PICK_QUESTIONS.map((_, k) => `<i class="${k <= i ? 'on' : ''}"></i>`).join('')}</div>
        <h1 class="title">${esc(q.title)}</h1>
        ${q.hint ? `<p class="muted" style="margin:-6px 0 0">${esc(q.hint)}</p>` : ''}
        <div class="pick-opts">${q.options.map((o) => `
          <button type="button" class="${answers[q.key] === o.id ? 'sel' : 'fill'} pick-opt press" data-opt="${esc(o.id)}">${esc(o.name)}</button>`).join('')}</div>
      </div>`;
    $$('[data-opt]', root).forEach((b) => b.addEventListener('click', () => {
      haptic.select();
      answers[q.key] = b.dataset.opt;
      if (i + 1 < PICK_QUESTIONS.length) ask(i + 1);
      else results();
    }));
    window.scrollTo(0, 0);
  }

  async function results() {
    step = PICK_QUESTIONS.length; // Back returns to the last question
    root.innerHTML = `<h1 class="title">Вам подойдут</h1>${skeletonHTML(3)}`;
    window.scrollTo(0, 0);
    let d;
    try {
      d = await get(`/api/pick?${new URLSearchParams(answers)}`);
    } catch (e) {
      root.innerHTML = errorHTML(e);
      return;
    }
    haptic.notify(d.items.length ? 'success' : 'warning');
    const note = d.relaxed.length ? `Точно под все условия ничего нет — показываем ближайшие: ${d.relaxed.map((k) => RELAXED[k]).join(', ')}.` : '';
    root.innerHTML = d.items.length ? `
      <h1 class="title">${d.items.length === 1 ? 'Вам подойдёт' : 'Вам подойдут'}</h1>
      ${d.conditions.length ? `<p class="muted" style="margin:-6px 0 0">${esc(d.conditions.join(' · '))}</p>` : ''}
      ${note ? `<p class="muted" style="margin:0">${note}</p>` : ''}
      <div class="list">${d.items.map((s) => vpnCardHTML(s, { fav: store.favorites.has(s.id), cmp: store.compare.includes(s.id), why: s.why.join(' · ') })).join('')}</div>
      ${d.total > d.items.length ? `<button type="button" class="fill btn block press" data-nav="/catalog?${esc(d.catalog)}">Все подходящие — ${d.total} ${plural(d.total, 'VPN', 'VPN', 'VPN')}</button>` : ''}
      <button type="button" class="link-btn press" id="again" style="align-self:center">Пройти заново</button>`
      : emptyHTML('Под эти условия в каталоге пока нет VPN. Попробуйте ответить по-другому — например, выбрать «Не важно» для оплаты.',
        '<button type="button" class="lgb btn press" id="again">Изменить ответы</button>');
    $('#again', root).addEventListener('click', () => { haptic.impact('light'); ask(0); });
    trackImpressions(root);
  }

  ask(0);
}
