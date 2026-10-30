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

// «Подобрать VPN»: one-tap questions; the server matches on the option ids (lib/pick.js).
export const PICK_QUESTIONS = [
  { key: 'device', title: 'Где будете пользоваться?', options: [
    { id: 'ios', name: 'iPhone или iPad' }, { id: 'android', name: 'Android' }, { id: 'windows', name: 'Компьютер на Windows' },
    { id: 'macos', name: 'Mac' }, { id: 'any', name: 'На разных устройствах' }] },
  { key: 'devices', title: 'Сколько устройств подключить?', options: [
    { id: '1', name: 'Одно' }, { id: '3', name: 'Два-три' }, { id: '4', name: 'Четыре и больше' }] },
  { key: 'whitelist', title: 'Бывает, что на мобильном открываются только разрешённые сайты?', hint: 'Так работают «белые списки» у операторов в некоторых регионах.', options: [
    { id: 'yes', name: 'Да, бывает' }, { id: 'no', name: 'Нет' }, { id: 'unknown', name: 'Не знаю' }] },
  { key: 'payment', title: 'Как удобнее платить?', options: [
    { id: 'sbp', name: 'СБП' }, { id: 'card_ru', name: 'Российская карта' }, { id: 'stars', name: 'Telegram Stars' },
    { id: 'crypto', name: 'Криптовалюта' }, { id: 'any', name: 'Не важно' }] },
  { key: 'budget', title: 'Сколько готовы платить в месяц?', options: [
    { id: '150', name: 'До 150 ₽' }, { id: '300', name: 'До 300 ₽' }, { id: 'any', name: 'Не важно' }] }
];

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

/* ---------- Service health from client signals ---------- */
// Soft wording on purpose: the system never says a VPN "does not work".
export const HEALTH = {
  operational: { name: 'Работает', short: 'Работает', tone: 'good' },
  issues: { name: 'Есть сообщения о сбоях', short: 'Сообщения о сбоях', tone: 'warn' },
  outage: { name: 'Массовый сбой', short: 'Массовый сбой', tone: 'bad' }
};

export const NETWORKS = [
  { id: 'wifi', name: 'Wi-Fi' },
  { id: 'mts', name: 'МТС' },
  { id: 'beeline', name: 'Билайн' },
  { id: 'megafon', name: 'МегаФон' },
  { id: 'tele2', name: 'Tele2' }
];
export const NETWORK = byId(NETWORKS);

// Admin settings for the health system: [key, label, min, max, step, group]. The server
// validates against the same list, so the form and the checks cannot drift apart.
export const STATUS_CONFIG_FIELDS = [
  ['window_min', 'Окно подсчёта голосов, мин', 10, 1440, 5, 'Статусы'],
  ['issues_votes', '«Сообщения о сбоях»: минимум голосов «не работает»', 1, 100, 1, 'Статусы'],
  ['issues_weight', '«Сообщения о сбоях»: минимальный суммарный вес', 0.1, 100, 0.1, 'Статусы'],
  ['outage_votes', '«Массовый сбой»: минимум голосов «не работает»', 1, 500, 1, 'Статусы'],
  ['outage_weight', '«Массовый сбой»: минимальный суммарный вес', 0.1, 500, 0.1, 'Статусы'],
  ['clear_after_min', 'Автоснятие сбоя без новых голосов «не работает», мин', 15, 2880, 5, 'Статусы'],
  ['weight_clicked', 'Вес голоса после перехода в бот через Линзу', 0, 5, 0.05, 'Веса и доверие'],
  ['weight_other', 'Вес голоса без перехода', 0, 5, 0.05, 'Веса и доверие'],
  ['trust_min', 'Доверие: минимум', 0, 1, 0.05, 'Веса и доверие'],
  ['trust_max', 'Доверие: максимум', 1, 10, 0.1, 'Веса и доверие'],
  ['trust_up', 'Доверие: прибавка, если голос совпал с итогом', 0, 1, 0.01, 'Веса и доверие'],
  ['trust_down', 'Доверие: штраф, если не совпал', 0, 1, 0.01, 'Веса и доверие'],
  ['trust_delay_min', 'Сверка голоса с итогом через, мин', 15, 1440, 5, 'Веса и доверие'],
  ['trust_quorum', 'Минимальный вес других голосов для сверки', 0, 50, 0.1, 'Веса и доверие'],
  ['cooldown_h', 'Один голос на сервис раз в, ч', 1, 168, 1, 'Лимиты'],
  ['daily_services', 'Сервисов в сутки с одного аккаунта', 1, 100, 1, 'Лимиты'],
  ['new_account_h', 'Не учитывать аккаунты моложе, ч', 0, 720, 1, 'Лимиты'],
  ['anomaly_trust', 'Аномалия: «низкое доверие» — ниже', 0, 2, 0.05, 'Аномалии'],
  ['anomaly_share', 'Аномалия: доля таких голосов «не работает» больше', 0.1, 1, 0.05, 'Аномалии'],
  ['spike_votes', 'Всплеск: голосов', 2, 1000, 1, 'Аномалии'],
  ['spike_min', 'Всплеск: за минут', 1, 120, 1, 'Аномалии'],
  ['networks_h', 'Разбивка по сетям за, ч', 1, 168, 1, 'Отображение'],
  ['networks_min_votes', 'Показывать разбивку от, голосов с сетью', 1, 100, 1, 'Отображение']
];
