import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { upsertUser, loadUser, grantRole } from '../server/auth.js';
import { setClock, DAY } from '../server/lib/time.js';
import {
  validateChannel, parseChannelLink, cpmOf, cpmLight, createChannel, updateChannel, listChannels, channelDetail, bookDeal,
  decideDeal, cancelDeal, markPublished, reviewDeal, dealRow, dealView, askReviews, complain, verifyChannel, unverifyChannel,
  adminSetChannel, myChannels, setFavorite
} from '../server/lib/ads.js';

const T0 = Date.UTC(2026, 10, 2, 9); // 2 Nov 2026, 12:00 MSK
let db, clock;
const at = (ts) => { clock = ts; setClock(() => clock); };
const day = (n) => new Date(T0 + n * DAY + 3 * 3600_000).toISOString().slice(0, 10);

function user(id, roles = []) {
  upsertUser(db, { id, first_name: `U${id}`, username: `user${id}`, allows_write_to_pm: true });
  for (const r of roles) grantRole(db, id, r);
  return loadUser(db, id, [1]);
}
const listing = (over = {}) => ({
  link: '@bubser_brawl', title: 'Бубсер | Бравл Старс', topic: 'games', subscribers: 195000, reach_24: 22000, reach_48: 29000,
  formats: { '1/24': 6000, '2/48': 9000, pack: 30000 }, free_dates: [day(3), day(5)], had_vpn: true, contact: '@bubser_ads', ...over
});

beforeEach(() => {
  at(T0);
  db = openDb(':memory:');
  user(1, ['admin']);
});

test('links, validation and CPM with the traffic light', () => {
  assert.deepEqual(parseChannelLink('https://t.me/Bubser_Brawl'), { link: 'https://t.me/Bubser_Brawl', username: 'bubser_brawl' });
  assert.deepEqual(parseChannelLink('t.me/+AbCdEfGh123'), { link: 'https://t.me/+AbCdEfGh123', username: null });
  assert.equal(parseChannelLink('бубсер'), null);
  assert.throws(() => validateChannel(listing({ reach_48: 100 })), /48 часов/);
  assert.throws(() => validateChannel(listing({ formats: {} })), /формат/);
  assert.throws(() => validateChannel(listing({ stats_url: 'https://example.com/x' })), /Telemetr или TGStat/);
  const v = validateChannel(listing({ free_dates: [day(-1), day(3), day(3), day(120)] }));
  assert.deepEqual(v.free_dates, [day(3)]);
  // 6000 ₽ / 22 000 views × 1000 = 273 ₽ — the mock's "норма".
  assert.equal(cpmOf('1/24', 6000, v), 273);
  assert.equal(cpmOf('2/48', 9000, v), 310);
  assert.equal(cpmOf('pack', 30000, v), null);
  const cfg = { cpm_good: 250, cpm_ok: 350 };
  assert.deepEqual([200, 273, 400].map((c) => cpmLight(c, cfg)), ['good', 'ok', 'high']);
});

test('feed: filters and sorting by CPM, reach and rating', () => {
  const s1 = user(10), s2 = user(11);
  createChannel(db, s1, listing());
  createChannel(db, s2, listing({ link: '@memes', title: 'Мемы', topic: 'humor', reach_24: 50000, reach_48: 60000, formats: { '1/24': 7500 }, free_dates: [day(4)], had_vpn: false }));
  const feed = (q = {}) => listChannels(db, q, null).items.map((c) => c.title);
  assert.deepEqual(feed(), ['Мемы', 'Бубсер | Бравл Старс']); // CPM 150 before 273
  assert.deepEqual(feed({ sort: 'reach' }), ['Мемы', 'Бубсер | Бравл Старс']);
  assert.deepEqual(feed({ topics: 'games' }), ['Бубсер | Бравл Старс']);
  assert.deepEqual(feed({ format: '2/48' }), ['Бубсер | Бравл Старс']);
  assert.deepEqual(feed({ cpm_max: '200' }), ['Мемы']);
  assert.deepEqual(feed({ date: day(5) }), ['Бубсер | Бравл Старс']);
  assert.deepEqual(feed({ had_vpn: '1' }), ['Бубсер | Бравл Старс']);
  assert.deepEqual(feed({ verified: '1' }), []);
  const card = listChannels(db, {}, null).items[1];
  assert.equal(card.best.id, '1/24');
  assert.equal(card.best.light, 'ok');
  assert.equal(card.contact, undefined); // never in the feed
  assert.equal(db.get("SELECT 1 FROM user_roles WHERE user_id = 10 AND role = 'ad_seller'") !== undefined, true);
});

test('booking: only VPN owners, offered formats and free dates; contacts open after the seller agrees', () => {
  const seller = user(10);
  const { id: ch } = createChannel(db, seller, listing());
  const client = user(20);
  const buyer = user(21, ['vpn_owner']);
  assert.throws(() => bookDeal(db, client, ch, { format: '1/24', date: day(3) }), /владельцы VPN/);
  assert.throws(() => bookDeal(db, buyer, ch, { format: '1/48', date: day(3) }), /формат/);
  assert.throws(() => bookDeal(db, buyer, ch, { format: '1/24', date: day(4) }), /свободных/);
  const { id } = bookDeal(db, buyer, ch, { format: '1/24', date: day(3), comment: 'Про VPN для игр' });
  assert.throws(() => bookDeal(db, buyer, ch, { format: '2/48', date: day(5) }), /уже есть открытая заявка/);
  const note = db.get("SELECT text, start_param FROM notifications WHERE user_id = 10 AND type = 'deal'");
  assert.match(note.text, /Заявка в «Бубсер \| Бравл Старс»: 1\/24 на 5 ноября — 6 000 ₽/);
  assert.equal(note.start_param, `deal_${id}`);

  // Before agreement nobody sees the other's contact.
  assert.equal(dealView(db, dealRow(db, id), buyer).seller_contact, null);
  assert.throws(() => decideDeal(db, buyer, id, true), /продавец/);
  decideDeal(db, seller, id, true);
  assert.equal(dealView(db, dealRow(db, id), buyer).seller_contact, '@bubser_ads');
  assert.equal(dealView(db, dealRow(db, id), seller).buyer_contact.username, 'user21');
  assert.match(db.get("SELECT text FROM notifications WHERE user_id = 21 ORDER BY id DESC").text, /Контакт продавца: @bubser_ads/);
  assert.throws(() => dealView(db, dealRow(db, id), client), /не ваша/);
});

test('publication and reviews: after the date, by the buyer only; the rating counts real placements', () => {
  const seller = user(10);
  const { id: ch } = createChannel(db, seller, listing());
  const buyer = user(21, ['vpn_owner']);
  const { id } = bookDeal(db, buyer, ch, { format: '1/24', date: day(3) });
  decideDeal(db, seller, id, true);
  assert.throws(() => markPublished(db, seller, id), /не наступила/);
  assert.throws(() => reviewDeal(db, buyer, id, { rating: 5 }), /после даты/);
  at(T0 + 3 * DAY);
  markPublished(db, seller, id);
  assert.throws(() => reviewDeal(db, seller, id, { rating: 5 }), /покупатель/);
  // The bot asks for a review 48 h after the post.
  assert.equal(askReviews(db), 0);
  at(T0 + 5 * DAY + 3600_000);
  assert.equal(askReviews(db), 1);
  assert.equal(askReviews(db), 0);
  reviewDeal(db, buyer, id, { rating: 4, came: 120, payments: 9, reach_match: 'partly', text: 'Нормально зашло' });
  assert.throws(() => reviewDeal(db, buyer, id, { rating: 5 }), /уже оставлен/);
  const d = channelDetail(db, ch, buyer);
  assert.equal(d.placements, 1);
  assert.equal(d.rating, 4);
  assert.equal(d.avg_came, 120);
  assert.equal(d.reviews.length, 1);

  // A post that never went out is recorded, but not as a placement and not in the rating.
  const b2 = user(22, ['vpn_owner']);
  at(T0);
  const { id: id2 } = bookDeal(db, b2, ch, { format: '2/48', date: day(5) });
  decideDeal(db, seller, id2, true);
  at(T0 + 6 * DAY);
  reviewDeal(db, b2, id2, { published: false });
  assert.equal(dealRow(db, id2).status, 'failed');
  assert.equal(channelDetail(db, ch, null).placements, 1);
});

test('cancel and decline notify the other side', () => {
  const seller = user(10);
  const { id: ch } = createChannel(db, seller, listing());
  const buyer = user(21, ['vpn_owner']);
  const { id } = bookDeal(db, buyer, ch, { format: '1/24', date: day(3) });
  decideDeal(db, seller, id, false, 'Дата уже занята');
  assert.equal(dealRow(db, id).status, 'declined');
  assert.match(db.get('SELECT text FROM notifications WHERE user_id = 21 ORDER BY id DESC').text, /Причина: Дата уже занята/);
  const { id: id2 } = bookDeal(db, buyer, ch, { format: '1/24', date: day(5) });
  cancelDeal(db, buyer, id2);
  assert.match(db.get('SELECT text FROM notifications WHERE user_id = 10 ORDER BY id DESC').text, /Покупатель отменил/);
  assert.throws(() => cancelDeal(db, buyer, id2), /нельзя отменить/);
});

test('complaints from several people send a channel to review; an admin restores it', () => {
  const seller = user(10);
  const { id: ch } = createChannel(db, seller, listing());
  const env = { envAdmins: [1] };
  complain(db, user(30), ch, { reason: 'fake_reach' }, env);
  complain(db, user(31), ch, { reason: 'fake_reach' }, env);
  assert.throws(() => complain(db, user(31), ch, { reason: 'other' }, env), /уже пожаловались/);
  assert.throws(() => complain(db, seller, ch, { reason: 'other' }, env), /свой канал/);
  assert.equal(complain(db, user(32), ch, { reason: 'not_owner', text: 'Это канал моего друга' }, env).review, true);
  assert.equal(listChannels(db, {}, null).items.length, 0);
  assert.equal(db.get("SELECT start_param FROM notifications WHERE user_id = 1 AND type = 'admin'").start_param, 'admin_ads');
  assert.throws(() => channelDetail(db, ch, user(33)), /снят с биржи/);
  assert.equal(channelDetail(db, ch, seller).status, 'review'); // the seller still sees it
  adminSetChannel(db, loadUser(db, 1, [1]), ch, 'restore');
  assert.equal(listChannels(db, {}, null).items.length, 1);
  assert.equal(db.get('SELECT COUNT(*) n FROM ad_complaints WHERE resolved_at IS NULL').n, 0);
});

test('the bot confirms the real owner; a reseller of the same channel is taken off', () => {
  const reseller = user(40);
  const owner = user(41);
  const { id: fake } = createChannel(db, reseller, listing({ contact: '@reseller' }));
  const { id: real } = createChannel(db, owner, listing());
  // Someone who has no listing for this channel gets nothing.
  assert.equal(verifyChannel(db, 99, { id: -100123, username: 'Bubser_Brawl', title: 'Бубсер' }), null);
  const v = verifyChannel(db, 41, { id: -100123, username: 'Bubser_Brawl', title: 'Бубсер | Бравл Старс 🎮' });
  assert.equal(v.id, real);
  assert.ok(v.verified_at);
  assert.equal(db.get('SELECT status FROM ad_channels WHERE id = ?', fake).status, 'blocked');
  assert.match(db.get('SELECT text FROM notifications WHERE user_id = 40').text, /настоящий владелец/);
  // A new copy of a confirmed channel is blocked right away.
  const { id: again } = createChannel(db, user(42), listing());
  assert.equal(db.get('SELECT status FROM ad_channels WHERE id = ?', again).status, 'blocked');
  assert.equal(listChannels(db, { verified: '1' }, null).items.map((c) => c.id).join(), String(real));
  // Removing the bot from admins drops the badge.
  unverifyChannel(db, -100123);
  assert.equal(listChannels(db, { verified: '1' }, null).items.length, 0);
  // A private channel is matched by title among the seller's own listings.
  const { id: priv } = createChannel(db, owner, listing({ link: 'https://t.me/+PrivateInvite1', title: 'Закрытый клуб' }));
  assert.equal(verifyChannel(db, 41, { id: -100777, title: 'закрытый клуб' }).id, priv);
});

test('editing keeps the confirmation only for the same channel; favorites; my channels', () => {
  const owner = user(41);
  const { id } = createChannel(db, owner, listing());
  verifyChannel(db, 41, { id: -100123, username: 'bubser_brawl', title: 'Бубсер' });
  updateChannel(db, owner, id, listing({ formats: { '1/24': 5000 } }));
  assert.ok(db.get('SELECT verified_at FROM ad_channels WHERE id = ?', id).verified_at);
  updateChannel(db, owner, id, listing({ link: '@other_channel' }));
  assert.equal(db.get('SELECT verified_at FROM ad_channels WHERE id = ?', id).verified_at, null);
  assert.throws(() => updateChannel(db, user(50), id, listing()), /не ваш/);
  const b = user(21, ['vpn_owner']);
  setFavorite(db, b, id, true);
  assert.deepEqual(listChannels(db, { favorites: '1' }, b.id).items.map((c) => c.id), [id]);
  bookDeal(db, b, id, { format: '1/24', date: day(3) });
  assert.equal(myChannels(db, owner)[0].requests, 1);
});

test('bot update: making the bot a channel admin confirms the listing, removing it drops the badge', async () => {
  const { createBot } = await import('../server/lib/bot.js');
  const owner = user(41);
  const { id } = createChannel(db, owner, listing());
  const bot = createBot({ botToken: '', adminIds: [], webAppUrl: '' }, { warn() {}, info() {}, error() {} });
  const update = (status) => ({ my_chat_member: { chat: { id: -100123, type: 'channel', username: 'bubser_brawl', title: 'Бубсер' }, from: { id: 41 }, new_chat_member: { status } } });
  await bot.handleUpdate(db, update('administrator'));
  assert.ok(db.get('SELECT verified_at FROM ad_channels WHERE id = ?', id).verified_at);
  assert.equal(db.get('SELECT tg_chat_id FROM ad_channels WHERE id = ?', id).tg_chat_id, -100123);
  await bot.handleUpdate(db, update('left'));
  assert.equal(db.get('SELECT verified_at FROM ad_channels WHERE id = ?', id).verified_at, null);
});
