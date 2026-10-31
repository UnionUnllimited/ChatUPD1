import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { upsertUser, loadUser } from '../server/auth.js';
import { setClock, DAY } from '../server/lib/time.js';
import { invalidate } from '../server/lib/catalog.js';
import { validateCard } from '../server/lib/validate.js';
import { createService } from '../server/lib/adminops.js';
import { ownedService } from '../server/lib/moderation.js';
import {
  createClaimLink, previewLink, claimByLink, startClaim, checkCode, verifyByChannel, requestManual, decideClaim,
  claimView, claimSuggestions, expireClaims, profileDescription
} from '../server/lib/claims.js';
import { importServices } from '../server/lib/importer.js';

const T0 = Date.UTC(2026, 10, 2, 9);
let db, clock, admin, svc;
const at = (ts) => { clock = ts; setClock(() => clock); };
const env = { envAdmins: [1] };
const user = (id, username = `user${id}`) => { upsertUser(db, { id, first_name: `U${id}`, username }); return loadUser(db, id, [1]); };
const reload = (u) => loadUser(db, u.id, [1]);
const service = () => db.get('SELECT owner_id, claim_status, added_by FROM services WHERE id = ?', svc);
const last = (id) => db.get('SELECT text, start_param, button FROM notifications WHERE user_id = ? ORDER BY id DESC', id);
const page = (about) => `<html><div class="tgme_page_title">VPN</div><div class="tgme_page_description ">${about}</div></html>`;

beforeEach(() => {
  at(T0);
  db = openDb(':memory:');
  invalidate();
  admin = user(1, 'admin');
  svc = createService(db, admin, validateCard({
    name: 'Северный ветер', bot_url: '@veter_vpn_bot', channel_url: '@veter_vpn', support_contact: '@veter_owner',
    devices: 3, tariffs: { 1: 199 }, protocols: ['vless'], countries: ['nl'], platforms: ['ios'], payments: ['sbp']
  }), { checkedAt: T0 - 3 * DAY });
});

test('an admin-added card starts unclaimed with its check date', () => {
  assert.deepEqual({ ...service() }, { owner_id: null, claim_status: 'unclaimed', added_by: 'admin' });
  assert.equal(db.get('SELECT data_checked_at FROM services WHERE id = ?', svc).data_checked_at, T0 - 3 * DAY);
});

test('invitation link: one tap takes the card; single use, 14 days, constant-time checked', () => {
  const { token, link } = createClaimLink(db, admin, svc);
  assert.match(link, /\?startapp=claim_\d+-[\w-]+$/);
  assert.ok(link.split('startapp=')[1].length <= 64); // Telegram's startapp limit
  assert.equal(db.get('SELECT token_hash FROM service_claims').token_hash.length, 64); // only the hash is stored
  assert.equal(previewLink(db, token).service.name, 'Северный ветер');
  assert.throws(() => previewLink(db, token.slice(0, -2) + 'xx'), /недействительна/);
  const owner = user(10);
  assert.throws(() => ownedService(db, owner, svc), /не ваш/);
  assert.equal(claimByLink(db, owner, token, env).status, 'approved');
  assert.deepEqual({ ...service() }, { owner_id: 10, claim_status: 'claimed', added_by: 'admin' });
  const me = reload(owner);
  assert.ok(me.roles.includes('vpn_owner'));
  assert.equal(me.active_role, 'vpn_owner');
  assert.equal(ownedService(db, me, svc).id, svc);
  assert.throws(() => ownedService(db, user(11), svc), /не ваш/);
  assert.match(last(10).text, /теперь ваша\. Проверьте тарифы и добавьте логотип/);
  assert.equal(last(10).button, 'Открыть кабинет');
  assert.throws(() => claimByLink(db, user(12), token, env), /уже использована/);
});

test('an expired link is refused', () => {
  const { token } = createClaimLink(db, admin, svc);
  at(T0 + 15 * DAY);
  assert.throws(() => claimByLink(db, user(10), token, env), /истёк/);
});

test('code in the bot profile: cooldown, hourly limit, then proof', async () => {
  const u = user(20);
  const { claim_id: id } = startClaim(db, u, svc, env);
  assert.equal(startClaim(db, u, svc, env).claim_id, id); // one active claim per person per card
  assert.equal(service().claim_status, 'pending');
  const { code } = claimView(db, u, id);
  assert.match(code, /^LINZA-[A-Z2-9]{6}$/);
  const urls = [];
  let about = 'Быстрый VPN';
  const load = async (url) => { urls.push(url); return page(about); };
  assert.equal((await checkCode(db, u, id, { load })).approved, false);
  assert.equal(urls[0], 'https://t.me/veter_vpn_bot');
  await assert.rejects(checkCode(db, u, id, { load }), /через \d+ с/);
  about = `Быстрый VPN.<br>${code.toLowerCase()}`;
  at(T0 + 31_000);
  assert.equal((await checkCode(db, u, id, { load, ...env })).approved, true);
  assert.equal(service().owner_id, 20);
  assert.match(last(1).text, /забрал владелец @user20 — кодом в профиле бота/);
  // The hourly limit, on another person's attempts.
  const v = user(21);
  const { claim_id: other } = startClaim(db, v, createService(db, admin, validateCard({ name: 'Второй', bot_url: '@second_vpn_bot', devices: 1, tariffs: { 1: 100 }, protocols: ['vless'], countries: ['nl'], platforms: ['ios'], payments: ['sbp'] }), {}));
  for (let i = 0; i < 10; i++) { at(T0 + 100_000 + i * 31_000); await checkCode(db, v, other, { load: async () => page('') }); }
  at(T0 + 100_000 + 10 * 31_000);
  await assert.rejects(checkCode(db, v, other, { load }), /10 проверок в час/);
});

test('profile text is read from the page, entities decoded', () => {
  assert.equal(profileDescription(page('Код: LINZA-AB12CD &amp; поддержка<br/>24/7')), 'Код: LINZA-AB12CD & поддержка 24/7');
  assert.equal(profileDescription('<meta property="og:description" content="LINZA-QWERTY">'), 'LINZA-QWERTY');
});

test('channel: our bot made an admin of the card\'s channel settles the claim', () => {
  const u = user(30);
  const { claim_id: id } = startClaim(db, u, svc, env);
  assert.deepEqual(verifyByChannel(db, 30, { id: -1001, username: 'other_channel' }, env), []);
  assert.deepEqual(verifyByChannel(db, 31, { id: -1002, username: 'Veter_VPN' }, env), []); // someone without a claim
  assert.equal(verifyByChannel(db, 30, { id: -1002, username: 'Veter_VPN' }, env)[0].approved, true);
  assert.equal(db.get('SELECT method, status FROM service_claims WHERE id = ?', id).method, 'channel');
});

test('manual: an admin approves in one click or rejects with a reason', () => {
  const u = user(40);
  const { claim_id: id } = startClaim(db, u, svc, env);
  requestManual(db, u, id, 'Я владелец, могу показать панель бота', env);
  assert.equal(last(1).start_param, `admin_services_${svc}`);
  assert.match(last(1).text, /Заявка на подтверждение «Северный ветер» от @user40/);
  assert.throws(() => decideClaim(db, admin, id, false, ''), /причину/);
  decideClaim(db, admin, id, true);
  assert.equal(service().owner_id, 40);
  assert.deepEqual({ ...db.get('SELECT decided_by, method FROM service_claims WHERE id = ?', id) }, { decided_by: 1, method: 'manual' });
  // Rejection path on another card.
  const s2 = createService(db, admin, validateCard({ name: 'Третий', bot_url: '@third_vpn_bot', devices: 1, tariffs: { 1: 100 }, protocols: ['vless'], countries: ['nl'], platforms: ['ios'], payments: ['sbp'] }), {});
  const w = user(41);
  const { claim_id: c2 } = startClaim(db, w, s2, env);
  requestManual(db, w, c2, null, env);
  decideClaim(db, admin, c2, false, 'Не удалось связаться по контакту из карточки');
  assert.match(last(41).text, /отклонена\.\nПричина: Не удалось связаться/);
  assert.equal(db.get('SELECT claim_status FROM services WHERE id = ?', s2).claim_status, 'unclaimed');
});

test('someone else claiming a taken card opens a dispute for an admin', async () => {
  const { token } = createClaimLink(db, admin, svc);
  claimByLink(db, user(50), token, env);
  const b = user(51);
  assert.equal(startClaim(db, b, svc, env).status, 'claimed_by_other');
  assert.throws(() => startClaim(db, b, svc, { dispute: true, note: 'мой' }), /Опишите/);
  const { claim_id: id } = startClaim(db, b, svc, { dispute: true, note: 'Это мой сервис, у меня доступ к боту и каналу', ...env });
  assert.equal(db.get('SELECT status FROM service_claims WHERE id = ?', id).status, 'dispute');
  assert.match(last(1).text, /Спор о владении «Северный ветер»/);
  // The admin sides with the newcomer: the card changes hands and the previous owner is told.
  decideClaim(db, admin, id, true);
  assert.equal(service().owner_id, 51);
  assert.match(last(50).text, /передана другому владельцу/);
});

test('a code proof on a card that was taken meanwhile becomes a dispute', async () => {
  const u = user(60);
  const { claim_id: id } = startClaim(db, u, svc, env);
  const { token } = createClaimLink(db, admin, svc);
  claimByLink(db, user(61), token, env); // supersedes 60's claim…
  assert.equal(db.get('SELECT status FROM service_claims WHERE id = ?', id).status, 'superseded');
  assert.match(last(60).text, /подтвердил другой пользователь/);
});

test('username hint, expiry', () => {
  assert.deepEqual(claimSuggestions(db, user(70, 'Veter_Owner')).map((s) => s.id), [svc]);
  assert.deepEqual(claimSuggestions(db, user(71, 'someone')), []);
  startClaim(db, user(72), svc, env);
  createClaimLink(db, admin, svc);
  assert.equal(expireClaims(db, T0 + 15 * DAY), 2);
  assert.equal(service().claim_status, 'unclaimed');
});

test('import: CSV with Russian headers and names, JSON, dry run, row errors', () => {
  const csv = [
    'Название;Бот;1;12;Протоколы;Страны;Устройства;Триал;Оплата;Платформы;Контакт;Дата сверки',
    'Альфа VPN;@alpha_vpn_bot;199;1990;VLESS Reality, WireGuard;Нидерланды, de;5;3;СБП, Stars;iOS, Android;@alpha;01.10.2026',
    'Бета;@beta_vpn_bot;149;;Outline;Финляндия;3;нет;Карта РФ;Windows;;2026-10-15',
    'Гамма;@gamma_vpn_bot;99;;Квантовый;Нидерланды;1;;СБП;iOS;;'
  ].join('\n');
  const dry = importServices(db, admin, csv, { dryRun: true });
  assert.equal(dry.ok.length, 2);
  assert.equal(db.get("SELECT COUNT(*) n FROM services").n, 1); // nothing written
  const r = importServices(db, admin, csv, {});
  assert.deepEqual(r.created.map((c) => c.name), ['Альфа VPN', 'Бета']);
  assert.deepEqual(r.errors.map((e) => [e.line, e.error]), [[4, 'Неизвестное значение «Квантовый» в поле «Протоколы»']]);
  const a = db.get('SELECT * FROM services WHERE name = ?', 'Альфа VPN');
  assert.equal(a.claim_status, 'unclaimed');
  assert.equal(a.trial_days, 3);
  assert.equal(a.support_contact, '@alpha');
  assert.deepEqual(JSON.parse(a.protocols), ['vless_reality', 'wireguard']);
  assert.equal(new Date(a.data_checked_at).toISOString().slice(0, 10), '2026-10-01');
  // Again: duplicates are reported, not doubled. JSON works too.
  assert.match(importServices(db, admin, csv, {}).errors[0].error, /уже есть/);
  const json = JSON.stringify([{ name: 'Дельта', bot: '@delta_vpn_bot', tariffs: { 3: 450 }, protocols: ['trojan'], countries: ['se'], platforms: ['android'], payments: ['crypto'], devices: 2 }]);
  assert.equal(importServices(db, admin, json, {}).created.length, 1);
});

test('bot update: making the bot an admin of the card\'s channel settles the claim', async () => {
  const { createBot } = await import('../server/lib/bot.js');
  const u = user(90);
  startClaim(db, u, svc, env);
  const bot = createBot({ botToken: '', adminIds: [1], webAppUrl: '' }, { warn() {}, info() {}, error() {} });
  await bot.handleUpdate(db, { my_chat_member: { chat: { id: -1009, type: 'channel', username: 'veter_vpn', title: 'Ветер' }, from: { id: 90 }, new_chat_member: { status: 'administrator' } } });
  assert.equal(service().owner_id, 90);
});

test('import of the catalog file: partial cards, logos, audience, notes; the catalog handles unknown parts', async () => {
  const { readFileSync, mkdtempSync, readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { snapshot, filterItems, parseFilters } = await import('../server/lib/catalog.js');
  const { pickServices, parseAnswers } = await import('../server/lib/pick.js');
  const { copyLogos } = await import('../server/lib/importer.js');
  const text = readFileSync(new URL('../seed/catalog/lens-2026-10-31.json', import.meta.url), 'utf8');
  const r = importServices(db, admin, text, {});
  assert.equal(r.created.length, 15);
  assert.deepEqual(r.errors, []);
  const happy = db.get("SELECT * FROM services WHERE name = 'Happy VPN'");
  assert.deepEqual(JSON.parse(happy.missing), ['tariffs', 'devices', 'protocols', 'countries', 'payments']);
  assert.equal(happy.logo_url, 'https://t.me/i/userpic/320/happyvpn.jpg');
  assert.equal(happy.users_monthly, 496243);
  assert.equal(happy.claim_status, 'unclaimed');
  assert.equal(happy.trial_days, 3);
  const nash = db.get("SELECT * FROM services WHERE name = 'NashVPN'");
  assert.equal(nash.min_monthly, 224);
  assert.ok(JSON.parse(nash.countries).includes('ie'));
  assert.match(nash.admin_note, /1 Гбит/);
  assert.equal(db.get("SELECT trial, trial_days FROM services WHERE name = 'VoxGate VPN'").trial, 1);
  assert.equal(db.get("SELECT site_url FROM services WHERE name = 'VPNUS VPN'").site_url, 'https://dostup.cx');
  assert.equal(db.get("SELECT missing FROM services WHERE name = 'Midas VPN'").missing, null);
  // Catalog: unknown devices are null, unknown prices go last and never match a price filter or a budget.
  invalidate();
  const snap = snapshot(db);
  assert.equal(snap.items.find((s) => s.name === 'Happy VPN').devices, null);
  const byPrice = filterItems(snap.items, parseFilters({ sort: 'price' })).map((s) => s.min_monthly);
  assert.ok(byPrice.indexOf(null) > byPrice.lastIndexOf(224));
  assert.ok(filterItems(snap.items, parseFilters({ price_max: '300' })).every((s) => s.min_monthly !== null));
  assert.ok(pickServices(snap.items, parseAnswers({ device: 'any', devices: '1', whitelist: 'no', payment: 'any', budget: '300' })).items.every((s) => s.min_monthly !== null));
  // Telegram avatars are copied to uploads.
  const dir = mkdtempSync(join(tmpdir(), 'linza-logos-'));
  const fake = async () => ({ ok: true, headers: new Map([['content-type', 'image/jpeg']]), arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]).buffer });
  assert.equal(await copyLogos(db, r.created.slice(0, 2), { uploadsDir: dir, load: fake }), 2);
  assert.match(db.get("SELECT logo_url FROM services WHERE name = 'Happy VPN'").logo_url, /^\/uploads\/logo-\d+-[0-9a-f]{10}\.jpg$/);
  assert.equal(readdirSync(dir).length, 2);
});

test('owners still fill in the whole card', () => {
  assert.throws(() => validateCard({ name: 'Неполный', bot_url: '@half_vpn_bot', devices: 1, tariffs: {}, protocols: [], countries: [], platforms: [], payments: [] }), /тариф/);
  assert.deepEqual(validateCard({ name: 'Неполный', bot_url: '@half_vpn_bot', tariffs: {} }, { partial: true }).missing, ['tariffs', 'devices', 'protocols', 'countries', 'platforms', 'payments']);
});
