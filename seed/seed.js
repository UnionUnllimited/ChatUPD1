// Demo data: 25 fictional VPN services with tariffs, reviews, clicks, checks, promotions,
// client status signals with a history of incidents, and two published monthly tops. Run: npm run seed  (add -- --reset to start from scratch).
// Every name and bot link here is made up; wipe this data before launch.
import { rmSync } from 'node:fs';
import { config } from '../server/config.js';
import { openDb } from '../server/db.js';
import { applyCard } from '../server/lib/moderation.js';
import { recomputeMarketAverage } from '../server/lib/catalog.js';
import { publishTop } from '../server/lib/top.js';
import { grantRole, loadUser } from '../server/auth.js';
import { createChannel } from '../server/lib/ads.js';
import { recordVote, recomputeStatus, evaluateTrust, openDispute } from '../server/lib/health.js';
import { DAY, mskDay, now, periodOf, shiftPeriod, periodRange } from '../server/lib/time.js';

if (process.argv.includes('--reset')) {
  for (const suffix of ['', '-wal', '-shm']) rmSync(config.dbPath + suffix, { force: true });
}
const db = openDb(config.dbPath);
if (db.get('SELECT COUNT(*) n FROM services').n > 0) {
  console.log('Database already has services. Use `npm run seed -- --reset` to recreate it.');
  process.exit(0);
}

// Deterministic PRNG so every run produces the same catalog.
let seed = 20261030;
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const sample = (arr, n) => [...arr].sort(() => rnd() - 0.5).slice(0, n);
const between = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const roundPrice = (p) => Math.max(49, Math.round(p / 10) * 10 - 1);

const DEV_ADMIN = config.adminIds[0] || 100001;
const FAKE_BASE = 9_000_000_000_000; // far above real Telegram IDs

const SERVICES = [
  ['Аврора VPN', 'aurora', 'Быстрые серверы в Европе и Азии, VLESS Reality из коробки. Настройка за минуту через бота.'],
  ['Северный ветер', 'veter', 'WireGuard и AmneziaWG с честным безлимитом. Делаем упор на стабильность и поддержку 24/7.'],
  ['Пульс', 'pulse', 'Сеть из десятков локаций, оплата картой РФ и СБП, приложение для всех платформ.'],
  ['Кварц', 'quartz', 'Простой VPN для семьи: до 10 устройств на одну подписку и роутеры.'],
  ['Горизонт', 'horizon', 'Hysteria 2 для плохих сетей и мобильного интернета. Пробный период без привязки карты.'],
  ['Меридиан', 'meridian', 'Недорогой VPN на Shadowsocks и Outline, стабильная работа в регионах.'],
  ['Маяк', 'mayak', 'Обход белых списков на мобильных сетях, отдельные серверы для стриминга.'],
  ['Тоннель', 'tunnel', 'Классический OpenVPN и IKEv2 для работы и корпоративных задач.'],
  ['Призма', 'prisma', 'Мультипротокольный сервис: выбирайте VLESS, Trojan или WireGuard в один тап.'],
  ['Сфера', 'sfera', 'Бюджетный тариф для одного устройства, оплата в Telegram Stars.'],
  ['Орбита', 'orbita', 'Серверы в 12 странах, низкий пинг для игр и звонков.'],
  ['Ладья', 'ladya', 'Сервис от небольшой команды энтузиастов. Помогаем с настройкой лично.'],
  ['Комета', 'kometa', 'Моментальная выдача ключа после оплаты, автопродление по желанию.'],
  ['Полярис', 'polaris', 'Скандинавские серверы и строгая политика без логов.'],
  ['Бриз', 'briz', 'Лёгкий VPN для телефона: подключение по QR-коду и ссылке.'],
  ['Сокол', 'sokol', 'Выделенные IP и серверы в ОАЭ и Турции для путешествий.'],
  ['Флюгер', 'fluger', 'Автоматический выбор лучшего протокола под вашу сеть.'],
  ['Вектор', 'vektor', 'Для разработчиков: доступ к репозиториям и API без блокировок.'],
  ['Нимб', 'nimb', 'Тихий и стабильный VPN с поддержкой Smart TV и приставок.'],
  ['Стриж', 'strizh', 'Максимальная скорость на гигабитных серверах в Нидерландах и Германии.'],
  ['Гавань', 'gavan', 'Семейные тарифы и родительский контроль в одном боте.'],
  ['Зенит', 'zenit', 'Премиальные серверы с резервированием, SLA 99.9%.'],
  ['Луч', 'luch', 'Самый простой вход: оплатили — получили ссылку для подключения.'],
  ['Пилот', 'pilot', 'Новый сервис: щедрый пробный период и скидки первым клиентам.'],
  ['Ковчег', 'kovcheg', 'Резервные серверы в разных дата-центрах, переключение без разрывов.']
];

const REVIEWS = {
  5: ['Пользуюсь третий месяц, ни одного отключения. Поддержка отвечает за пару минут.', 'Отличная скорость, YouTube в 4K без подтормаживаний. Рекомендую.', 'Настроил за минуту через бота, работает и на мобильном интернете.', 'Лучшее, что пробовал за год. Цена адекватная, всё стабильно.', 'Работает даже там, где другие отваливаются. Спасибо команде!'],
  4: ['В целом доволен, иногда по вечерам скорость проседает, но некритично.', 'Хороший сервис, хотелось бы больше стран, а так всё отлично.', 'Стабильно работает, поддержка помогла с роутером. Минус звезда за интерфейс бота.', 'Цена радует, подключение быстрое. Пару раз пришлось переподключаться.'],
  3: ['Средне: днём отлично, вечером бывают обрывы. Поддержка отвечает не сразу.', 'Работает, но приходится иногда менять сервер вручную.', 'За свои деньги нормально, но есть варианты стабильнее.'],
  2: ['Часто отваливается на мобильном интернете, поддержка долго отвечает.', 'Скорость ниже заявленной, продлевать не буду.'],
  1: ['Перестал работать через неделю, деньги не вернули.', 'Не смог подключиться ни на одном устройстве, поддержка молчит.']
};

const PROTOCOL_SETS = [
  ['vless_reality'], ['vless_reality', 'shadowsocks'], ['wireguard', 'amneziawg'], ['vless_reality', 'trojan', 'vmess'],
  ['hysteria2', 'vless_reality'], ['shadowsocks', 'outline'], ['openvpn', 'ikev2'], ['vless', 'trojan', 'wireguard'], ['amneziawg'], ['vless_reality', 'hysteria2', 'wireguard']
];
const COUNTRY_POOL = ['nl', 'de', 'fi', 'se', 'ee', 'lv', 'pl', 'fr', 'gb', 'ch', 'us', 'ca', 'tr', 'kz', 'am', 'ge', 'ae', 'jp', 'sg', 'hk'];
const PAY_SETS = [['card_ru', 'sbp'], ['card_ru', 'sbp', 'stars'], ['stars', 'crypto'], ['sbp', 'yoomoney'], ['card_ru', 'sbp', 'crypto'], ['crypto', 'card_foreign'], ['card_ru', 'stars', 'crypto', 'yoomoney']];
const PLATFORM_SETS = [['ios', 'android'], ['ios', 'android', 'windows', 'macos'], ['ios', 'android', 'windows', 'macos', 'linux'], ['ios', 'android', 'router', 'tv'], ['ios', 'android', 'windows', 'macos', 'linux', 'router', 'tv'], ['android', 'windows', 'linux']];

const ts0 = now();
const startOfData = periodRange(shiftPeriod(periodOf(ts0), -2))[0]; // 1st day two months back
const span = ts0 - startOfData;

db.tx(() => {
  // Users: the dev admin, one owner per service, and a crowd of clients.
  const user = (id, first, username) => db.run(
    'INSERT OR IGNORE INTO users (id, username, first_name, bot_chat_allowed, created_at, last_seen_at) VALUES (?, ?, ?, 1, ?, ?)',
    id, username, first, startOfData, ts0);
  user(DEV_ADMIN, 'Админ', 'linza_admin');
  grantRole(db, DEV_ADMIN, 'vpn_owner');
  const firstNames = ['Алексей', 'Мария', 'Иван', 'Ольга', 'Дмитрий', 'Анна', 'Сергей', 'Екатерина', 'Павел', 'Наталья', 'Артём', 'Юлия', 'Никита', 'Ксения', 'Максим', 'Дарья', 'Егор', 'Полина', 'Кирилл', 'Виктория'];
  const clients = [];
  for (let i = 1; i <= 420; i++) {
    const id = FAKE_BASE + i;
    user(id, pick(firstNames), null);
    clients.push(id);
  }

  const created = SERVICES.map(([name, slug, description], i) => {
    const ownerId = i === 0 ? DEV_ADMIN : FAKE_BASE + 10_000 + i;
    if (i) { user(ownerId, `Владелец ${name}`, `${slug}_owner_demo`); grantRole(db, ownerId, 'vpn_owner'); }
    // Popularity/quality factor drives clicks, ratings and check results.
    const quality = 0.35 + rnd() * 0.65;
    const base = roundPrice(between(99, 399));
    const tariffs = {
      1: base,
      3: roundPrice(base * 3 * (0.85 + rnd() * 0.1)),
      6: roundPrice(base * 6 * (0.75 + rnd() * 0.1)),
      12: roundPrice(base * 12 * (0.55 + rnd() * 0.2))
    };
    if (i % 7 === 3) delete tariffs[1]; // some sell only longer periods
    const trial = rnd() < 0.5;
    const whitelist = rnd() < 0.4;
    const card = {
      name, description, logo: null,
      bot_url: `https://t.me/linza_demo_${slug}_bot`,
      channel_url: rnd() < 0.6 ? `https://t.me/linza_demo_${slug}` : null,
      support_contact: `@linza_demo_${slug}_support`,
      tariffs,
      devices: pick([1, 2, 3, 5, 5, 10]),
      protocols: pick(PROTOCOL_SETS),
      countries: sample(COUNTRY_POOL, between(3, 12)),
      platforms: pick(PLATFORM_SETS),
      payments: pick(PAY_SETS),
      whitelist_bypass: whitelist,
      whitelist_note: whitelist ? 'Отдельные серверы для мобильных сетей с белыми списками' : null,
      trial,
      trial_days: trial ? pick([1, 3, 3, 7]) : null,
      trial_terms: trial ? pick(['Без привязки карты, один раз на аккаунт Telegram', 'Полный доступ ко всем серверам', 'Одно устройство на время теста']) : null
    };
    const r = db.run('INSERT INTO services (owner_id, name, bot_url, created_at) VALUES (?, ?, ?, ?)', ownerId, name, card.bot_url, startOfData);
    const id = Number(r.lastInsertRowid);
    applyCard(db, id, card);
    // Spread publication dates so "new first" sorting means something.
    const publishedAt = i < 20 ? startOfData + Math.floor(rnd() * 10) * DAY : ts0 - between(1, 20) * DAY;
    db.run('UPDATE services SET published_at = ?, updated_at = ?, created_at = ? WHERE id = ?', publishedAt, publishedAt, publishedAt, id);
    db.run("INSERT INTO applications (user_id, name, link, contact, status, service_id, created_at, reviewed_by, reviewed_at) VALUES (?, ?, ?, ?, 'approved', ?, ?, ?, ?)",
      ownerId, name, card.bot_url, card.support_contact, id, publishedAt - DAY, DEV_ADMIN, publishedAt - DAY / 2);
    return { id, quality, publishedAt, card };
  });

  // Clicks, reviews (only from users who clicked), favorites and daily stats.
  const stats = new Map();
  const bump = (sid, day, k, n = 1) => {
    const key = `${sid}|${day}`;
    const s = stats.get(key) || { impressions: 0, views: 0, clicks: 0 };
    s[k] += n;
    stats.set(key, s);
  };
  for (const s of created) {
    const audience = sample(clients, Math.floor(20 + s.quality * s.quality * 260));
    for (const uid of audience) {
      const visits = between(1, 3);
      let firstAt = null;
      for (let v = 0; v < visits; v++) {
        const at = Math.max(s.publishedAt, startOfData + Math.floor(rnd() * span));
        if (at > ts0) continue;
        firstAt = firstAt === null ? at : Math.min(firstAt, at);
        db.run('INSERT INTO clicks (service_id, user_id, source, created_at) VALUES (?, ?, ?, ?)', s.id, uid, pick(['catalog', 'home', 'top', 'compare']), at);
        bump(s.id, mskDay(at), 'clicks');
      }
      if (firstAt === null) continue;
      if (rnd() < 0.12) db.run('INSERT OR IGNORE INTO favorites (user_id, service_id, created_at) VALUES (?, ?, ?)', uid, s.id, firstAt);
      if (rnd() < 0.22) {
        const roll = rnd() * 0.5 + s.quality * 0.6;
        const rating = roll > 0.75 ? 5 : roll > 0.6 ? 4 : roll > 0.45 ? 3 : roll > 0.33 ? 2 : 1;
        const at = Math.min(ts0, firstAt + between(1, 10) * DAY);
        db.run("INSERT OR IGNORE INTO reviews (service_id, user_id, rating, text, status, created_at, updated_at, reviewed_by, reviewed_at) VALUES (?, ?, ?, ?, 'approved', ?, ?, ?, ?)",
          s.id, uid, rating, pick(REVIEWS[rating]), at, at, DEV_ADMIN, at + 3600_000);
      }
    }
    // Impressions and card views around the clicks.
    for (let t = Math.max(startOfData, s.publishedAt); t <= ts0; t += DAY) {
      const day = mskDay(t);
      const clicks = stats.get(`${s.id}|${day}`)?.clicks || 0;
      bump(s.id, day, 'impressions', Math.floor(clicks * (6 + rnd() * 6) + rnd() * 30));
      bump(s.id, day, 'views', Math.floor(clicks * (1.6 + rnd()) + rnd() * 4));
    }
    // Weekly manual checks; weaker services fail more often.
    for (let t = Math.max(startOfData, s.publishedAt) + between(0, 6) * DAY; t <= ts0; t += 7 * DAY) {
      const passed = rnd() < 0.55 + s.quality * 0.45;
      db.run('INSERT INTO service_checks (service_id, admin_id, passed, note, checked_at) VALUES (?, ?, ?, ?, ?)',
        s.id, DEV_ADMIN, passed, passed ? null : pick(['Не подключается на МТС', 'Таймаут на iOS', 'Бот не выдал ключ за 10 минут']), t);
    }
  }
  for (const [key, s] of stats) {
    const [sid, day] = key.split('|');
    db.run('INSERT INTO stats_daily (service_id, day, impressions, views, clicks) VALUES (?, ?, ?, ?, ?)', Number(sid), day, s.impressions, s.views, s.clicks);
  }

  // Promotions: a few running, one finished, one waiting for moderation.
  const promo = (s, title, pct, code, startOffset, endOffset, status = 'approved') => db.run(
    'INSERT INTO promotions (service_id, title, description, discount_percent, promo_code, starts_at, ends_at, status, created_at, reviewed_by, reviewed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    s.id, title, 'Скидка действует на первую оплату любого тарифа', pct, code, ts0 + startOffset * DAY, ts0 + endOffset * DAY, status, ts0 + (startOffset - 1) * DAY,
    status === 'pending' ? null : DEV_ADMIN, status === 'pending' ? null : ts0 + startOffset * DAY);
  promo(created[0], 'Осенняя скидка на годовой тариф', 30, 'AUTUMN30', -5, 9);
  promo(created[2], 'Первый месяц за полцены', 50, 'LINZA50', -2, 12);
  promo(created[6], 'Два месяца в подарок к годовому', null, null, -10, 4);
  promo(created[11], '−20% на любой тариф', 20, 'LADYA20', -1, 20);
  promo(created[16], 'Чёрная пятница заранее', 40, 'BF40', -3, 29);
  promo(created[23], 'Скидка для первых клиентов', 25, 'PILOT25', -7, 6);
  promo(created[4], 'Летняя акция', 15, 'SUMMER', -80, -50, 'expired');
  promo(created[9], 'Ноябрьская скидка', 35, 'NOV35', 2, 30, 'pending');

  // Moderation queue for the demo admin.
  const pendingUser = FAKE_BASE + 20_001;
  user(pendingUser, 'Роман', 'roman_vpn_demo');
  db.run("INSERT INTO applications (user_id, name, link, contact, comment, created_at) VALUES (?, 'Туман VPN', 'https://t.me/linza_demo_tuman_bot', '@roman_vpn_demo', 'Работаем с весны, 300 активных клиентов', ?)", pendingUser, ts0 - 3 * 3600_000);
  user(FAKE_BASE + 20_002, 'Ирина', null);
  db.run("INSERT INTO applications (user_id, name, link, contact, created_at) VALUES (?, 'Причал', 'https://t.me/linza_demo_prichal', 'support@prichal.example', ?)", FAKE_BASE + 20_002, ts0 - 26 * 3600_000);

  const edited = { ...created[1].card, tariffs: { ...created[1].card.tariffs, 1: roundPrice(created[1].card.tariffs[1] * 0.8) }, description: created[1].card.description + ' Теперь с серверами в Казахстане.', countries: [...new Set([...created[1].card.countries, 'kz'])] };
  db.run('INSERT INTO service_revisions (service_id, author_id, data, created_at) VALUES (?, ?, ?, ?)', created[1].id, FAKE_BASE + 10_001, JSON.stringify(edited), ts0 - 5 * 3600_000);
  const edited2 = { ...created[0].card, trial: true, trial_days: 3, trial_terms: 'Три дня без привязки карты', payments: [...new Set([...created[0].card.payments, 'stars'])] };
  db.run('INSERT INTO service_revisions (service_id, author_id, data, created_at) VALUES (?, ?, ?, ?)', created[0].id, DEV_ADMIN, JSON.stringify(edited2), ts0 - 2 * 3600_000);

  for (const [i, text, rating] of [[3, 'Подключил роутер по инструкции, всё работает. Детям хватает пяти устройств.', 5], [5, 'Днём нормально, вечером медленно. Но за такую цену пойдёт.', 3], [12, 'Ключ пришёл моментально, но на iPhone пришлось ставить другое приложение.', 4]]) {
    const uid = clients[i * 7];
    db.run("INSERT INTO clicks (service_id, user_id, source, created_at) VALUES (?, ?, 'catalog', ?)", created[i].id, uid, ts0 - 4 * DAY);
    db.run("INSERT INTO reviews (service_id, user_id, rating, text, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT(service_id, user_id) DO UPDATE SET status = 'pending', text = excluded.text, rating = excluded.rating",
      created[i].id, uid, rating, text, ts0 - DAY, ts0 - DAY);
  }

  // The dev user's own client history, so the profile isn't empty.
  for (const s of created.slice(2, 6)) {
    db.run("INSERT INTO clicks (service_id, user_id, source, created_at) VALUES (?, ?, 'catalog', ?)", s.id, DEV_ADMIN, ts0 - between(1, 20) * DAY);
  }
  db.run('INSERT OR IGNORE INTO favorites (user_id, service_id, created_at) VALUES (?, ?, ?)', DEV_ADMIN, created[2].id, ts0 - 3 * DAY);
  db.run('INSERT OR IGNORE INTO favorites (user_id, service_id, created_at) VALUES (?, ?, ?)', DEV_ADMIN, created[6].id, ts0 - 2 * DAY);

  recomputeMarketAverage(db);
});

/* ---------------- Status signals ---------------- */
// Votes go through the real pipeline (weights, cooldowns, recompute), in time order per service.
const MIN = 60_000;
const NETS = ['wifi', 'mts', 'beeline', 'megafon', 'tele2'];
const clientRow = (id) => db.get('SELECT id, created_at FROM users WHERE id = ?', id);
const voters = (sid) => db.all('SELECT DISTINCT user_id id FROM clicks WHERE service_id = ? AND user_id > ? AND user_id < ?', sid, FAKE_BASE, FAKE_BASE + 10_000).map((r) => r.id);
const vote = (uid, sid, value, at, network = null) => {
  try {
    recordVote(db, clientRow(uid), sid, value, { ts: at });
    if (network) db.run('UPDATE status_votes SET network = ? WHERE user_id = ? AND service_id = ? AND created_at = ?', network, uid, sid, at);
    return true;
  } catch { return false; } // daily limit and cooldown collisions are fine to skip
};
// Background job every 10 minutes, so timeouts land where the scheduler would put them.
const settle = (sid, from, to) => { for (let t = from; t <= to; t += 10 * MIN) recomputeStatus(db, sid, { ts: t }); };

const published = db.all("SELECT id, published_at FROM services WHERE status = 'published' ORDER BY id");
for (const [i, s] of published.entries()) {
  const pool = voters(s.id);
  if (pool.length < 12) continue;
  const quality = 1 - i / published.length; // earlier demo services are steadier on average
  const from = Math.max(startOfData, s.published_at) + DAY;
  const events = [];
  // Everyday "it works" signals.
  for (let k = 0; k < between(8, 24); k++) events.push({ at: from + Math.floor(rnd() * (ts0 - 3 * 3600_000 - from)), kind: 'up' });
  // A few past incidents; flakier services get more of them.
  for (let k = 0; k < between(0, 2) + Math.round((1 - quality) * 4); k++) {
    const at = from + Math.floor(rnd() * (ts0 - 12 * 3600_000 - from));
    events.push({ at, kind: rnd() < 0.25 ? 'outage' : 'issues' });
  }
  events.sort((a, b) => a.at - b.at);
  for (const e of events) {
    if (e.kind === 'up') { vote(pick(pool), s.id, 'up', e.at, rnd() < 0.5 ? pick(NETS) : null); continue; }
    const crowd = sample(pool, e.kind === 'outage' ? between(9, 13) : between(3, 6));
    const net = pick(NETS);
    let t = e.at;
    for (const uid of crowd) {
      t += between(2, 14) * MIN;
      vote(uid, s.id, 'down', t, rnd() < 0.7 ? (rnd() < 0.7 ? net : pick(NETS)) : null);
    }
    // Recovery: either clients confirm it works again, or the status times out.
    const back = t + between(40, 300) * MIN;
    if (rnd() < 0.6) for (const uid of sample(pool.filter((u) => !crowd.includes(u)), between(2, 4))) vote(uid, s.id, 'up', back + between(0, 20) * MIN);
    settle(s.id, t, Math.min(ts0 - 3 * 3600_000, t + 7 * 3600_000));
  }
}
// Votes older than the trust delay have been compared with the majority by now.
while (db.get("SELECT COUNT(*) n FROM status_votes WHERE trust_checked_at IS NULL AND created_at <= ?", ts0 - 2 * 3600_000).n) evaluateTrust(db, { ts: ts0 });
db.run("UPDATE status_anomalies SET state = 'cleared', resolved_by = ?, resolved_at = created_at + 3600000", DEV_ADMIN);

// Current picture for the demo: issues on the dev owner's own service (try «Оспорить»),
// an outage with an open dispute, and signals from low-trust accounts that only raise an anomaly.
const svcByName = (name) => db.get('SELECT id FROM services WHERE name = ?', name).id;
const recent = (sid, value, specs) => {
  const pool = voters(sid).filter((u) => !db.get('SELECT 1 FROM status_votes WHERE user_id = ? AND service_id = ? AND created_at > ?', u, sid, ts0 - 12 * 3600_000));
  for (const [ago, network] of specs) vote(pool.shift(), sid, value, ts0 - ago * MIN, network);
};
const aurora = svcByName('Аврора VPN');
recent(aurora, 'down', [[95, 'mts'], [70, 'mts'], [42, 'wifi'], [18, 'mts']]);
const outageSvc = db.get("SELECT id, owner_id FROM services WHERE name = ?", SERVICES[7][0]);
recent(outageSvc.id, 'up', [[300, 'wifi']]);
recent(outageSvc.id, 'down', [[88, 'beeline'], [80, 'mts'], [71, 'beeline'], [64, 'beeline'], [55, null], [47, 'megafon'], [39, 'beeline'], [30, 'mts'], [22, 'beeline'], [11, 'wifi']]);
openDispute(db, { id: outageSvc.owner_id, roles: ['vpn_owner'] }, outageSvc.id, 'Серверы в порядке, у Билайна проблемы с маршрутизацией — мы уже обходим через резервные узлы.');
db.run("UPDATE status_disputes SET created_at = ? WHERE state = 'open'", ts0 - 6 * MIN);
const lowTrust = db.all('SELECT DISTINCT user_id id FROM clicks WHERE service_id = ? AND user_id > ? AND user_id < ? LIMIT 6 OFFSET 30', svcByName(SERVICES[13][0]), FAKE_BASE, FAKE_BASE + 10_000).map((r) => r.id);
db.run(`UPDATE users SET trust_score = 0.2 WHERE id IN (${lowTrust.join(',')})`);
const lowSvc = svcByName(SERVICES[13][0]);
lowTrust.slice(0, 5).forEach((uid, k) => vote(uid, lowSvc, 'down', ts0 - (50 - k * 9) * MIN, 'tele2'));
recent(lowSvc, 'up', [[35, 'wifi'], [12, 'megafon']]);
// Radar: a third VPN failing on МТС (too few votes for a status, enough for the radar — so МТС looks
// like an operator problem) and VPNs that people on МТС say work.
recent(svcByName(SERVICES[4][0]), 'down', [[40, 'mts'], [25, 'mts']]);
for (const k of [1, 2, 9, 11]) recent(svcByName(SERVICES[k][0]), 'up', [[between(30, 400), 'mts'], [between(30, 600), 'mts'], [between(60, 700), 'wifi']]);
// Recent "works" signals elsewhere, so cards show a fresh last-signal time.
for (const s of published) if (![aurora, outageSvc.id, lowSvc].includes(s.id) && rnd() < 0.7) recent(s.id, 'up', [[between(20, 600), rnd() < 0.5 ? pick(NETS) : null]]);

/* ---------------- Ad exchange ---------------- */
// Demo channels (links under t.me/linza_demo_ch_*, wiped by «Удалить тестовые данные»), past deals
// with buyers' reviews, and open deals for the dev user both as a buyer and as a seller.
const CHANNELS = [
  ['Бубсер | Бравл Старс', 'bubser', 'games', 195000, 22000, 29000, { '1/24': 6000, '2/48': 9000, pin: 15000 }, true, true, 0.9],
  ['Мемы без контекста', 'memes_nc', 'humor', 340000, 61000, 78000, { '1/24': 9000, '1/48': 11000 }, true, false, 0.8],
  ['APK Хаб', 'apkhub', 'apk', 88000, 14000, 19000, { '1/24': 3500, '2/48': 5000 }, false, true, 0.7],
  ['Срочные новости 24', 'news24', 'news', 520000, 95000, 120000, { '1/24': 30000, pin: 55000 }, true, false, 0.6],
  ['Кино на вечер', 'kino_vecher', 'movies', 150000, 18000, 24000, { '1/24': 5200, '1/48': 6500 }, false, false, 0.75],
  ['Шок! Это реально', 'shock_real', 'shock', 410000, 70000, 92000, { '1/24': 12000, '2/48': 16000, pack: 40000 }, false, true, 0.5],
  ['Техно без воды', 'tech_nowater', 'tech', 62000, 9000, 12500, { '1/24': 2700 }, true, true, 0.85],
  ['Крипто сигналы', 'crypto_sig', 'crypto', 120000, 8000, 11000, { '1/24': 4500 }, false, false, 0.3],
  ['Игровые новости', 'gamenews', 'games', 230000, 30000, 41000, { '1/24': 7000, '2/48': 10000, '1/48': 8500 }, true, true, 0.8],
  ['Смешно до слёз', 'lol_tears', 'humor', 99000, 21000, 27000, { '1/24': 4200, pack: 15000 }, false, false, 0.65],
  ['Музыка в машину', 'carmusic', 'music', 75000, 11000, 15000, { '1/24': 3000 }, false, true, 0.7],
  ['Лайфхаки на каждый день', 'lifehacks', 'lifestyle', 180000, 26000, 33000, { '1/24': 6800, pin: 12000 }, true, false, 0.75]
];
const AD_TEXTS = ['Зашло отлично, аудитория живая', 'Охват честный, конверсия средняя', 'Пришло меньше, чем ждали, но оплаты были', 'Быстро согласовали, пост вышел вовремя', 'Аудитория молодая, триалы берут охотно'];
const futureDates = (n) => sample(Array.from({ length: 30 }, (_, i) => mskDay(ts0 + (i + 1) * DAY)), n).sort();
const vpnOwners = db.all("SELECT s.id service_id, s.owner_id FROM services s WHERE s.owner_id >= ? AND s.status = 'published'", FAKE_BASE);
const adChannels = [];
db.tx(() => {
  CHANNELS.forEach(([title, slug, topic, subs, r24, r48, formats, verified, hadVpn, q], i) => {
    const sellerId = FAKE_BASE + 30_000 + i;
    db.run('INSERT OR IGNORE INTO users (id, username, first_name, bot_chat_allowed, created_at, last_seen_at) VALUES (?, ?, ?, 1, ?, ?)',
      sellerId, `${slug}_admin_demo`, `Админ ${title}`, startOfData, ts0);
    const { id } = createChannel(db, loadUser(db, sellerId, []), {
      link: `https://t.me/linza_demo_ch_${slug}`, title, topic, subscribers: subs, reach_24: r24, reach_48: r48,
      stats_url: rnd() < 0.6 ? `https://tgstat.ru/channel/@linza_demo_ch_${slug}` : '', formats,
      free_dates: futureDates(between(4, 10)), had_vpn: hadVpn, contact: `@linza_demo_${slug}`.slice(0, 32)
    });
    if (verified) db.run('UPDATE ad_channels SET verified_at = ?, subscribers_at = ?, tg_chat_id = ? WHERE id = ?', ts0 - between(5, 40) * DAY, ts0 - DAY, -1_000_000_000_000 - i, id);
    db.run('UPDATE ad_channels SET created_at = ?, updated_at = ? WHERE id = ?', ts0 - between(20, 60) * DAY, ts0 - between(0, 10) * DAY, id);
    adChannels.push({ id, sellerId, formats, q });
    // Past placements with reviews; a weak channel sometimes doesn't post at all.
    for (const b of sample(vpnOwners, between(0, 5))) {
      const format = pick(Object.keys(formats));
      const at = ts0 - between(4, 55) * DAY;
      const failed = rnd() > 0.35 + q * 0.6;
      const deal = Number(db.run(
        `INSERT INTO ad_deals (channel_id, seller_id, buyer_id, service_id, format, date, price, status, created_at, decided_at, published_at, review_asked_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, sellerId, b.owner_id, b.service_id, format, mskDay(at), formats[format], failed ? 'failed' : 'reviewed',
        at - 3 * DAY, at - 2 * DAY, failed ? null : at, at + 2 * DAY, at + 2 * DAY).lastInsertRowid);
      if (failed) continue;
      const rating = Math.max(1, Math.min(5, Math.round(q * 5 + (rnd() - 0.5) * 1.6)));
      const came = Math.round((r24 / 100) * (0.4 + q) * (0.6 + rnd()));
      db.run('INSERT INTO ad_reviews (deal_id, channel_id, buyer_id, rating, came, payments, reach_match, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        deal, id, b.owner_id, rating, came, Math.round(came * (0.03 + q * 0.06)), q > 0.7 ? 'yes' : q > 0.5 ? pick(['yes', 'partly']) : pick(['partly', 'no']),
        rnd() < 0.7 ? pick(AD_TEXTS) : null, at + 2 * DAY);
    }
  });
  // The dev user as a buyer: a request waiting for an answer, an agreed post, and one to review.
  const myService = db.get('SELECT id FROM services WHERE owner_id = ? LIMIT 1', DEV_ADMIN)?.id ?? null;
  const devDeal = (ch, format, dayOffset, status) => db.run(
    `INSERT INTO ad_deals (channel_id, seller_id, buyer_id, service_id, format, date, price, status, created_at, decided_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ch.id, ch.sellerId, DEV_ADMIN, myService, format, mskDay(ts0 + dayOffset * DAY), ch.formats[format], status, ts0 - 2 * DAY, status === 'requested' ? null : ts0 - DAY, ts0 - DAY);
  devDeal(adChannels[2], '1/24', 6, 'requested');
  devDeal(adChannels[0], '1/24', 3, 'agreed');
  devDeal(adChannels[8], '2/48', -3, 'agreed');
  // …and as a seller with an incoming request.
  const { id: mine } = createChannel(db, loadUser(db, DEV_ADMIN, config.adminIds), {
    link: 'https://t.me/linza_demo_ch_mine', title: 'Мой тестовый канал', topic: 'tech', subscribers: 42000, reach_24: 7000, reach_48: 9000,
    formats: { '1/24': 1900, '2/48': 2600 }, free_dates: futureDates(6), had_vpn: false, contact: '@linza_admin'
  });
  const b = vpnOwners[3];
  db.run(`INSERT INTO ad_deals (channel_id, seller_id, buyer_id, service_id, format, date, price, comment, status, created_at, updated_at) VALUES (?, ?, ?, ?, '1/24', ?, 1900, ?, 'requested', ?, ?)`,
    mine, DEV_ADMIN, b.owner_id, b.service_id, JSON.parse(db.get('SELECT free_dates FROM ad_channels WHERE id = ?', mine).free_dates)[0], 'Нужен пост про VPN для игр, креатив пришлём', ts0 - 3600_000, ts0 - 3600_000);
});

// Publish the two finished months so the home screen and the archive have data.
for (const offset of [-2, -1]) publishTop(db, shiftPeriod(periodOf(ts0), offset), DEV_ADMIN);
// Seeding must not spam: drop the outbox the publications produced, and mark the one-time
// reminders as already sent for demo data (the scheduler would nudge demo users otherwise).
db.run('DELETE FROM notifications');
db.run('UPDATE services SET fill_reminded_at = ?', ts0);
db.run('UPDATE ad_channels SET verify_reminded_at = ?', ts0);
db.run('UPDATE ad_deals SET seller_reminded_at = ?, day_reminded_at = ?, review_asked_at = COALESCE(review_asked_at, ?)', ts0, ts0, ts0);

const n = (sql) => db.get(sql).n;
console.log(`Seeded ${n('SELECT COUNT(*) n FROM services')} services, ${n('SELECT COUNT(*) n FROM users')} users, ` +
  `${n('SELECT COUNT(*) n FROM reviews')} reviews, ${n('SELECT COUNT(*) n FROM clicks')} clicks, ${n('SELECT COUNT(*) n FROM status_votes')} status votes, ` +
  `${n("SELECT COUNT(*) n FROM status_changes WHERE status != 'operational'")} incidents, ${n('SELECT COUNT(*) n FROM ad_channels')} ad channels, ${n('SELECT COUNT(*) n FROM ad_deals')} deals. Market average: ${db.setting('market_avg_monthly')} ₽/мес.`);
console.log(`Demo admin / owner Telegram ID: ${DEV_ADMIN} (add it to ADMIN_IDS).`);
db.close();
