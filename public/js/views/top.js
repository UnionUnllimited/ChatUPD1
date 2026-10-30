import { get } from '../api.js';
import { trackImpressions } from '../store.js';
import { $, esc, icon, emptyHTML } from '../ui.js';
import { monthLabel } from '../dict.js';
import { topRowHTML, topExplainer } from './home.js';

export async function topArchive(root, { params, navigate }) {
  const { current, archive } = await get('/api/top');
  if (!current) {
    root.innerHTML = '<div class="topbar"><h1 class="title">Топ-10</h1></div>' + emptyHTML('Первый рейтинг появится 1-го числа по итогам месяца.');
    return;
  }
  const period = params.period || current.period;
  const top = period === current.period ? current : await get(`/api/top/${period}`);
  root.innerHTML = `
    <div class="topbar"><h1 class="title">Топ-10</h1><button type="button" class="link-btn" id="how">${icon.info} Как считается</button></div>
    <div class="chips scroll">${archive.map((a) => `<button type="button" class="${a.period === period ? 'sel' : 'fill'} chip press" data-period="${a.period}">${esc(monthLabel(a.period))}</button>`).join('')}</div>
    <section>
      <div class="sec-head"><h2>${esc(monthLabel(period))}</h2></div>
      ${top.entries.length ? `<div class="card group">${top.entries.map(topRowHTML).join('')}</div>` : '<p class="note">Сервисы из этого рейтинга больше не размещаются в каталоге.</p>'}
    </section>
    <p class="note">Победители получают бейдж «Топ-10 за ${esc(monthLabel(period).split(' ')[0])}». Рейтинг строится только по отзывам, переходам и ручным проверкам.</p>`;
  $('#how', root).addEventListener('click', () => topExplainer(top.weights));
  root.querySelectorAll('[data-period]').forEach((b) => b.addEventListener('click', () => navigate(`/top/${b.dataset.period}`, { replace: true })));
  trackImpressions(root);
}
