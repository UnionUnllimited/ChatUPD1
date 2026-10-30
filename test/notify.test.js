import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { upsertUser, loadUser, grantRole } from '../server/auth.js';
import { setClock, DAY } from '../server/lib/time.js';
import { invalidate } from '../server/lib/catalog.js';
import { createApplication, approveApplication, submitRevision, approveRevision, createPromo, upsertReview, moderateReview } from '../server/lib/moderation.js';
import { validateCard } from '../server/lib/validate.js';
import { createChannel, bookDeal, decideDeal, markPublished, reviewDeal } from '../server/lib/ads.js';
import { sendReminders } from '../server/lib/reminders.js';

const T0 = Date.UTC(2026, 10, 2, 7); // 2 Nov 2026, 10:00 MSK
let db, clock;
const at = (ts) => { clock = ts; setClock(() => clock); };
const env = { envAdmins: [1] };
const msgs = (userId) => db.all('SELECT text, start_param, button FROM notifications WHERE user_id = ? ORDER BY id', userId);
const last = (userId) => msgs(userId).at(-1);
function user(id, roles = []) {
  upsertUser(db, { id, first_name: `U${id}`, username: `user${id}`, allows_write_to_pm: true });
  for (const r of roles) grantRole(db, id, r);
  return loadUser(db, id, [1]);
}
const card = { name: 'Свой VPN', bot_url: '@own_vpn_bot', devices: 3, tariffs: { 1: 199 }, protocols: ['vless'], countries: ['nl'], platforms: ['ios'], payments: ['sbp'], description: 'Быстрый и простой VPN' };

beforeEach(() => {
  at(T0);
  db = openDb(':memory:');
  invalidate();
  user(1, ['admin']);
});

test('a VPN owner is led step by step: application → approval → card → catalog', () => {
  const owner = user(10);
  const app = createApplication(db, owner, { name: 'Свой VPN', link: 'https://t.me/own_vpn_bot', contact: '@user10', comment: 'Работаем год' }, env);
  assert.match(last(10).text, /принята/);
  assert.match(last(1).text, /Заявка на подключение: «Свой VPN».*От: @user10/s);
  assert.equal(last(1).start_param, 'admin_applications');
  const { service_id: id } = approveApplication(db, loadUser(db, 1, [1]), app.id);
  assert.equal(last(10).button, 'Заполнить карточку');

  // No card for a day → one reminder, never twice.
  assert.equal(sendReminders(db, { ts: T0 + DAY / 2 }), 0);
  at(T0 + DAY + 1000);
  assert.equal(sendReminders(db), 1);
  assert.match(last(10).text, /ещё не заполнена/);
  assert.equal(sendReminders(db), 0);

  submitRevision(db, loadUser(db, 10), id, validateCard(card), env);
  assert.match(last(10).text, /Карточка «Свой VPN» отправлена на модерацию/);
  assert.match(last(1).text, /На модерации новая карточка/);
  const rev = db.get('SELECT id FROM service_revisions WHERE service_id = ?', id).id;
  approveRevision(db, loadUser(db, 1, [1]), rev, {});
  assert.match(last(10).text, /опубликована — теперь она в каталоге.*Что дальше/s);

  createPromo(db, loadUser(db, 10), id, { title: '−20% на месяц', discount_percent: 20, starts_at: T0, ends_at: T0 + 10 * DAY }, env);
  assert.match(last(10).text, /Акция «−20% на месяц» отправлена на модерацию/);
  assert.match(last(1).text, /На модерации акция/);
});

test('reviews: the author hears the outcome, the VPN owner hears about a new review', () => {
  const owner = user(10);
  const app = createApplication(db, owner, { name: 'Свой VPN', link: 'https://t.me/own_vpn_bot', contact: '@user10' }, env);
  const { service_id: id } = approveApplication(db, loadUser(db, 1, [1]), app.id);
  submitRevision(db, loadUser(db, 10), id, validateCard(card), env);
  approveRevision(db, loadUser(db, 1, [1]), db.get('SELECT id FROM service_revisions').id, {});
  const client = user(20);
  db.run("INSERT INTO clicks (service_id, user_id, source, created_at) VALUES (?, 20, 'catalog', ?)", id, T0);
  const r = upsertReview(db, client, id, { rating: 4, text: 'Работает стабильно, поддержка отвечает' });
  moderateReview(db, loadUser(db, 1, [1]), r.id, true);
  assert.match(last(20).text, /отзыв о «Свой VPN» опубликован/);
  assert.match(last(10).text, /Новый отзыв о «Свой VPN»: ★★★★☆/);
});

test('ad exchange: seller and buyer get every step, reminders come once', () => {
  const seller = user(30);
  const { id: ch } = createChannel(db, seller, {
    link: '@notify_ch', title: 'Канал', topic: 'news', subscribers: 10000, reach_24: 4000, reach_48: 5000, formats: { '1/24': 1000 }, contact: '@user30'
  }, { botUsername: 'linza_app_bot' });
  assert.match(last(30).text, /на бирже.*добавьте @linza_app_bot администратором/s);
  const buyer = user(40, ['vpn_owner']);
  const date = new Date(T0 + 2 * DAY + 3 * 3600_000).toISOString().slice(0, 10);
  const { id } = bookDeal(db, buyer, ch, { format: '1/24', date });

  at(T0 + DAY + 1000);
  assert.equal(sendReminders(db, { botUsername: 'linza_app_bot' }), 2); // unconfirmed channel + unanswered request
  assert.ok(msgs(30).some((m) => /ещё не подтверждён/.test(m.text)));
  assert.match(last(30).text, /ждёт ответа уже сутки/);
  assert.equal(sendReminders(db), 0);

  decideDeal(db, seller, id, true);
  assert.match(last(40).text, /Контакт продавца: @user30/);
  assert.match(last(30).text, /Вы согласовали.*Покупатель: @user40/s);

  at(T0 + 2 * DAY); // the post day, 10:00 MSK
  assert.equal(sendReminders(db), 2);
  assert.match(last(30).text, /Сегодня размещение/);
  assert.match(last(40).text, /Сегодня выходит ваш пост/);
  markPublished(db, seller, id);
  assert.match(last(40).text, /Продавец отметил, что пост в «Канал» вышел/);
  reviewDeal(db, buyer, id, { rating: 5, came: 80, payments: 6 });
  assert.match(last(30).text, /Покупатель оценил размещение в «Канал»: ★★★★★ — пришло 80, оплат 6/);
});
