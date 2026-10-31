import { badRequest } from './http.js';
import { PROTOCOL, COUNTRY, PLATFORM, PAYMENT, TARIFF_MONTHS, CARD_PARTS } from '../../public/js/dict.js';

const str = (v, max, field, { required = false, min = 0 } = {}) => {
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
  if (required && !s) throw badRequest(`Заполните поле «${field}»`);
  if (s && s.length < min) throw badRequest(`Поле «${field}» слишком короткое`);
  if (s.length > max) throw badRequest(`Поле «${field}» длиннее ${max} символов`);
  return s || null;
};

const int = (v, field, min, max, { required = false } = {}) => {
  if (v === null || v === undefined || v === '') {
    if (required) throw badRequest(`Заполните поле «${field}»`);
    return null;
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`Поле «${field}»: целое число от ${min} до ${max}`);
  return n;
};

const enumList = (v, dict, field) => {
  if (!Array.isArray(v)) return [];
  const out = [...new Set(v.map(String))];
  const bad = out.find((x) => !dict[x]);
  if (bad) throw badRequest(`Неизвестное значение «${bad}» в поле «${field}»`);
  return out;
};

// Accepts @name, t.me/name or https://t.me/name[?start=...] and returns a canonical https link.
export function normalizeTelegramLink(v, field = 'Ссылка') {
  const s = String(v || '').trim();
  if (!s) return null;
  const m = s.match(/^(?:@|(?:https?:\/\/)?(?:t\.me|telegram\.me)\/)([A-Za-z][A-Za-z0-9_]{3,31})(\?start=[A-Za-z0-9_-]{1,64})?\/?$/);
  if (!m) throw badRequest(`${field}: укажите @username или ссылку вида t.me/username`);
  return `https://t.me/${m[1]}${m[2] || ''}`;
}

export function normalizeContact(v) {
  const s = str(v, 120, 'Контакт', { required: true });
  return s;
}

const LOGO_DATA = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const LOGO_PATH = /^\/uploads\/[a-z0-9-]+\.(png|jpg|webp)$/;
// A Telegram avatar (imported cards keep it until the image is copied to uploads).
export const LOGO_TG = /^https:\/\/t\.me\/i\/userpic\/\d{2,4}\/[A-Za-z0-9_]{3,64}\.(jpg|png)$/;
const MAX_LOGO_BYTES = 400 * 1024;

// Owners fill in the whole card. `partial` is for cards Линза adds itself: unknown parts may be
// left empty and are listed in card.missing («уточняется» in the catalog) until the owner fills them.
export function validateCard(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object') throw badRequest('Пустая карточка');
  const tariffs = {};
  for (const m of TARIFF_MONTHS) {
    const p = int(input.tariffs?.[m], `Тариф на ${m} мес.`, 1, 1_000_000);
    if (p) tariffs[m] = p;
  }
  if (!partial && !Object.keys(tariffs).length) throw badRequest('Укажите хотя бы один тариф');

  let logo = input.logo || null;
  if (logo && !(LOGO_PATH.test(logo) || LOGO_TG.test(logo) || (LOGO_DATA.test(logo) && logo.length * 0.75 <= MAX_LOGO_BYTES))) {
    throw badRequest('Логотип: PNG, JPEG или WebP до 400 КБ');
  }

  const trial = Boolean(input.trial);
  const card = {
    name: str(input.name, 60, 'Название', { required: true, min: 2 }),
    description: str(input.description, 600, 'Описание') || '',
    logo,
    bot_url: normalizeTelegramLink(input.bot_url, 'Ссылка на бот'),
    channel_url: input.channel_url ? normalizeTelegramLink(input.channel_url, 'Ссылка на канал') : null,
    support_contact: str(input.support_contact, 120, 'Поддержка'),
    tariffs,
    devices: int(input.devices, 'Число устройств', 1, 100, { required: !partial }) ?? 1,
    protocols: enumList(input.protocols, PROTOCOL, 'Протоколы'),
    countries: enumList(input.countries, COUNTRY, 'Страны'),
    platforms: enumList(input.platforms, PLATFORM, 'Платформы'),
    payments: enumList(input.payments, PAYMENT, 'Способы оплаты'),
    whitelist_bypass: Boolean(input.whitelist_bypass),
    whitelist_note: str(input.whitelist_note, 200, 'Обход белых списков'),
    trial,
    trial_days: trial ? int(input.trial_days, 'Дней триала', 1, 90) : null,
    trial_terms: trial ? str(input.trial_terms, 300, 'Условия триала') : null
  };
  if (!card.bot_url) throw badRequest('Укажите ссылку на бот');
  card.missing = partial ? Object.keys(CARD_PARTS).filter((k) => (k === 'tariffs' ? !Object.keys(tariffs).length
    : k === 'devices' ? input.devices === null || input.devices === undefined || input.devices === '' : !card[k].length)) : [];
  if (partial) return card;
  if (!card.protocols.length) throw badRequest('Выберите хотя бы один протокол');
  if (!card.countries.length) throw badRequest('Выберите хотя бы одну страну');
  if (!card.platforms.length) throw badRequest('Выберите хотя бы одну платформу');
  if (!card.payments.length) throw badRequest('Выберите хотя бы один способ оплаты');
  return card;
}

export function validateApplication(input = {}) {
  return {
    name: str(input.name, 60, 'Название', { required: true, min: 2 }),
    link: normalizeTelegramLink(input.link, 'Ссылка на бот или канал'),
    contact: normalizeContact(input.contact),
    comment: str(input.comment, 500, 'Комментарий')
  };
}

export function validatePromo(input = {}, nowTs) {
  const starts = Number(input.starts_at);
  const ends = Number(input.ends_at);
  if (!Number.isFinite(starts) || !Number.isFinite(ends)) throw badRequest('Укажите даты начала и окончания');
  if (ends <= starts) throw badRequest('Дата окончания должна быть позже начала');
  if (ends <= nowTs) throw badRequest('Акция уже закончилась');
  if (ends - starts > 366 * 86400_000) throw badRequest('Акция не может длиться больше года');
  return {
    title: str(input.title, 80, 'Заголовок', { required: true, min: 3 }),
    description: str(input.description, 400, 'Описание'),
    discount_percent: int(input.discount_percent, 'Скидка, %', 1, 99),
    promo_code: str(input.promo_code, 32, 'Промокод'),
    starts_at: starts,
    ends_at: ends
  };
}

export function validateReview(input = {}) {
  return {
    rating: int(input.rating, 'Оценка', 1, 5, { required: true }),
    text: str(input.text, 2000, 'Текст отзыва', { required: true, min: 10 })
  };
}

export const reason = (v) => str(v, 500, 'Причина', { required: true, min: 3 });
