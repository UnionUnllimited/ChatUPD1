// Bulk import of cards Линза adds itself (JSON or CSV), so a dozen services go in at once.
// Columns may be Russian or English; list values may be ids («nl») or names («Нидерланды»).
// Every row is validated like a hand-made card; bad rows are reported, good ones created.
import { PROTOCOLS, COUNTRIES, PLATFORMS, PAYMENTS } from '../../public/js/dict.js';
import { validateCard } from './validate.js';
import { createService } from './adminops.js';
import { badRequest } from './http.js';

const ALIASES = {
  name: ['name', 'название', 'сервис'],
  bot: ['bot', 'bot_url', 'бот'],
  channel: ['channel', 'channel_url', 'канал'],
  description: ['description', 'описание'],
  contact: ['contact', 'support_contact', 'контакт', 'поддержка'],
  price_1: ['price_1', '1', 'тариф_1', 'цена_1', '1_мес', '1м'],
  price_3: ['price_3', '3', 'тариф_3', 'цена_3', '3_мес', '3м'],
  price_6: ['price_6', '6', 'тариф_6', 'цена_6', '6_мес', '6м'],
  price_12: ['price_12', '12', 'тариф_12', 'цена_12', '12_мес', '12м'],
  protocols: ['protocols', 'протоколы'],
  countries: ['countries', 'страны'],
  devices: ['devices', 'устройства'],
  trial: ['trial', 'trial_days', 'триал', 'пробный_период'],
  payments: ['payments', 'оплата', 'способы_оплаты'],
  platforms: ['platforms', 'платформы'],
  whitelist: ['whitelist', 'whitelist_bypass', 'белые_списки', 'обход_белых_списков'],
  checked_at: ['checked_at', 'data_checked_at', 'дата_сверки', 'сверка']
};
const KEY = new Map(Object.entries(ALIASES).flatMap(([k, list]) => list.map((a) => [a, k])));
const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/ё/g, 'е').replace(/[\s.\-]+/g, '_');

const lookup = (list, extra = {}) => {
  const m = new Map();
  for (const x of list) { m.set(norm(x.id), x.id); m.set(norm(x.name), x.id); }
  for (const [a, id] of Object.entries(extra)) m.set(norm(a), id);
  return m;
};
const DICTS = {
  protocols: [lookup(PROTOCOLS, { reality: 'vless_reality', ss: 'shadowsocks', hysteria: 'hysteria2', wg: 'wireguard', awg: 'amneziawg' }), 'Протоколы'],
  countries: [lookup(COUNTRIES, { сша: 'us', usa: 'us', англия: 'gb', великобритания: 'gb', uk: 'gb' }), 'Страны'],
  platforms: [lookup(PLATFORMS, { mac: 'macos', macos: 'macos', ios: 'ios', iphone: 'ios', tv: 'tv', router: 'router', windows: 'windows' }), 'Платформы'],
  payments: [lookup(PAYMENTS, { карта: 'card_ru', карта_рф: 'card_ru', звезды: 'stars', stars: 'stars', крипта: 'crypto', crypto: 'crypto', юмани: 'yoomoney' }), 'Оплата']
};

const listOf = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[,;|/]+/)).map((x) => String(x).trim()).filter(Boolean);
const yes = (v) => ['1', 'да', 'yes', 'true', '+', 'есть'].includes(norm(v));

function mapList(v, key) {
  const [dict, field] = DICTS[key];
  return listOf(v).map((x) => {
    const id = dict.get(norm(x));
    if (!id) throw badRequest(`Неизвестное значение «${x}» в поле «${field}»`);
    return id;
  });
}

function parseDate(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], 9);
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1], 9);
  throw badRequest(`Дата сверки «${s}»: формат ГГГГ-ММ-ДД или ДД.ММ.ГГГГ`);
}

const num = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : Number(String(v).replace(/[\s₽]/g, '').replace(',', '.')));

// One import row (any column naming) → card input + check date.
export function importRow(raw) {
  const r = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = KEY.get(norm(k));
    if (key) r[key] = v;
  }
  const tariffs = {};
  for (const m of [1, 3, 6, 12]) {
    const p = num(r[`price_${m}`] ?? raw.tariffs?.[m]);
    if (p !== null) tariffs[m] = p;
  }
  const trialDays = num(r.trial);
  const trial = trialDays ? trialDays > 0 : yes(r.trial);
  return {
    card: validateCard({
      name: r.name, bot_url: r.bot, channel_url: r.channel || null, description: r.description || '', support_contact: r.contact || null,
      tariffs, devices: num(r.devices) ?? 1,
      protocols: mapList(r.protocols, 'protocols'), countries: mapList(r.countries, 'countries'),
      platforms: mapList(r.platforms, 'platforms'), payments: mapList(r.payments, 'payments'),
      whitelist_bypass: yes(r.whitelist), trial, trial_days: trial && trialDays > 0 ? trialDays : null
    }),
    checkedAt: parseDate(r.checked_at)
  };
}

// RFC 4180-ish CSV; the delimiter (; , or tab) is taken from the header line.
export function parseCSV(text) {
  const head = text.split(/\r?\n/, 1)[0];
  const delim = ['\t', ';', ','].map((d) => [d, head.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [header, ...data] = rows.filter((r) => r.some((c) => c.trim()));
  if (!header) return [];
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

export function parseImport(text) {
  const t = String(text || '').replace(/^﻿/, '').trim();
  if (!t) throw badRequest('Пустой файл');
  if (t.length > 1_000_000) throw badRequest('Файл больше 1 МБ — разбейте на части');
  let rows;
  if (t[0] === '[' || t[0] === '{') {
    try { rows = JSON.parse(t); } catch { throw badRequest('JSON не читается — проверьте запятые и кавычки'); }
    if (!Array.isArray(rows)) rows = rows.services || [rows];
  } else rows = parseCSV(t);
  if (rows.length > 500) throw badRequest('Не больше 500 сервисов за раз');
  return rows;
}

export function importServices(db, admin, text, { dryRun = false, uploadsDir } = {}) {
  const rows = parseImport(text);
  const firstLine = String(text).trim()[0] === '[' || String(text).trim()[0] === '{' ? 1 : 2;
  const created = [], errors = [], ok = [];
  rows.forEach((raw, i) => {
    const line = i + firstLine;
    const name = raw.name || raw['название'] || raw['Название'] || `строка ${line}`;
    try {
      const { card, checkedAt } = importRow(raw);
      if (db.get("SELECT 1 FROM services WHERE bot_url = ? AND status = 'published'", card.bot_url)) throw badRequest('Сервис с этим ботом уже есть в каталоге');
      if (dryRun) { ok.push({ line, name: card.name }); return; }
      created.push({ line, name: card.name, id: createService(db, admin, card, { uploadsDir, checkedAt }) });
    } catch (e) {
      errors.push({ line, name: String(name), error: e.message });
    }
  });
  return { total: rows.length, created, ok: dryRun ? ok : created.map(({ line, name }) => ({ line, name })), errors, dry_run: dryRun };
}
