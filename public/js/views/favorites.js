import { get } from '../api.js';
import { store, subscribe, trackImpressions } from '../store.js';
import { $, vpnCardHTML, emptyHTML, renderList, icon } from '../ui.js';

export default async function favorites(root) {
  root.innerHTML = `<div class="topbar"><h1 class="title">Избранное</h1><span class="muted small" id="favCount"></span></div><div class="list" id="favList"></div>`;
  if (!store.me) {
    $('#favList', root).innerHTML = emptyHTML('Откройте Линзу в Telegram, чтобы сохранять VPN и получать уведомления о скидках.', '', icon.heart(false));
    return;
  }
  let items = (await get('/api/me/favorites')).items;
  const draw = () => {
    const shown = items.filter((s) => store.favorites.has(s.id));
    $('#favCount', root).textContent = shown.length ? String(shown.length) : '';
    renderList($('#favList', root), shown.length
      ? shown.map((s) => vpnCardHTML(s, { fav: true, cmp: store.compare.includes(s.id) })).join('') +
        '<p class="note center">Сообщим в боте, если у этих VPN снизится цена или появится акция. Настроить — в профиле.</p>'
      : emptyHTML('Здесь появятся VPN, отмеченные сердечком. Мы напомним о снижении цены и новых акциях.', '<button type="button" class="lgb btn press" data-nav="/catalog">Перейти в каталог</button>', icon.heart(false)));
    trackImpressions(root);
  };
  draw();
  // Un-hearting removes the card right away.
  return subscribe((what) => { if (what === 'favorites') draw(); });
}
