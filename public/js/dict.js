// Shared dictionaries: imported by both the browser app and the server,
// so enum validation and labels never drift apart.

export const TARIFF_MONTHS = [1, 3, 6, 12];

export const PROTOCOLS = [
  { id: 'vless_reality', name: 'VLESS Reality' },
  { id: 'vless', name: 'VLESS' },
  { id: 'vmess', name: 'VMess' },
  { id: 'trojan', name: 'Trojan' },
  { id: 'shadowsocks', name: 'Shadowsocks' },
  { id: 'hysteria2', name: 'Hysteria 2' },
  { id: 'wireguard', name: 'WireGuard' },
  { id: 'amneziawg', name: 'AmneziaWG' },
  { id: 'openvpn', name: 'OpenVPN' },
  { id: 'outline', name: 'Outline' },
  { id: 'ikev2', name: 'IKEv2' }
];

export const COUNTRIES = [
  { id: 'nl', name: 'Нидерланды', flag: '🇳🇱' },
  { id: 'de', name: 'Германия', flag: '🇩🇪' },
  { id: 'fi', name: 'Финляндия', flag: '🇫🇮' },
  { id: 'se', name: 'Швеция', flag: '🇸🇪' },
  { id: 'ee', name: 'Эстония', flag: '🇪🇪' },
  { id: 'lv', name: 'Латвия', flag: '🇱🇻' },
  { id: 'pl', name: 'Польша', flag: '🇵🇱' },
  { id: 'fr', name: 'Франция', flag: '🇫🇷' },
  { id: 'gb', name: 'Великобритания', flag: '🇬🇧' },
  { id: 'ch', name: 'Швейцария', flag: '🇨🇭' },
  { id: 'us', name: 'США', flag: '🇺🇸' },
  { id: 'ca', name: 'Канада', flag: '🇨🇦' },
  { id: 'tr', name: 'Турция', flag: '🇹🇷' },
  { id: 'kz', name: 'Казахстан', flag: '🇰🇿' },
  { id: 'am', name: 'Армения', flag: '🇦🇲' },
  { id: 'ge', name: 'Грузия', flag: '🇬🇪' },
  { id: 'ae', name: 'ОАЭ', flag: '🇦🇪' },
  { id: 'jp', name: 'Япония', flag: '🇯🇵' },
  { id: 'sg', name: 'Сингапур', flag: '🇸🇬' },
  { id: 'hk', name: 'Гонконг', flag: '🇭🇰' },
  { id: 'ru', name: 'Россия', flag: '🇷🇺' }
];

export const PLATFORMS = [
  { id: 'ios', name: 'iOS' },
  { id: 'android', name: 'Android' },
  { id: 'windows', name: 'Windows' },
  { id: 'macos', name: 'macOS' },
  { id: 'linux', name: 'Linux' },
  { id: 'router', name: 'Роутер' },
  { id: 'tv', name: 'Smart TV' }
];

export const PAYMENTS = [
  { id: 'card_ru', name: 'Карта РФ' },
  { id: 'sbp', name: 'СБП' },
  { id: 'stars', name: 'Telegram Stars' },
  { id: 'crypto', name: 'Криптовалюта' },
  { id: 'yoomoney', name: 'ЮMoney' },
  { id: 'card_foreign', name: 'Зарубежная карта' }
];

export const DEVICE_OPTIONS = [1, 2, 3, 5, 10];

export const SORTS = [
  { id: 'price', name: 'Цена' },
  { id: 'rating', name: 'Рейтинг' },
  { id: 'popular', name: 'Популярность' },
  { id: 'new', name: 'Новизна' }
];

export const MARKET_LABELS = {
  below: 'ниже рынка',
  market: 'в рынке',
  above: 'выше рынка'
};

// Roles are plain strings so new ones (contractor, channel_owner, ...) can be
// added later without touching auth or the profile model.
export const ROLES = {
  client: 'Клиент',
  vpn_owner: 'VPN-сервис',
  admin: 'Администратор'
};

export const MODERATION_STATUS = {
  pending: 'На проверке',
  approved: 'Опубликовано',
  rejected: 'Отклонено',
  superseded: 'Заменено новой версией',
  expired: 'Завершено'
};

export const NOTIFY_TYPES = [
  { id: 'price_drop', name: 'Снижение цены', hint: 'У VPN из избранного стало дешевле' },
  { id: 'promo', name: 'Новые акции', hint: 'У VPN из избранного появилась скидка' },
  { id: 'top', name: 'Топ месяца', hint: 'Опубликован новый рейтинг' },
  { id: 'news', name: 'Новости Линзы', hint: 'Редкие объявления площадки' }
];

export const MONTHS_NOM = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

export const byId = (list) => Object.fromEntries(list.map((x) => [x.id, x]));
export const PROTOCOL = byId(PROTOCOLS);
export const COUNTRY = byId(COUNTRIES);
export const PLATFORM = byId(PLATFORMS);
export const PAYMENT = byId(PAYMENTS);

// "2026-09" -> "сентябрь 2026"
export function monthLabel(period) {
  const [y, m] = period.split('-').map(Number);
  return `${MONTHS_NOM[m - 1]} ${y}`;
}
