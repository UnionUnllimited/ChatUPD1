// «Подобрать VPN»: the answers become requirements, the matches are ranked by a simple score
// built from the same honest signals as the catalog (reviews, clients, status), never by payment.
import { PICK_QUESTIONS, PAYMENT } from '../../public/js/dict.js';
import { toListItem } from './catalog.js';
import { badRequest } from './http.js';

const plural = (n, a, b, c) => { const m10 = n % 10, m100 = n % 100; if (m10 === 1 && m100 !== 11) return a; if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return b; return c; };

export function parseAnswers(query) {
  const a = {};
  for (const q of PICK_QUESTIONS) {
    if (!q.options.some((o) => o.id === query[q.key])) throw badRequest('Ответьте на все вопросы');
    a[q.key] = query[q.key];
  }
  return a;
}

const REQUIREMENTS = {
  device: (s, a) => a.device === 'any' || s.platforms.includes(a.device),
  devices: (s, a) => Number(a.devices) <= 1 || (s.devices ?? 0) >= Number(a.devices),
  whitelist: (s, a) => a.whitelist !== 'yes' || s.whitelist_bypass,
  payment: (s, a) => a.payment === 'any' || s.payments.includes(a.payment),
  budget: (s, a) => a.budget === 'any' || (s.min_monthly != null && s.min_monthly <= Number(a.budget))
};
// When nothing fits, the softer wishes give way first; device, white lists and payment never do.
const RELAXABLE = ['budget', 'devices'];

const optionName = (key, id) => PICK_QUESTIONS.find((q) => q.key === key).options.find((o) => o.id === id).name;

// What every result has in common: the client's own conditions, shown once above the list.
function conditions(a, relaxed) {
  const out = [];
  if (a.device !== 'any') out.push(optionName('device', a.device));
  if (Number(a.devices) > 1 && !relaxed.includes('devices')) out.push(`от ${a.devices} устройств`);
  if (a.whitelist === 'yes') out.push('обход белых списков');
  if (a.payment !== 'any') out.push(`оплата: ${PAYMENT[a.payment].name}`);
  if (a.budget !== 'any' && !relaxed.includes('budget')) out.push(`до ${a.budget} ₽/мес`);
  return out;
}

// What sets one result apart from the others.
function extras(s, a) {
  const out = [];
  if (Number(a.devices) > 1 && s.devices) out.push(`до ${s.devices} ${plural(s.devices, 'устройства', 'устройств', 'устройств')}`);
  if (a.whitelist === 'unknown' && s.whitelist_bypass) out.push('обход белых списков');
  if (s.trial) out.push(s.trial_days ? `пробный период ${s.trial_days} ${plural(s.trial_days, 'день', 'дня', 'дней')}` : 'пробный период');
  if (s.promo) out.push(s.promo.discount_percent ? `скидка −${s.promo.discount_percent}%` : 'акция');
  if (s.market === 'below') out.push('ниже рынка');
  return out.slice(0, 3);
}

export function pickServices(items, a, limit = 3) {
  // A service with a mass outage is never recommended.
  const pool = items.filter((s) => s.health !== 'outage');
  const relaxed = [];
  const fits = (s) => Object.entries(REQUIREMENTS).every(([k, ok]) => relaxed.includes(k) || ok(s, a));
  let matched = pool.filter(fits);
  for (const k of RELAXABLE) {
    if (matched.length) break;
    relaxed.push(k);
    matched = pool.filter(fits);
  }
  const maxPop = Math.max(1, ...matched.map((s) => s.popularity));
  const score = (s) => (s.rating_rank / 5) * 0.5 + (s.popularity / maxPop) * 0.25
    + (s.health === 'issues' ? -0.5 : 0) // reported problems right now outweigh a better rating
    + (a.whitelist === 'unknown' && s.whitelist_bypass ? 0.08 : 0)
    + (s.trial ? 0.05 : 0) + (s.market === 'below' ? 0.05 : 0) + (s.promo ? 0.04 : 0) + (s.top ? 0.04 : 0);
  const ranked = matched.map((s) => ({ s, v: score(s) })).sort((x, y) => y.v - x.v).map((x) => x.s);

  // The same requirements as catalog filters, for «Все подходящие».
  const q = new URLSearchParams();
  if (a.device !== 'any') q.set('platforms', a.device);
  if (Number(a.devices) > 1 && !relaxed.includes('devices')) q.set('devices', a.devices);
  if (a.whitelist === 'yes') q.set('whitelist', '1');
  if (a.payment !== 'any') q.set('payments', a.payment);
  if (a.budget !== 'any' && !relaxed.includes('budget')) q.set('price_max', a.budget);

  return {
    items: ranked.slice(0, limit).map((s) => ({ ...toListItem(s), why: extras(s, a) })),
    total: ranked.length,
    conditions: conditions(a, relaxed),
    relaxed,
    catalog: q.toString()
  };
}
