// «Забрать свою карточку»: Линза adds VPN services to the catalog itself; the real owner later
// proves the service is theirs and takes the card over — no new application, no re-typing.
// Ways to prove it: a personal invitation link from the team, a code in the bot's profile,
// making our bot an admin of the service's channel, or a request to an admin.
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { HttpError, badRequest, forbidden, notFound } from './http.js';
import { audit, html, userLabel } from './moderation.js';
import { enqueue, notifyAdmins } from './notify.js';
import { grantRole } from '../auth.js';
import { appLink } from '../config.js';
import { invalidate } from './catalog.js';
import { now, DAY } from './time.js';

export const LINK_TTL = 14 * DAY;
export const CLAIM_TTL = 14 * DAY;
export const CHECK_COOLDOWN = 30_000;
export const CHECKS_PER_HOUR = 10;
const ACTIVE = ['pending', 'manual', 'dispute'];
const HOUR = 3600_000;

const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
const newCode = () => `LINZA-${[...randomBytes(6)].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')}`;
// https://t.me/name → name (lowercase); null for invite links and anything else.
export const tgUsername = (url) => {
  const m = /^https:\/\/t\.me\/([A-Za-z][A-Za-z0-9_]{3,31})(?:[/?#]|$)/.exec(String(url || ''));
  return m ? m[1].toLowerCase() : null;
};
const contactUsername = (contact) => {
  const m = /^@?([A-Za-z][A-Za-z0-9_]{3,31})$/.exec(String(contact || '').trim().replace(/^https?:\/\/t\.me\//i, ''));
  return m ? m[1].toLowerCase() : null;
};

function serviceRow(db, id) {
  const s = db.get('SELECT id, name, logo_url, bot_url, channel_url, support_contact, owner_id, claim_status, added_by, status FROM services WHERE id = ?', id);
  if (!s) throw notFound('Сервис не найден');
  return s;
}

// services.claim_status follows the claims: an owner → claimed, someone proving → pending, else unclaimed.
export function refreshClaimStatus(db, serviceId) {
  const s = db.get('SELECT owner_id FROM services WHERE id = ?', serviceId);
  if (!s) return;
  const status = s.owner_id ? 'claimed'
    : db.get(`SELECT 1 FROM service_claims WHERE service_id = ? AND status IN ('pending', 'manual', 'dispute')`, serviceId) ? 'pending' : 'unclaimed';
  db.run('UPDATE services SET claim_status = ? WHERE id = ?', status, serviceId);
}

export function claimRow(db, id) {
  const c = db.get('SELECT * FROM service_claims WHERE id = ?', id);
  if (!c) throw notFound('Заявка не найдена');
  return c;
}

/* ---------------- Invitation links ---------------- */

// Admin: a one-time personal link (14 days) to send in the invitation. Only the hash is stored;
// the token is "<id>-<secret>", so the row is found by id and the secret compared in constant time.
export function createClaimLink(db, admin, serviceId, ts = now()) {
  const svc = serviceRow(db, serviceId);
  if (svc.owner_id) throw badRequest('У карточки уже есть владелец');
  const secret = randomBytes(24).toString('base64url');
  let id;
  db.tx(() => {
    db.run("UPDATE service_claims SET status = 'expired' WHERE service_id = ? AND status = 'invited'", serviceId);
    id = Number(db.run("INSERT INTO service_claims (service_id, method, token_hash, status, created_at, expires_at) VALUES (?, 'link', ?, 'invited', ?, ?)",
      serviceId, sha256(secret), ts, ts + LINK_TTL).lastInsertRowid);
    audit(db, admin.id, 'claim.link', 'service', serviceId, { name: svc.name });
  });
  const token = `${id}-${secret}`;
  return { token, link: appLink(`claim_${token}`), expires_at: ts + LINK_TTL };
}

function linkRow(db, token, ts = now()) {
  const m = /^(\d{1,9})-([A-Za-z0-9_-]{20,64})$/.exec(String(token || ''));
  const row = m ? db.get("SELECT * FROM service_claims WHERE id = ? AND method = 'link'", Number(m[1])) : null;
  const ok = row?.token_hash && timingSafeEqual(Buffer.from(row.token_hash, 'hex'), Buffer.from(sha256(m[2]), 'hex'));
  if (!ok) throw badRequest('Ссылка недействительна — попросите новую у команды Линзы');
  if (row.status !== 'invited') throw badRequest('Эта ссылка уже использована');
  if (row.expires_at < ts) {
    db.run("UPDATE service_claims SET status = 'expired' WHERE id = ?", row.id);
    throw badRequest('Срок действия ссылки истёк — попросите новую у команды Линзы');
  }
  return row;
}

// What the invitation is for, without using it up (the claim screen shows this first).
export function previewLink(db, token) {
  const row = linkRow(db, token);
  const s = serviceRow(db, row.service_id);
  return { service: { id: s.id, name: s.name, logo_url: s.logo_url }, expires_at: row.expires_at, claimed: Boolean(s.owner_id) };
}

// The personal link is itself the proof: the team sent it to the owner directly.
export function claimByLink(db, user, token, { envAdmins = [] } = {}) {
  const row = linkRow(db, token);
  const svc = serviceRow(db, row.service_id);
  if (svc.owner_id === user.id) return { status: 'owner', service_id: svc.id };
  if (svc.owner_id) {
    // Someone took the card meanwhile: the invitee's word against theirs goes to an admin.
    db.tx(() => {
      db.run("UPDATE service_claims SET user_id = ?, status = 'dispute', note = ? WHERE id = ?", user.id, 'Пришёл по ссылке-приглашению, а карточку уже подтвердил другой пользователь', row.id);
      notifyAdmins(db, envAdmins, `⚖️ Спор о владении «${html(svc.name)}»: ${html(userLabel(db, user.id))} пришёл по ссылке-приглашению, но карточку уже подтвердил ${html(userLabel(db, svc.owner_id))}.`,
        `admin_services_${svc.id}`, 'Открыть карточку');
    });
    return { status: 'dispute', service_id: svc.id, claim_id: row.id };
  }
  db.run('UPDATE service_claims SET user_id = ? WHERE id = ?', user.id, row.id);
  approveClaim(db, row.id, { method: 'link', envAdmins });
  return { status: 'approved', service_id: svc.id, claim_id: row.id };
}

/* ---------------- Claims started from the card ---------------- */

// One active claim per person per card (opening the screen again returns it). Several people
// may try at once — the first proof wins, so nobody can block a card by starting a claim.
export function startClaim(db, user, serviceId, { dispute = false, note = null, envAdmins = [] } = {}, ts = now()) {
  const svc = serviceRow(db, serviceId);
  if (svc.owner_id === user.id) return { status: 'owner', service_id: svc.id };
  const mine = db.get(`SELECT * FROM service_claims WHERE service_id = ? AND user_id = ? AND status IN ('pending', 'manual', 'dispute') ORDER BY id DESC LIMIT 1`, serviceId, user.id);
  if (mine && !(svc.owner_id && dispute && mine.status !== 'dispute')) return { claim_id: mine.id };
  if (svc.owner_id) {
    if (!dispute) return { status: 'claimed_by_other', service_id: svc.id };
    const text = typeof note === 'string' ? note.trim().slice(0, 500) : '';
    if (text.length < 10) throw badRequest('Опишите в паре предложений, почему сервис ваш — администратор свяжется с вами');
    let id;
    db.tx(() => {
      if (mine) db.run("UPDATE service_claims SET status = 'superseded' WHERE id = ?", mine.id);
      id = Number(db.run("INSERT INTO service_claims (service_id, user_id, method, status, created_at, note) VALUES (?, ?, 'manual', 'dispute', ?, ?)",
        serviceId, user.id, ts, text).lastInsertRowid);
      notifyAdmins(db, envAdmins, `⚖️ Спор о владении «${html(svc.name)}»: ${html(userLabel(db, user.id))} считает сервис своим, а карточку уже подтвердил ${html(userLabel(db, svc.owner_id))}.\n\n«${html(text)}»`,
        `admin_services_${svc.id}`, 'Открыть карточку');
    });
    return { claim_id: id };
  }
  if (db.get(`SELECT COUNT(*) n FROM service_claims WHERE user_id = ? AND status IN ('pending', 'manual', 'dispute')`, user.id).n >= 5) {
    throw new HttpError(429, 'Слишком много открытых заявок — завершите начатые', 'rate_limited');
  }
  let id;
  db.tx(() => {
    id = Number(db.run("INSERT INTO service_claims (service_id, user_id, method, code, status, created_at, expires_at) VALUES (?, ?, 'code', ?, 'pending', ?, ?)",
      serviceId, user.id, newCode(), ts, ts + CLAIM_TTL).lastInsertRowid);
    refreshClaimStatus(db, serviceId);
  });
  return { claim_id: id };
}

function ownClaim(db, user, id) {
  const c = claimRow(db, id);
  if (c.user_id !== user.id) throw forbidden('Это не ваша заявка');
  return c;
}

/* ---------------- a) Code in the bot's profile ---------------- */

// The text under the bot's name on t.me/<bot> — the «About» text set with @BotFather → /setabouttext.
export function profileDescription(page) {
  const block = /<div class="tgme_page_description[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(page)?.[1]
    ?? /<meta property="og:description" content="([^"]*)"/i.exec(page)?.[1] ?? '';
  return block.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ').trim();
}

const fetchPage = async (url) => {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; LinzaBot/1.0)' }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
};

export async function checkCode(db, user, claimId, { load = fetchPage, envAdmins = [], ts = now() } = {}) {
  const c = ownClaim(db, user, claimId);
  if (!['pending', 'manual'].includes(c.status)) throw badRequest('Заявка уже закрыта');
  const last = db.get('SELECT MAX(created_at) t FROM claim_checks WHERE claim_id = ?', c.id).t;
  if (last && ts - last < CHECK_COOLDOWN) {
    throw new HttpError(429, `Проверить снова можно через ${Math.ceil((CHECK_COOLDOWN - (ts - last)) / 1000)} с`, 'rate_limited');
  }
  if (db.get('SELECT COUNT(*) n FROM claim_checks WHERE user_id = ? AND created_at > ?', user.id, ts - HOUR).n >= CHECKS_PER_HOUR) {
    throw new HttpError(429, 'Не больше 10 проверок в час — попробуйте позже или отправьте заявку администратору', 'rate_limited');
  }
  const svc = serviceRow(db, c.service_id);
  const bot = tgUsername(svc.bot_url);
  if (!bot) throw badRequest('У карточки нет ссылки на бота — отправьте заявку администратору');
  const checkId = Number(db.run('INSERT INTO claim_checks (claim_id, user_id, created_at) VALUES (?, ?, ?)', c.id, user.id, ts).lastInsertRowid);
  let text;
  try {
    text = profileDescription(await load(`https://t.me/${bot}`));
  } catch {
    throw new HttpError(502, 'Не удалось открыть страницу бота в Telegram — попробуйте через минуту', 'upstream');
  }
  const found = text.toUpperCase().replace(/\s+/g, '').includes(c.code);
  if (!found) return { approved: false, retry_at: ts + CHECK_COOLDOWN, profile_empty: !text };
  db.run('UPDATE claim_checks SET found = 1 WHERE id = ?', checkId);
  return finishAutomatic(db, c, 'code', envAdmins);
}

/* ---------------- b) Our bot made an admin of the service's channel ---------------- */

// Called on my_chat_member: the person who added the bot has an open claim on a card whose
// official channel is this one. Returns the claims it settled.
export function verifyByChannel(db, fromId, chat, { envAdmins = [] } = {}) {
  const username = chat.username ? String(chat.username).toLowerCase() : null;
  if (!username) return [];
  const claims = db.all(
    `SELECT c.* FROM service_claims c JOIN services s ON s.id = c.service_id
     WHERE c.user_id = ? AND c.status IN ('pending', 'manual') AND s.channel_url IS NOT NULL`, fromId)
    .filter((c) => tgUsername(db.get('SELECT channel_url FROM services WHERE id = ?', c.service_id).channel_url) === username);
  return claims.map((c) => finishAutomatic(db, c, 'channel', envAdmins));
}

// An automatic proof on a card someone else already holds becomes a dispute for an admin.
function finishAutomatic(db, c, method, envAdmins) {
  const svc = serviceRow(db, c.service_id);
  if (svc.owner_id && svc.owner_id !== c.user_id) {
    db.tx(() => {
      db.run("UPDATE service_claims SET status = 'dispute', method = ?, note = ? WHERE id = ?", method, `Подтвердил${method === 'code' ? ' кодом в профиле бота' : ' через канал'}, но карточка уже у другого владельца`, c.id);
      notifyAdmins(db, envAdmins, `⚖️ Спор о владении «${html(svc.name)}»: ${html(userLabel(db, c.user_id))} подтвердил владение${method === 'code' ? ' кодом в профиле бота' : ' через канал сервиса'}, но карточку уже подтвердил ${html(userLabel(db, svc.owner_id))}.`,
        `admin_services_${svc.id}`, 'Открыть карточку');
    });
    return { approved: false, status: 'dispute', service_id: svc.id };
  }
  approveClaim(db, c.id, { method, envAdmins });
  return { approved: true, status: 'approved', service_id: svc.id };
}

/* ---------------- c) An admin decides ---------------- */

export function requestManual(db, user, claimId, note, { envAdmins = [] } = {}) {
  const c = ownClaim(db, user, claimId);
  if (c.status !== 'pending') throw badRequest(c.status === 'manual' ? 'Заявка уже у администратора' : 'Заявка уже закрыта');
  const text = typeof note === 'string' ? note.trim().slice(0, 500) || null : null;
  const svc = serviceRow(db, c.service_id);
  db.tx(() => {
    db.run("UPDATE service_claims SET status = 'manual', method = 'manual', note = ? WHERE id = ?", text, c.id);
    notifyAdmins(db, envAdmins, `🙋 Заявка на подтверждение «${html(svc.name)}» от ${html(userLabel(db, user.id))}.${text ? `\n\n«${html(text)}»` : ''}`,
      `admin_services_${svc.id}`, 'Открыть карточку');
    enqueue(db, user.id, 'moderation', `📨 Заявка на «${html(svc.name)}» у администратора. Он свяжется с вами, если понадобятся подробности, — ответ придёт сюда.`, `claimsvc_${svc.id}`, 'Открыть заявку');
  });
}

export function decideClaim(db, admin, claimId, approve, reason = null, { envAdmins = [] } = {}) {
  const c = claimRow(db, claimId);
  if (!ACTIVE.includes(c.status)) throw new HttpError(409, 'Заявка уже закрыта', 'conflict');
  // An admin's decision is a manual proof, whatever the person tried before.
  if (approve) return approveClaim(db, c.id, { method: c.method === 'link' ? 'link' : 'manual', adminId: admin.id, envAdmins });
  const why = typeof reason === 'string' ? reason.trim().slice(0, 300) : '';
  if (why.length < 3) throw badRequest('Укажите причину');
  const svc = serviceRow(db, c.service_id);
  db.tx(() => {
    db.run("UPDATE service_claims SET status = 'rejected', decided_at = ?, decided_by = ?, note = ? WHERE id = ?", now(), admin.id, why, c.id);
    refreshClaimStatus(db, c.service_id);
    audit(db, admin.id, 'claim.reject', 'service', c.service_id, { name: svc.name, user: c.user_id, reason: why });
    enqueue(db, c.user_id, 'moderation', `Заявка на «${html(svc.name)}» отклонена.\nПричина: ${html(why)}`, `claimsvc_${svc.id}`, 'Открыть заявку');
  });
  return { status: 'rejected' };
}

/* ---------------- Approval ---------------- */

// The card changes hands; its data, reviews and statistics stay as they were.
export function approveClaim(db, claimId, { method, adminId = null, envAdmins = [] } = {}) {
  const ts = now();
  return db.tx(() => {
    const c = claimRow(db, claimId);
    const svc = serviceRow(db, c.service_id);
    const prev = svc.owner_id;
    db.run("UPDATE services SET owner_id = ?, claim_status = 'claimed' WHERE id = ?", c.user_id, svc.id);
    db.run("UPDATE service_claims SET status = 'approved', method = ?, decided_at = ?, decided_by = ? WHERE id = ?", method, ts, adminId, c.id);
    grantRole(db, c.user_id, 'vpn_owner');
    db.run("UPDATE users SET active_role = 'vpn_owner' WHERE id = ?", c.user_id);
    for (const o of db.all(`SELECT id, user_id FROM service_claims WHERE service_id = ? AND id != ? AND status IN ('pending', 'manual', 'dispute', 'invited')`, svc.id, c.id)) {
      db.run("UPDATE service_claims SET status = 'superseded', decided_at = ? WHERE id = ?", ts, o.id);
      if (o.user_id) enqueue(db, o.user_id, 'moderation', `Карточку «${html(svc.name)}» подтвердил другой пользователь. Если сервис ваш — откройте заявку и опишите ситуацию, администратор разберётся.`, `claimsvc_${svc.id}`, 'Открыть заявку');
    }
    if (prev && prev !== c.user_id) {
      enqueue(db, prev, 'moderation', `Карточка «${html(svc.name)}» передана другому владельцу по решению администратора.`, null);
    }
    audit(db, adminId, 'claim.approve', 'service', svc.id, { name: svc.name, user: c.user_id, method, from: prev });
    enqueue(db, c.user_id, 'moderation',
      `🎉 Карточка «${html(svc.name)}» теперь ваша. Проверьте тарифы и добавьте логотип — правки публикуются после модерации.`, `owner_${svc.id}`, 'Открыть кабинет');
    if (!adminId) {
      const how = { link: 'по ссылке-приглашению', code: 'кодом в профиле бота', channel: 'через канал сервиса' }[method] || '';
      notifyAdmins(db, envAdmins, `✅ Карточку «${html(svc.name)}» забрал владелец ${html(userLabel(db, c.user_id))}${how ? ` — ${how}` : ''}.`, `admin_services_${svc.id}`, 'Открыть карточку');
    }
    invalidate();
    return { status: 'approved', service_id: svc.id };
  });
}

/* ---------------- Views & housekeeping ---------------- */

export function claimView(db, user, claimId, { botUsername = '' } = {}, ts = now()) {
  const c = ownClaim(db, user, claimId);
  const s = serviceRow(db, c.service_id);
  const last = db.get('SELECT MAX(created_at) t FROM claim_checks WHERE claim_id = ?', c.id).t;
  const used = db.get('SELECT COUNT(*) n FROM claim_checks WHERE user_id = ? AND created_at > ?', user.id, ts - HOUR).n;
  return {
    id: c.id, status: c.status, method: c.method, note: c.note, created_at: c.created_at, expires_at: c.expires_at,
    code: ['pending', 'manual'].includes(c.status) ? c.code : null,
    next_check_at: last ? last + CHECK_COOLDOWN : null,
    checks_left: Math.max(0, CHECKS_PER_HOUR - used),
    our_bot: botUsername,
    service: { id: s.id, name: s.name, logo_url: s.logo_url, bot: tgUsername(s.bot_url), channel: tgUsername(s.channel_url), mine: s.owner_id === user.id }
  };
}

// Cards Линза added whose contact is this person's @username — only a hint, proof is still required.
export function claimSuggestions(db, user) {
  const me = user.username ? String(user.username).toLowerCase() : null;
  if (!me) return [];
  return db.all("SELECT id, name, logo_url, support_contact FROM services WHERE owner_id IS NULL AND status = 'published' AND hidden = 0 AND support_contact IS NOT NULL")
    .filter((s) => contactUsername(s.support_contact) === me)
    .map(({ support_contact, ...s }) => s);
}

export function expireClaims(db, ts = now()) {
  const stale = db.all(`SELECT id, service_id FROM service_claims WHERE status IN ('invited', 'pending') AND expires_at IS NOT NULL AND expires_at < ?`, ts);
  for (const c of stale) {
    db.run("UPDATE service_claims SET status = 'expired' WHERE id = ?", c.id);
    refreshClaimStatus(db, c.service_id);
  }
  return stale.length;
}
