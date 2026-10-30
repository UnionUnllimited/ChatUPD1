// Ad exchange: channel admins (sellers) list ad slots, VPN owners (buyers) book them.
// Deals are free for now and settled directly in Telegram: Линза only matches the two sides,
// opens contacts after the seller agrees and collects reviews from buyers whose post went out.
import { AD_TOPIC, AD_FORMATS, AD_FORMAT, AD_COMPLAINT_REASONS, AD_REACH_MATCH, AD_DEAL_STATUS } from '../../public/js/dict.js';
import { HttpError, badRequest, forbidden, notFound } from './http.js';
import { audit, html } from './moderation.js';
import { enqueue } from './notify.js';
import { notifyAdmins } from './health.js';
import { grantRole } from '../auth.js';
import { now, mskDay, DAY } from './time.js';

const HOUR = 3600 * 1000;
const fmtRub = (n) => `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} ₽`;
const dateRu = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' });
const parseJSON = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

export function adConfig(db) {
  return { cpm_good: 250, cpm_ok: 350, complaints_review: 3, review_after_h: 48, ...(db.setting('ad_config') || {}) };
}

export function validateAdConfig(body) {
  const out = {};
  for (const [k, min, max] of [['cpm_good', 1, 100000], ['cpm_ok', 1, 100000], ['complaints_review', 1, 100], ['review_after_h', 1, 720]]) {
    const v = Number(body?.[k]);
    if (!Number.isFinite(v) || v < min || v > max) throw badRequest(`Неверное значение: ${k}`);
    out[k] = Math.round(v);
  }
  if (out.cpm_ok < out.cpm_good) throw badRequest('Порог «норма» не может быть ниже порога «выгодно»');
  return out;
}

/* ---------------- CPM ---------------- */

// CPM = price per 1000 views of the reach this format gets; a package has no single reach.
export function cpmOf(format, price, ch) {
  const f = AD_FORMAT[format];
  const reach = f?.reach === 24 ? ch.reach_24 : f?.reach === 48 ? ch.reach_48 : 0;
  return reach > 0 ? Math.round((price / reach) * 1000) : null;
}
export const cpmLight = (cpm, cfg) => (cpm === null ? null : cpm <= cfg.cpm_good ? 'good' : cpm <= cfg.cpm_ok ? 'ok' : 'high');

/* ---------------- Listing validation ---------------- */

const USERNAME = /^[a-z][a-z0-9_]{3,31}$/i;
const STATS_HOST = /^https:\/\/([a-z0-9-]+\.)?(telemetr\.(io|me)|tgstat\.(ru|com))\//i;

// Accepts @name, t.me/name, https://t.me/name and invite links (t.me/+code, t.me/joinchat/code).
export function parseChannelLink(input) {
  const v = String(input || '').trim().replace(/^https?:\/\//i, '').replace(/^(www\.)?(t|telegram)\.me\//i, '').replace(/\/+$/, '');
  if (/^\+[\w-]{8,}$/.test(v) || /^joinchat\/[\w-]{8,}$/i.test(v)) return { link: `https://t.me/${v}`, username: null };
  const name = v.replace(/^@/, '');
  if (USERNAME.test(name)) return { link: `https://t.me/${name}`, username: name.toLowerCase() };
  return null;
}

const int = (v, min, max, msg) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest(msg);
  return n;
};

export function validateChannel(body = {}, ts = now()) {
  const link = parseChannelLink(body.link);
  if (!link) throw badRequest('Ссылка на канал: @username или https://t.me/…');
  const title = String(body.title || '').trim().slice(0, 80);
  if (!title) throw badRequest('Укажите название канала');
  if (!AD_TOPIC[body.topic]) throw badRequest('Выберите тематику');
  const subscribers = int(body.subscribers, 1, 100_000_000, 'Укажите число подписчиков');
  const reach24 = int(body.reach_24, 1, 100_000_000, 'Укажите охват поста за 24 часа');
  const reach48 = int(body.reach_48, 1, 100_000_000, 'Укажите охват поста за 48 часов');
  if (reach48 < reach24) throw badRequest('Охват за 48 часов не может быть меньше, чем за 24');
  let stats = String(body.stats_url || '').trim();
  if (stats && !STATS_HOST.test(stats)) throw badRequest('Статистика — ссылка на страницу канала в Telemetr или TGStat');
  stats = stats ? stats.slice(0, 300) : null;
  const formats = {};
  for (const f of AD_FORMATS) {
    const p = body.formats?.[f.id];
    if (p === undefined || p === null || p === '') continue;
    formats[f.id] = int(p, 1, 10_000_000, `Цена формата ${f.name} — целое число рублей`);
  }
  if (!Object.keys(formats).length) throw badRequest('Добавьте хотя бы один формат с ценой');
  const today = mskDay(ts);
  const last = mskDay(ts + 90 * DAY);
  const dates = [...new Set(Array.isArray(body.free_dates) ? body.free_dates : [])]
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= today && d <= last).sort();
  let contact = String(body.contact || '').trim().replace(/^https?:\/\/(t|telegram)\.me\//i, '@');
  if (!contact.startsWith('@')) contact = `@${contact}`;
  if (!USERNAME.test(contact.slice(1))) throw badRequest('Контакт — ваш @username в Telegram');
  return {
    ...link, title, topic: body.topic, subscribers, reach_24: reach24, reach_48: reach48, stats_url: stats,
    formats, free_dates: dates, had_vpn: body.had_vpn ? 1 : 0, contact
  };
}

/* ---------------- Channel views ---------------- */

function channelStats(db, ids) {
  if (!ids.length) return new Map();
  const list = ids.map(Number).join(',');
  const placed = new Map(db.all(`SELECT channel_id, COUNT(*) n FROM ad_deals WHERE channel_id IN (${list}) AND status IN ('published', 'reviewed') GROUP BY channel_id`).map((r) => [r.channel_id, r.n]));
  const rev = new Map(db.all(
    `SELECT channel_id, AVG(rating) rating, COUNT(*) n, AVG(came) came, AVG(payments) payments,
       SUM(reach_match = 'yes') reach_yes, COUNT(reach_match) reach_n
     FROM ad_reviews WHERE channel_id IN (${list}) GROUP BY channel_id`).map((r) => [r.channel_id, r]));
  return new Map(ids.map((id) => [id, { placements: placed.get(id) || 0, ...(rev.get(id) || {}) }]));
}

// Public card. The seller's contact is never here: it opens only inside an agreed deal.
export function channelView(row, cfg, stats = {}, ts = now()) {
  const prices = parseJSON(row.formats, {});
  const formats = AD_FORMATS.filter((f) => prices[f.id]).map((f) => {
    const cpm = cpmOf(f.id, prices[f.id], row);
    return { id: f.id, price: prices[f.id], cpm, light: cpmLight(cpm, cfg) };
  });
  const withCpm = formats.filter((f) => f.cpm !== null);
  const best = withCpm.length ? withCpm.reduce((a, b) => (b.cpm < a.cpm ? b : a)) : formats[0] || null;
  const today = mskDay(ts);
  return {
    id: row.id,
    owner_id: row.owner_id,
    title: row.title,
    link: row.link,
    photo_url: row.photo_url,
    topic: row.topic,
    subscribers: row.subscribers,
    subscribers_from_tg: Boolean(row.subscribers_at),
    reach_24: row.reach_24,
    reach_48: row.reach_48,
    stats_url: row.stats_url,
    formats,
    best,
    free_dates: parseJSON(row.free_dates, []).filter((d) => d >= today),
    had_vpn: Boolean(row.had_vpn),
    verified: Boolean(row.verified_at),
    status: row.status,
    placements: stats.placements || 0,
    rating: stats.n ? Math.round(stats.rating * 10) / 10 : null,
    reviews: stats.n || 0,
    avg_came: stats.came != null ? Math.round(stats.came) : null,
    avg_payments: stats.payments != null ? Math.round(stats.payments) : null,
    reach_match: stats.reach_n ? { yes: stats.reach_yes, of: stats.reach_n } : null,
    updated_at: row.updated_at
  };
}

const SORTS = {
  cpm: (a, b) => (a.best?.cpm ?? Infinity) - (b.best?.cpm ?? Infinity) || b.reach_24 - a.reach_24,
  reach: (a, b) => b.reach_24 - a.reach_24,
  rating: (a, b) => (b.rating ?? 0) - (a.rating ?? 0) || b.placements - a.placements || (a.best?.cpm ?? Infinity) - (b.best?.cpm ?? Infinity)
};

export function parseAdFilters(q = {}) {
  const num = (v) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    topics: String(q.topics || '').split(',').filter((t) => AD_TOPIC[t]),
    format: AD_FORMAT[q.format] ? q.format : null,
    reachMin: num(q.reach_min),
    priceMax: num(q.price_max),
    cpmMax: num(q.cpm_max),
    date: /^\d{4}-\d{2}-\d{2}$/.test(q.date || '') ? q.date : null,
    verified: q.verified === '1',
    hadVpn: q.had_vpn === '1',
    favorites: q.favorites === '1',
    sort: SORTS[q.sort] ? q.sort : 'cpm'
  };
}

export function listChannels(db, query, userId) {
  const cfg = adConfig(db);
  const f = parseAdFilters(query);
  const rows = db.all("SELECT * FROM ad_channels WHERE status = 'active'");
  const stats = channelStats(db, rows.map((r) => r.id));
  const favs = new Set(userId ? db.all('SELECT channel_id FROM ad_favorites WHERE user_id = ?', userId).map((r) => r.channel_id) : []);
  const all = rows.map((r) => ({ ...channelView(r, cfg, stats.get(r.id)), fav: favs.has(r.id) }));
  const items = all.filter((c) => {
    // With a format chosen, price and CPM filters apply to that format; otherwise to the best offer.
    const offer = f.format ? c.formats.find((x) => x.id === f.format) : c.best;
    if (f.format && !offer) return false;
    if (f.topics.length && !f.topics.includes(c.topic)) return false;
    if (f.reachMin !== null && c.reach_24 < f.reachMin) return false;
    if (f.priceMax !== null && (!offer || offer.price > f.priceMax)) return false;
    if (f.cpmMax !== null && (!offer || offer.cpm === null || offer.cpm > f.cpmMax)) return false;
    if (f.date && !c.free_dates.includes(f.date)) return false;
    if (f.verified && !c.verified) return false;
    if (f.hadVpn && !c.had_vpn) return false;
    if (f.favorites && !c.fav) return false;
    return true;
  }).sort(SORTS[f.sort]);
  return { items, total: all.length, config: { cpm_good: cfg.cpm_good, cpm_ok: cfg.cpm_ok } };
}

export function channelRow(db, id) {
  const row = db.get('SELECT * FROM ad_channels WHERE id = ?', id);
  if (!row) throw notFound('Канал не найден');
  return row;
}

export function channelDetail(db, id, user) {
  const cfg = adConfig(db);
  const row = channelRow(db, id);
  const mine = user && row.owner_id === user.id;
  const isAdmin = user?.roles?.includes('admin');
  if (row.status !== 'active' && !mine && !isAdmin) throw notFound('Канал не найден или снят с биржи');
  const view = channelView(row, cfg, channelStats(db, [row.id]).get(row.id));
  const reviews = db.all(
    `SELECT r.rating, r.came, r.payments, r.reach_match, r.text, r.created_at, d.format, s.name service_name
     FROM ad_reviews r JOIN ad_deals d ON d.id = r.deal_id LEFT JOIN services s ON s.id = d.service_id
     WHERE r.channel_id = ? ORDER BY r.created_at DESC LIMIT 20`, row.id);
  const me = user ? {
    mine,
    fav: Boolean(db.get('SELECT 1 FROM ad_favorites WHERE user_id = ? AND channel_id = ?', user.id, row.id)),
    can_book: !mine && row.status === 'active' && user.roles.includes('vpn_owner'),
    open_deal: db.get("SELECT id, status FROM ad_deals WHERE channel_id = ? AND buyer_id = ? AND status IN ('requested', 'agreed') ORDER BY id DESC LIMIT 1", row.id, user.id) || null,
    complained: Boolean(db.get('SELECT 1 FROM ad_complaints WHERE channel_id = ? AND user_id = ?', row.id, user.id)),
    services: user.roles.includes('vpn_owner') ? db.all("SELECT id, name FROM services WHERE owner_id = ? AND status = 'published' ORDER BY name", user.id) : []
  } : null;
  return {
    ...view,
    block_reason: mine || isAdmin ? row.block_reason : null,
    config: { cpm_good: cfg.cpm_good, cpm_ok: cfg.cpm_ok },
    reviews,
    me
  };
}

/* ---------------- Seller ---------------- */

export function myChannels(db, user) {
  const cfg = adConfig(db);
  const rows = db.all('SELECT * FROM ad_channels WHERE owner_id = ? ORDER BY created_at DESC', user.id);
  const stats = channelStats(db, rows.map((r) => r.id));
  const fresh = new Map(db.all("SELECT channel_id, COUNT(*) n FROM ad_deals WHERE seller_id = ? AND status = 'requested' GROUP BY channel_id", user.id).map((r) => [r.channel_id, r.n]));
  return rows.map((r) => ({ ...channelView(r, cfg, stats.get(r.id)), block_reason: r.block_reason, contact: r.contact, requests: fresh.get(r.id) || 0 }));
}

export function sellerChannel(db, user, id) {
  const row = channelRow(db, id);
  if (row.owner_id !== user.id) throw forbidden('Это не ваш канал');
  return { ...channelView(row, adConfig(db)), free_dates: parseJSON(row.free_dates, []), contact: row.contact, block_reason: row.block_reason, link: row.link };
}

export function createChannel(db, user, body) {
  const d = validateChannel(body);
  if (db.get('SELECT COUNT(*) n FROM ad_channels WHERE owner_id = ?', user.id).n >= 20) throw badRequest('Не больше 20 каналов на одного продавца');
  if (d.username && db.get('SELECT 1 FROM ad_channels WHERE owner_id = ? AND username = ?', user.id, d.username)) throw badRequest('Этот канал у вас уже есть');
  const ts = now();
  let id;
  db.tx(() => {
    id = Number(db.run(
      `INSERT INTO ad_channels (owner_id, link, username, title, topic, subscribers, reach_24, reach_48, stats_url, formats, free_dates, had_vpn, contact, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      user.id, d.link, d.username, d.title, d.topic, d.subscribers, d.reach_24, d.reach_48, d.stats_url,
      JSON.stringify(d.formats), JSON.stringify(d.free_dates), d.had_vpn, d.contact, ts, ts).lastInsertRowid);
    grantRole(db, user.id, 'ad_seller');
    // A channel its real admin already confirmed can't be listed by someone else.
    if (d.username && db.get('SELECT 1 FROM ad_channels WHERE username = ? AND verified_at IS NOT NULL AND owner_id != ?', d.username, user.id)) {
      db.run("UPDATE ad_channels SET status = 'blocked', block_reason = ? WHERE id = ?", 'Этот канал уже подтвердил его владелец', id);
    }
  });
  return { id };
}

export function updateChannel(db, user, id, body) {
  const row = channelRow(db, id);
  if (row.owner_id !== user.id) throw forbidden('Это не ваш канал');
  const d = validateChannel(body);
  // Changing the channel itself drops the confirmation and the numbers Telegram gave us.
  const sameChannel = d.link === row.link;
  db.run(
    `UPDATE ad_channels SET link = ?, username = ?, title = ?, topic = ?, subscribers = ?, reach_24 = ?, reach_48 = ?, stats_url = ?, formats = ?,
       free_dates = ?, had_vpn = ?, contact = ?, verified_at = ?, tg_chat_id = ?, subscribers_at = ?, updated_at = ? WHERE id = ?`,
    d.link, d.username, sameChannel && row.verified_at ? row.title : d.title, d.topic,
    sameChannel && row.subscribers_at ? row.subscribers : d.subscribers, d.reach_24, d.reach_48, d.stats_url,
    JSON.stringify(d.formats), JSON.stringify(d.free_dates), d.had_vpn, d.contact,
    sameChannel ? row.verified_at : null, sameChannel ? row.tg_chat_id : null, sameChannel ? row.subscribers_at : null, now(), id);
  return { id };
}

export function setChannelVisible(db, user, id, visible) {
  const row = channelRow(db, id);
  if (row.owner_id !== user.id) throw forbidden('Это не ваш канал');
  if (row.status === 'review' || row.status === 'blocked') throw badRequest(row.status === 'review' ? 'Канал на проверке после жалоб' : 'Канал заблокирован');
  db.run('UPDATE ad_channels SET status = ?, updated_at = ? WHERE id = ?', visible ? 'active' : 'hidden', now(), id);
}

export function deleteChannel(db, user, id) {
  const row = channelRow(db, id);
  if (row.owner_id !== user.id) throw forbidden('Это не ваш канал');
  if (db.get("SELECT 1 FROM ad_deals WHERE channel_id = ? AND status IN ('requested', 'agreed')", id)) throw badRequest('Сначала завершите или отмените открытые сделки');
  db.run('DELETE FROM ad_channels WHERE id = ?', id);
}

/* ---------------- Verification through the bot ---------------- */

// The seller adds the bot as an admin of the channel. A public channel is matched by username,
// a private one by its title — and always only among the listings of the person who added the bot.
export function verifyChannel(db, fromId, chat, ts = now()) {
  const username = chat.username ? String(chat.username).toLowerCase() : null;
  // SQLite lower() is ASCII-only, so titles (usually Cyrillic) are compared here.
  const norm = (s) => String(s || '').trim().toLocaleLowerCase('ru');
  const row = username
    ? db.get('SELECT * FROM ad_channels WHERE owner_id = ? AND username = ? ORDER BY id LIMIT 1', fromId, username)
    : db.all('SELECT * FROM ad_channels WHERE owner_id = ? AND username IS NULL ORDER BY id', fromId).find((r) => norm(r.title) === norm(chat.title));
  if (!row) return null;
  const others = username ? db.all("SELECT id, owner_id, title FROM ad_channels WHERE username = ? AND owner_id != ? AND status != 'blocked'", username, fromId) : [];
  db.tx(() => {
    db.run('UPDATE ad_channels SET verified_at = ?, tg_chat_id = ?, title = ?, updated_at = ? WHERE id = ?', ts, chat.id, String(chat.title || row.title).slice(0, 80), ts, row.id);
    if (row.status === 'blocked' && row.block_reason === 'Этот канал уже подтвердил его владелец') db.run("UPDATE ad_channels SET status = 'active', block_reason = NULL WHERE id = ?", row.id);
    for (const o of others) {
      db.run("UPDATE ad_channels SET status = 'blocked', block_reason = ? WHERE id = ?", 'Этот канал подтвердил его владелец', o.id);
      enqueue(db, o.owner_id, 'deal', `Объявление «${html(o.title)}» снято с биржи: настоящий владелец канала подтвердил его через бота Линзы.`, 'ads_my');
    }
  });
  return db.get('SELECT * FROM ad_channels WHERE id = ?', row.id);
}

// The bot lost its admin rights: the confirmation goes away.
export function unverifyChannel(db, chatId) {
  db.run('UPDATE ad_channels SET verified_at = NULL, subscribers_at = NULL, updated_at = ? WHERE tg_chat_id = ?', now(), chatId);
}

export function setTelegramNumbers(db, channelId, { subscribers, photo_url } = {}) {
  if (Number.isInteger(subscribers) && subscribers > 0) db.run('UPDATE ad_channels SET subscribers = ?, subscribers_at = ? WHERE id = ?', subscribers, now(), channelId);
  if (photo_url) db.run('UPDATE ad_channels SET photo_url = ? WHERE id = ?', photo_url, channelId);
}

/* ---------------- Deals ---------------- */

const OPEN = ['requested', 'agreed'];
const userName = (db, id) => {
  const u = db.get('SELECT username, first_name FROM users WHERE id = ?', id);
  return u?.username ? `@${u.username}` : u?.first_name || `id ${id}`;
};

export function bookDeal(db, buyer, channelId, body = {}, ts = now()) {
  if (!buyer.roles.includes('vpn_owner')) throw forbidden('Бронировать размещения могут владельцы VPN — подключите свой VPN в профиле');
  const row = channelRow(db, channelId);
  if (row.status !== 'active') throw badRequest('Канал сейчас не принимает заявки');
  if (row.owner_id === buyer.id) throw badRequest('Это ваш канал');
  const price = parseJSON(row.formats, {})[body.format];
  if (!price) throw badRequest('Выберите формат из предложенных');
  const date = String(body.date || '');
  const free = parseJSON(row.free_dates, []);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < mskDay(ts) || date > mskDay(ts + 90 * DAY)) throw badRequest('Выберите дату в ближайшие 90 дней');
  if (free.length && !free.includes(date)) throw badRequest('Эта дата у канала занята — выберите из свободных');
  if (db.get(`SELECT 1 FROM ad_deals WHERE channel_id = ? AND buyer_id = ? AND status IN ('requested', 'agreed')`, channelId, buyer.id)) {
    throw badRequest('У вас уже есть открытая заявка в этот канал');
  }
  if (db.get("SELECT COUNT(*) n FROM ad_deals WHERE buyer_id = ? AND status = 'requested'", buyer.id).n >= 20) throw new HttpError(429, 'Слишком много заявок без ответа', 'rate_limited');
  const service = body.service_id ? db.get("SELECT id, name FROM services WHERE id = ? AND owner_id = ?", Number(body.service_id), buyer.id) : null;
  if (body.service_id && !service) throw badRequest('Выберите свой VPN');
  const comment = typeof body.comment === 'string' ? body.comment.trim().slice(0, 500) || null : null;
  let id;
  db.tx(() => {
    id = Number(db.run(
      `INSERT INTO ad_deals (channel_id, seller_id, buyer_id, service_id, format, date, price, comment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id, row.owner_id, buyer.id, service?.id ?? null, body.format, date, price, comment, ts, ts).lastInsertRowid);
    enqueue(db, row.owner_id, 'deal',
      `📩 Заявка в «${html(row.title)}»: ${AD_FORMAT[body.format].name} на ${dateRu(date)} — ${fmtRub(price)}.\nОт: ${html(userName(db, buyer.id))}${service ? ` (VPN «${html(service.name)}»)` : ''}` +
      `${comment ? `\n\n«${html(comment)}»` : ''}\n\nПодтвердите или отклоните заявку в Линзе.`, `deal_${id}`);
  });
  return { id };
}

export function dealRow(db, id) {
  const d = db.get('SELECT * FROM ad_deals WHERE id = ?', id);
  if (!d) throw notFound('Сделка не найдена');
  return d;
}

function party(d, user) {
  if (d.buyer_id === user.id) return 'buyer';
  if (d.seller_id === user.id) return 'seller';
  throw forbidden('Это не ваша сделка');
}

// The post date has come (in Moscow time).
const dateCame = (d, ts) => d.date <= mskDay(ts);

export function decideDeal(db, seller, id, agree, reason = null) {
  const d = dealRow(db, id);
  if (party(d, seller) !== 'seller') throw forbidden('Решение принимает продавец');
  if (d.status !== 'requested') throw badRequest('Заявка уже рассмотрена');
  const ch = channelRow(db, d.channel_id);
  const ts = now();
  db.tx(() => {
    if (agree) {
      db.run("UPDATE ad_deals SET status = 'agreed', decided_at = ?, updated_at = ? WHERE id = ?", ts, ts, id);
      enqueue(db, d.buyer_id, 'deal',
        `✅ «${html(ch.title)}» согласовал размещение ${AD_FORMAT[d.format].name} на ${dateRu(d.date)} — ${fmtRub(d.price)}.\n\n` +
        `Контакт продавца: ${html(ch.contact)}. Креатив и оплату обсуждайте напрямую.`, `deal_${id}`);
    } else {
      const why = typeof reason === 'string' ? reason.trim().slice(0, 300) || null : null;
      db.run("UPDATE ad_deals SET status = 'declined', decline_reason = ?, decided_at = ?, updated_at = ? WHERE id = ?", why, ts, ts, id);
      enqueue(db, d.buyer_id, 'deal', `«${html(ch.title)}» отклонил заявку на ${dateRu(d.date)}.${why ? `\nПричина: ${html(why)}` : ''}`, `deal_${id}`);
    }
  });
}

export function cancelDeal(db, user, id) {
  const d = dealRow(db, id);
  const who = party(d, user);
  if (!OPEN.includes(d.status)) throw badRequest('Эту сделку уже нельзя отменить');
  const ch = channelRow(db, d.channel_id);
  const ts = now();
  db.tx(() => {
    db.run("UPDATE ad_deals SET status = 'cancelled', cancelled_by = ?, updated_at = ? WHERE id = ?", user.id, ts, id);
    const to = who === 'buyer' ? d.seller_id : d.buyer_id;
    enqueue(db, to, 'deal', `${who === 'buyer' ? 'Покупатель отменил' : 'Продавец отменил'} размещение в «${html(ch.title)}» на ${dateRu(d.date)}.`, `deal_${id}`);
  });
}

export function markPublished(db, user, id) {
  const d = dealRow(db, id);
  party(d, user);
  const ts = now();
  if (d.status !== 'agreed') throw badRequest('Отметить публикацию можно только в согласованной сделке');
  if (!dateCame(d, ts)) throw badRequest('Дата размещения ещё не наступила');
  db.run("UPDATE ad_deals SET status = 'published', published_at = ?, updated_at = ? WHERE id = ?", ts, ts, id);
}

// Only the buyer, only after the post date. "Пост не вышел" is a review too: it shows up in the channel's history.
export function reviewDeal(db, buyer, id, body = {}) {
  const d = dealRow(db, id);
  if (party(d, buyer) !== 'buyer') throw forbidden('Отзыв оставляет покупатель');
  const ts = now();
  if (!['agreed', 'published'].includes(d.status)) throw badRequest(d.status === 'reviewed' ? 'Отзыв уже оставлен' : 'Отзыв можно оставить по согласованной сделке');
  if (!dateCame(d, ts)) throw badRequest('Отзыв можно оставить после даты размещения');
  if (body.published === false) {
    db.run("UPDATE ad_deals SET status = 'failed', updated_at = ? WHERE id = ?", ts, id);
    return { status: 'failed' };
  }
  const rating = int(body.rating, 1, 5, 'Поставьте оценку от 1 до 5');
  const opt = (v, msg) => (v === undefined || v === null || v === '' ? null : int(v, 0, 10_000_000, msg));
  const came = opt(body.came, 'Сколько пришло — целое число');
  const payments = opt(body.payments, 'Число оплат — целое число');
  const reach = AD_REACH_MATCH.some((r) => r.id === body.reach_match) ? body.reach_match : null;
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, 1000) || null : null;
  db.tx(() => {
    db.run('INSERT INTO ad_reviews (deal_id, channel_id, buyer_id, rating, came, payments, reach_match, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, d.channel_id, buyer.id, rating, came, payments, reach, text, ts);
    db.run("UPDATE ad_deals SET status = 'reviewed', published_at = COALESCE(published_at, ?), updated_at = ? WHERE id = ?", ts, ts, id);
  });
  return { status: 'reviewed' };
}

export function dealView(db, d, user) {
  const who = party(d, user);
  const ch = db.get('SELECT id, title, photo_url, link, contact, owner_id FROM ad_channels WHERE id = ?', d.channel_id);
  const ts = now();
  // Contacts open both ways once the seller agrees.
  const open = ['agreed', 'published', 'reviewed', 'failed'].includes(d.status);
  const buyer = db.get('SELECT id, username, first_name FROM users WHERE id = ?', d.buyer_id);
  const service = d.service_id ? db.get('SELECT id, name, logo_url FROM services WHERE id = ?', d.service_id) : null;
  const review = d.status === 'reviewed' ? db.get('SELECT rating, came, payments, reach_match, text, created_at FROM ad_reviews WHERE deal_id = ?', d.id) : null;
  return {
    id: d.id, role: who, status: d.status, status_name: AD_DEAL_STATUS[d.status]?.name,
    format: d.format, date: d.date, price: d.price, comment: d.comment, decline_reason: d.decline_reason,
    created_at: d.created_at, decided_at: d.decided_at, published_at: d.published_at,
    channel: { id: ch.id, title: ch.title, photo_url: ch.photo_url, link: ch.link },
    service,
    seller_contact: open && who === 'buyer' ? ch.contact : null,
    buyer_contact: open && who === 'seller' ? { username: buyer.username, first_name: buyer.first_name } : null,
    buyer_name: who === 'seller' ? (buyer.first_name || null) : null,
    review,
    can: {
      decide: who === 'seller' && d.status === 'requested',
      cancel: OPEN.includes(d.status),
      publish: d.status === 'agreed' && dateCame(d, ts),
      review: who === 'buyer' && ['agreed', 'published'].includes(d.status) && dateCame(d, ts)
    }
  };
}

export function listDeals(db, user, as) {
  const col = as === 'seller' ? 'seller_id' : 'buyer_id';
  return db.all(
    `SELECT d.id, d.status, d.format, d.date, d.price, d.created_at, d.updated_at, c.title channel_title, c.photo_url, s.name service_name
     FROM ad_deals d JOIN ad_channels c ON c.id = d.channel_id LEFT JOIN services s ON s.id = d.service_id
     WHERE d.${col} = ? ORDER BY CASE WHEN d.status IN ('requested', 'agreed', 'published') THEN 0 ELSE 1 END, d.date DESC, d.id DESC LIMIT 200`, user.id);
}

// Scheduler: some time after the post date the buyer is asked how it went.
export function askReviews(db, ts = now()) {
  const cfg = adConfig(db);
  const due = db.all("SELECT d.*, c.title FROM ad_deals d JOIN ad_channels c ON c.id = d.channel_id WHERE d.status IN ('agreed', 'published') AND d.review_asked_at IS NULL");
  let n = 0;
  for (const d of due) {
    const postAt = Date.parse(`${d.date}T12:00:00+03:00`);
    if (ts < postAt + cfg.review_after_h * HOUR) continue;
    db.run('UPDATE ad_deals SET review_asked_at = ? WHERE id = ?', ts, d.id);
    enqueue(db, d.buyer_id, 'deal', `Как прошло размещение в «${html(d.title)}» ${dateRu(d.date)}? Отметьте, сколько пришло и сколько оплат — из этих отзывов складывается рейтинг канала.`, `deal_${d.id}`);
    n++;
  }
  return n;
}

/* ---------------- Favorites & complaints ---------------- */

export function setFavorite(db, user, channelId, on) {
  channelRow(db, channelId);
  if (on) db.run('INSERT OR IGNORE INTO ad_favorites (user_id, channel_id, created_at) VALUES (?, ?, ?)', user.id, channelId, now());
  else db.run('DELETE FROM ad_favorites WHERE user_id = ? AND channel_id = ?', user.id, channelId);
}

// After enough complaints from different people the channel leaves the feed until an admin looks.
export function complain(db, user, channelId, body = {}, { envAdmins = [] } = {}) {
  const row = channelRow(db, channelId);
  if (row.owner_id === user.id) throw badRequest('Нельзя пожаловаться на свой канал');
  if (!AD_COMPLAINT_REASONS.some((r) => r.id === body.reason)) throw badRequest('Выберите причину');
  if (db.get('SELECT 1 FROM ad_complaints WHERE channel_id = ? AND user_id = ?', channelId, user.id)) throw badRequest('Вы уже пожаловались на этот канал');
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, 500) || null : null;
  const cfg = adConfig(db);
  let review = false;
  db.tx(() => {
    db.run('INSERT INTO ad_complaints (channel_id, user_id, reason, text, created_at) VALUES (?, ?, ?, ?, ?)', channelId, user.id, body.reason, text, now());
    const open = db.get('SELECT COUNT(*) n FROM ad_complaints WHERE channel_id = ? AND resolved_at IS NULL', channelId).n;
    if (row.status === 'active' && open >= cfg.complaints_review) {
      db.run("UPDATE ad_channels SET status = 'review', updated_at = ? WHERE id = ?", now(), channelId);
      review = true;
      notifyAdmins(db, envAdmins, `🚩 Канал «${html(row.title)}» снят с биржи на проверку: ${open} ${open < 5 ? 'жалобы' : 'жалоб'}.`, 'admin_ads');
      enqueue(db, row.owner_id, 'deal', `Объявление «${html(row.title)}» временно скрыто: на него пожаловались несколько покупателей. Администратор проверит его.`, 'ads_my');
    }
  });
  return { review };
}

/* ---------------- Admin ---------------- */

export function adminChannels(db) {
  const cfg = adConfig(db);
  const rows = db.all(`SELECT c.*, u.username owner_username, u.first_name owner_name FROM ad_channels c JOIN users u ON u.id = c.owner_id ORDER BY
    CASE c.status WHEN 'review' THEN 0 ELSE 1 END, c.created_at DESC`);
  const stats = channelStats(db, rows.map((r) => r.id));
  const complaints = new Map(db.all('SELECT channel_id, COUNT(*) n FROM ad_complaints WHERE resolved_at IS NULL GROUP BY channel_id').map((r) => [r.channel_id, r.n]));
  const deals = new Map(db.all('SELECT channel_id, COUNT(*) n FROM ad_deals GROUP BY channel_id').map((r) => [r.channel_id, r.n]));
  return rows.map((r) => ({
    ...channelView(r, cfg, stats.get(r.id)), block_reason: r.block_reason, contact: r.contact,
    owner: { id: r.owner_id, username: r.owner_username, first_name: r.owner_name },
    complaints: complaints.get(r.id) || 0, deals: deals.get(r.id) || 0
  }));
}

export function adminSetChannel(db, admin, id, action, note = null) {
  const row = channelRow(db, id);
  const ts = now();
  db.tx(() => {
    if (action === 'restore') {
      db.run("UPDATE ad_channels SET status = 'active', block_reason = NULL, updated_at = ? WHERE id = ?", ts, id);
      db.run('UPDATE ad_complaints SET resolved_at = ? WHERE channel_id = ? AND resolved_at IS NULL', ts, id);
      if (row.status !== 'active') enqueue(db, row.owner_id, 'deal', `Объявление «${html(row.title)}» снова на бирже — администратор проверил его.`, 'ads_my');
    } else if (action === 'block') {
      const why = typeof note === 'string' ? note.trim().slice(0, 300) || 'Нарушение правил биржи' : 'Нарушение правил биржи';
      db.run("UPDATE ad_channels SET status = 'blocked', block_reason = ?, updated_at = ? WHERE id = ?", why, ts, id);
      db.run('UPDATE ad_complaints SET resolved_at = ? WHERE channel_id = ? AND resolved_at IS NULL', ts, id);
      enqueue(db, row.owner_id, 'deal', `Объявление «${html(row.title)}» снято с биржи. Причина: ${html(why)}`, 'ads_my');
    } else if (action === 'verify') {
      db.run('UPDATE ad_channels SET verified_at = COALESCE(verified_at, ?), updated_at = ? WHERE id = ?', ts, ts, id);
    } else if (action === 'unverify') {
      db.run('UPDATE ad_channels SET verified_at = NULL, updated_at = ? WHERE id = ?', ts, id);
    } else throw badRequest('Неизвестное действие');
    audit(db, admin.id, `ads.${action}`, 'ad_channel', id, { name: row.title, note });
  });
}

export function adminComplaints(db, channelId) {
  return db.all(
    `SELECT c.reason, c.text, c.created_at, c.resolved_at, u.id user_id, u.username, u.first_name FROM ad_complaints c JOIN users u ON u.id = c.user_id
     WHERE c.channel_id = ? ORDER BY c.created_at DESC`, channelId);
}
