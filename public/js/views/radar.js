// «Радар сбоев»: client signals by network — is it me or everyone, and which VPN works here now.
import { get } from '../api.js';
import { haptic } from '../tg.js';
import { $, $$, esc, rub, plural, icon, logoHTML, healthTag, errorHTML, skeletonHTML } from '../ui.js';
import { NETWORK, RADAR_LEVEL } from '../dict.js';

const NET_KEY = 'linza.radar_net';
const vpnWord = (n) => `${n} VPN`;
const timeMsk = (ts) => new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });

// «Сейчас у МТС сообщают о сбоях у 3 VPN, у Билайна всё спокойно».
export function radarHeadline(networks) {
  const bad = networks.filter((n) => n.level !== 'calm').sort((a, b) => b.count - a.count);
  if (!bad.length) return 'Сейчас всё спокойно — о сбоях не сообщают';
  const calm = networks.find((n) => n.level === 'calm' && n.id !== 'wifi') || networks.find((n) => n.level === 'calm');
  const [first, second] = bad;
  const parts = [`${NETWORK[first.id].at} сообщают о сбоях у ${vpnWord(first.count)}`];
  if (second) parts.push(`${NETWORK[second.id].at} — у ${second.count}`);
  return `Сейчас ${parts.join(', ')}${calm ? `, ${NETWORK[calm.id].at} всё спокойно` : ''}`;
}

const dot = (level) => `<i class="rdot ${RADAR_LEVEL[level].tone}" aria-hidden="true"></i>`;

// Home screen block: one line and a dot per network.
export function radarMiniHTML(summary) {
  if (!summary) return '';
  return `
    <button type="button" class="card radar-mini press" data-nav="/radar">
      <span class="row-flex between"><b>Радар сбоев</b><span class="row-flex small muted">по сигналам клиентов${icon.chev}</span></span>
      <span class="radar-line">${esc(radarHeadline(summary.networks))}</span>
      <span class="radar-nets">${summary.networks.map((n) => `<span>${dot(n.level)}${esc(n.name)}${n.count ? ` · ${n.count}` : ''}</span>`).join('')}</span>
    </button>`;
}

// Hourly bars with a tap readout, like the owner charts.
function trendHTML(trend, netName) {
  const W = 320, H = 120, top = 14, bottom = 20;
  const n = trend.length;
  const peak = Math.max(...trend.map((t) => t.down));
  const max = Math.max(2, peak);
  const slot = W / n, bw = Math.min(18, slot - 4);
  const y = (v) => H - bottom - (v / max) * (H - top - bottom);
  const bars = trend.map((t, i) => {
    if (!t.down) return '';
    const x = i * slot + (slot - bw) / 2, yy = y(t.down), h = H - bottom - yy, r = Math.min(4, bw / 2, h);
    return `<path class="b" data-i="${i}" d="M${x},${H - bottom}V${yy + r}Q${x},${yy} ${x + r},${yy}H${x + bw - r}Q${x + bw},${yy} ${x + bw},${yy + r}V${H - bottom}Z"/>`;
  }).join('');
  const total = trend.reduce((s, t) => s + t.down, 0);
  return `
    <div class="readout" aria-live="polite">${total ? `${total} ${plural(total, 'сообщение', 'сообщения', 'сообщений')} о сбоях${netName ? ` ${netName}` : ''} за ${n} ч` : `За ${n} ч сообщений о сбоях${netName ? ` ${netName}` : ''} не было`}</div>
    <svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Сообщения о сбоях по часам, максимум ${peak}">
      <line class="grid" x1="0" x2="${W}" y1="${H - bottom}" y2="${H - bottom}"/>
      ${bars}
      ${trend.map((_, i) => `<rect class="hit" data-i="${i}" x="${i * slot}" y="0" width="${slot}" height="${H}"/>`).join('')}
      <text x="0" y="${H - 5}">${timeMsk(trend[0].at)}</text><text x="${W}" y="${H - 5}" text-anchor="end">сейчас</text>
    </svg>`;
}

function bindTrend(box, trend, netName) {
  const svg = $('svg', box);
  svg?.addEventListener('click', (e) => {
    const hit = e.target.closest('.hit');
    if (!hit) return;
    haptic.select();
    const i = Number(hit.dataset.i);
    const t = trend[i];
    svg.classList.add('picked');
    $$('.b', svg).forEach((b) => b.classList.toggle('on', Number(b.dataset.i) === i));
    $('.readout', box).innerHTML = `<b>${timeMsk(t.at)}–${timeMsk(t.at + 3600_000)}</b> · ${t.down} ${plural(t.down, 'сообщение', 'сообщения', 'сообщений')} о сбоях${netName ? ` ${netName}` : ''}`;
  });
}

const row = (s, right, nav = true) => `
  <button type="button" class="row press" ${nav ? `data-open="${s.id}"` : ''}>
    <span class="row-flex grow">${logoHTML(s, 'sm')}<span class="grow" style="display:flex;flex-direction:column;gap:2px;text-align:left"><b>${esc(s.name)}</b>${right}</span></span>${icon.chev}
  </button>`;

export default async function radar(root) {
  root.innerHTML = `<div class="topbar"><h1 class="title">Радар сбоев</h1></div>${skeletonHTML(3)}`;
  let picked = null;
  try { picked = localStorage.getItem(NET_KEY); } catch {}
  let data;

  const draw = () => {
    const r = data;
    const summary = r.networks.map((n) => ({ id: n.id, name: n.name, level: n.level, count: n.reported.length }));
    const operator = r.networks.filter((n) => n.level === 'operator');
    // Default to the network with the most trouble; a network the person picked before wins.
    const worst = [...r.networks].sort((a, b) => b.reported.length - a.reported.length || b.down - a.down)[0];
    const net = r.networks.find((n) => n.id === picked) || worst;
    const trendRows = r.trend.map((t, i) => ({ at: t.at, down: net.trend[i] ?? 0 }));
    root.innerHTML = `
      <div class="topbar"><h1 class="title">Радар сбоев</h1></div>
      <p class="muted" style="margin:-10px 0 0">${operator.length ? '' : `${esc(radarHeadline(summary))}. `}Сигналы клиентов за ${r.window_min >= 60 ? `${r.window_min / 60} ч` : `${r.window_min} мин`} · обновлено в ${timeMsk(r.updated_at)}</p>
      ${operator.length ? `<div class="callout warn">Похоже, проблема ${esc(NETWORK[operator[0].id].at)}: о сбоях сообщают у ${vpnWord(operator[0].reported.length)} сразу — скорее всего, дело в операторе, а не в конкретном VPN.</div>` : ''}

      <div class="card group" role="tablist" aria-label="Сеть">${r.networks.map((n) => `
        <button type="button" class="row press radar-row" role="tab" data-net="${n.id}" aria-selected="${n.id === net.id}">
          <span class="row-flex">${dot(n.level)}<b>${esc(n.name)}</b></span>
          <span class="small ${n.level === 'calm' ? 'muted' : ''}">${n.reported.length ? `сбои у ${vpnWord(n.reported.length)}` : 'спокойно'}</span>
        </button>`).join('')}</div>

      <section>
        <p class="label">${esc(net.name)}: сообщают о сбоях</p>
        ${net.reported.length ? `<div class="card group">${net.reported.map((s) => row(s,
          `<span class="small muted">не работает у ${s.down}${s.up ? ` · работает у ${s.up}` : ''}</span>`)).join('')}</div>`
          : `<p class="note" style="margin:0">${esc(NETWORK[net.id].at[0].toUpperCase() + NETWORK[net.id].at.slice(1))} о сбоях не сообщают.</p>`}
      </section>

      <section>
        <p class="label">${esc(net.name)}: работает у клиентов</p>
        ${net.working.length ? `<div class="card group">${net.working.slice(0, 3).map((s) => `
          <div class="row" style="gap:10px">
            <button type="button" class="row-flex grow press tap" data-open="${s.id}" style="text-align:left">${logoHTML(s, 'sm')}
              <span class="grow" style="display:flex;flex-direction:column;gap:2px"><b>${esc(s.name)}</b><span class="small muted">работает у ${s.up} за сутки${s.min_monthly ? ` · от ${rub(s.min_monthly)}/мес` : ''}</span></span></button>
            ${s.bot_url ? `<button type="button" class="go-bot btn sm press" data-go="${s.id}" data-url="${esc(s.bot_url)}" data-source="radar">${icon.bot} В бот</button>` : ''}
          </div>`).join('')}</div>`
          : '<p class="note" style="margin:0">Пока никто не отметил, что VPN работает в этой сети.</p>'}
      </section>

      <section class="card panel stack-sm chart-box" id="trendBox">${trendHTML(trendRows, NETWORK[net.id].at)}</section>

      ${r.incidents.length ? `<section><p class="label">Статусы VPN сейчас</p><div class="card group">${r.incidents.map((s) => row(s,
        `<span class="row-flex small" style="gap:8px">${healthTag(s.status)}${s.networks.length ? `<span class="muted">${s.networks.map((id) => NETWORK[id].name).join(', ')}</span>` : ''}</span>`)).join('')}</div></section>` : ''}

      <p class="note center">Радар строится по отметкам «Работает у меня» и «Не работает у меня» на карточках VPN. Отметьтесь и вы — это помогает другим.</p>`;
    bindTrend($('#trendBox', root), trendRows, NETWORK[net.id].at);
  };

  const load = async () => {
    data = await get('/api/radar');
    draw();
  };
  // #view outlives this screen, so its listener goes away on leave.
  const ac = new AbortController();
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-net]');
    if (!b || !data) return;
    haptic.select();
    picked = b.dataset.net;
    try { localStorage.setItem(NET_KEY, picked); } catch {}
    draw();
  }, { signal: ac.signal });

  try { await load(); } catch (e) { root.innerHTML = errorHTML(e); }
  // Live while open: an outage unfolds over minutes.
  const timer = setInterval(() => { load().catch(() => {}); }, 60_000);
  return () => { clearInterval(timer); ac.abort(); };
}
