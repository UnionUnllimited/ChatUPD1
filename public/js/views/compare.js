import { get } from '../api.js';
import { store, removeFromCompare, COMPARE_MAX } from '../store.js';
import { haptic } from '../tg.js';
import { $, esc, rub, fmt, icon, logoHTML, emptyHTML, ratingStr, dateShort, paymentsText, monthsWord } from '../ui.js';
import { PROTOCOL, COUNTRY, PLATFORM, TARIFF_MONTHS, MARKET_LABELS } from '../dict.js';
import { goToBot } from './service.js';

const list = (arr, dict) => arr.map((v) => dict[v]?.name || v).sort().join(', ');

// [label, value getter, formatter, best: 'min' | 'max' | undefined]
const ROWS = [
  ['Цена от, /мес', (s) => s.min_monthly, rub, 'min'],
  ...TARIFF_MONTHS.map((m) => [`Тариф ${monthsWord(m)}`, (s) => s.tariffs[m] ?? null, (v) => (v == null ? '—' : rub(v)), 'min']),
  ['Относительно рынка', (s) => s.market, (v) => (v ? MARKET_LABELS[v] : '—')],
  ['Рейтинг', (s) => s.rating, ratingStr, 'max'],
  ['Отзывы', (s) => s.reviews, fmt, 'max'],
  ['Ручная проверка', (s) => s.verified_at, (v) => (v ? `✓ ${dateShort(v)}` : 'Не проверялся')],
  ['Пробный период', (s) => (s.trial ? s.trial_days || 'есть' : null), (v) => (v == null ? 'Нет' : typeof v === 'number' ? `${v} дн.` : 'Есть')],
  ['Протоколы', (s) => list(s.protocols, PROTOCOL), (v) => v],
  ['Стран', (s) => s.countries.length, (v) => v, 'max'],
  ['Страны', (s) => s.countries.map((c) => COUNTRY[c]?.flag).join(' '), (v) => v],
  ['Устройства', (s) => s.devices, (v) => `до ${v}`, 'max'],
  ['Платформы', (s) => list(s.platforms, PLATFORM), (v) => v],
  ['Оплата', (s) => paymentsText([...s.payments].sort()), (v) => v],
  ['Обход белых списков', (s) => s.whitelist_bypass, (v) => (v ? 'Да' : 'Нет')],
  ['Акция', (s) => (s.promo ? s.promo.title : null), (v) => v || '—']
];

export default async function compare(root) {
  let onlyDiff = false;
  const draw = async () => {
    const ids = store.compare;
    if (!ids.length) {
      root.innerHTML = `<div class="topbar"><h1 class="title">Сравнение</h1></div>` + emptyHTML(
        `Добавьте до ${COMPARE_MAX} VPN кнопкой «Сравнить» в каталоге — здесь появится таблица со всеми параметрами, различия будут подсвечены.`,
        '<button type="button" class="lgb btn press" data-nav="/catalog">Открыть каталог</button>', icon.compare(false));
      return;
    }
    const { items } = await get(`/api/compare?ids=${ids.join(',')}`);
    // Drop cards that were hidden or removed since they were added.
    const missing = ids.filter((id) => !items.some((s) => s.id === id));
    missing.forEach(removeFromCompare);

    const rows = ROWS.map(([label, getter, f, best]) => {
      const vals = items.map(getter);
      const differs = items.length > 1 && new Set(vals.map((v) => JSON.stringify(v))).size > 1;
      const nums = vals.filter((v) => typeof v === 'number');
      const target = best && differs && nums.length ? (best === 'min' ? Math.min(...nums) : Math.max(...nums)) : null;
      return { label, vals, f, differs, target };
    });
    const shown = onlyDiff ? rows.filter((r) => r.differs) : rows;

    root.innerHTML = `
      <div class="topbar"><h1 class="title">Сравнение</h1><span class="muted small">${items.length} из ${COMPARE_MAX}</span></div>
      ${items.length < 2 ? `<p class="callout">Добавьте ещё ${items.length ? 'хотя бы один VPN' : 'VPN'}, чтобы увидеть различия. <a href="#/catalog" data-nav="/catalog">В каталог</a></p>` : ''}
      <label class="card group"><span class="row"><span>Только различия</span><input class="sw" type="checkbox" id="onlyDiff" ${onlyDiff ? 'checked' : ''}></span></label>
      <div class="card cmp-wrap">
        <table class="cmp">
          <thead><tr><th scope="col"><span class="sr">Параметр</span></th>${items.map((s) => `
            <th scope="col">
              <div class="stack-sm">
                <div class="row-flex between">${logoHTML(s, 'sm')}<button type="button" class="fill circle press" data-remove="${s.id}" aria-label="Убрать ${esc(s.name)}">${icon.x}</button></div>
                <button type="button" class="tap" style="text-align:left;font-weight:700" data-open="${s.id}">${esc(s.name)}</button>
              </div>
            </th>`).join('')}</tr></thead>
          <tbody>
            ${shown.map((r) => `<tr class="${r.differs ? 'diff' : ''}"><th scope="row">${esc(r.label)}</th>${r.vals.map((v) =>
              `<td class="${r.target !== null && v === r.target ? 'best' : ''}">${esc(r.f(v))}</td>`).join('')}</tr>`).join('')}
            <tr><th scope="row"></th>${items.map((s) => `<td><button type="button" class="lgb btn sm press" data-go="${s.id}">${icon.bot} В бот</button></td>`).join('')}</tr>
          </tbody>
        </table>
      </div>
      <p class="note">Подсвечены строки, где значения различаются; лучшие цифры выделены зелёным.</p>`;

    $('#onlyDiff', root).addEventListener('change', (e) => { haptic.select(); onlyDiff = e.target.checked; draw(); });
    root.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      haptic.impact('light');
      removeFromCompare(Number(b.dataset.remove));
      draw();
    }));
    root.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => goToBot(items.find((s) => s.id === Number(b.dataset.go)), 'compare')));
  };
  await draw();
}
