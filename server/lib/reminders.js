// Gentle one-time nudges in the bot, so nobody gets stuck halfway: an approved VPN without a card,
// a listed channel without the confirmation, a request the seller hasn't answered, and the post day.
// Each is sent once (the *_reminded_at columns) and only when it still makes sense.
import { AD_FORMAT } from '../../public/js/dict.js';
import { enqueue } from './notify.js';
import { html } from './moderation.js';
import { now, mskDay, mskHour, DAY } from './time.js';

const dateRu = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' });

export function sendReminders(db, { botUsername = '', ts = now() } = {}) {
  let sent = 0;

  // VPN owners: approved a day ago, card never submitted.
  for (const s of db.all(
    `SELECT s.id, s.name, s.owner_id FROM services s
     WHERE s.status = 'draft' AND s.owner_id IS NOT NULL AND s.fill_reminded_at IS NULL AND s.created_at <= ?
       AND NOT EXISTS (SELECT 1 FROM service_revisions r WHERE r.service_id = s.id AND r.status IN ('pending', 'approved'))`, ts - DAY)) {
    db.run('UPDATE services SET fill_reminded_at = ? WHERE id = ?', ts, s.id);
    enqueue(db, s.owner_id, 'moderation',
      `⏳ Карточка «${html(s.name)}» ещё не заполнена — без неё сервиса нет в каталоге. Это несколько минут: описание, тарифы и способы оплаты.`,
      `owner_${s.id}`, 'Заполнить карточку');
    sent++;
  }

  // Ad sellers: listed a day ago, still not confirmed through the bot.
  for (const c of db.all(
    `SELECT id, title, owner_id FROM ad_channels WHERE status = 'active' AND verified_at IS NULL AND verify_reminded_at IS NULL AND created_at <= ?`, ts - DAY)) {
    db.run('UPDATE ad_channels SET verify_reminded_at = ? WHERE id = ?', ts, c.id);
    enqueue(db, c.owner_id, 'deal',
      `🔒 Канал «${html(c.title)}» ещё не подтверждён. Добавьте ${botUsername ? `@${html(botUsername)}` : 'бота Линзы'} администратором канала — ` +
      'это полминуты, а покупатели чаще выбирают каналы с галочкой.', `ads_my_${c.id}`, 'Мой канал');
    sent++;
  }

  // Ad sellers: a request waiting for an answer for a day.
  for (const d of db.all(
    `SELECT d.id, d.format, d.date, d.seller_id, c.title FROM ad_deals d JOIN ad_channels c ON c.id = d.channel_id
     WHERE d.status = 'requested' AND d.seller_reminded_at IS NULL AND d.created_at <= ?`, ts - DAY)) {
    db.run('UPDATE ad_deals SET seller_reminded_at = ? WHERE id = ?', ts, d.id);
    enqueue(db, d.seller_id, 'deal',
      `⏰ Заявка в «${html(d.title)}» ждёт ответа уже сутки: ${AD_FORMAT[d.format]?.name || d.format} на ${dateRu(d.date)}. Согласуйте или отклоните — покупатель ждёт.`,
      `deal_${d.id}`, 'Открыть заявку');
    sent++;
  }

  // Both sides on the morning of the post (from 9:00 Moscow time).
  if (mskHour(ts) >= 9) {
    for (const d of db.all(
      `SELECT d.id, d.format, d.date, d.seller_id, d.buyer_id, c.title, s.name service_name FROM ad_deals d
       JOIN ad_channels c ON c.id = d.channel_id LEFT JOIN services s ON s.id = d.service_id
       WHERE d.status = 'agreed' AND d.date = ? AND d.day_reminded_at IS NULL`, mskDay(ts))) {
      db.run('UPDATE ad_deals SET day_reminded_at = ? WHERE id = ?', ts, d.id);
      const format = AD_FORMAT[d.format]?.name || d.format;
      enqueue(db, d.seller_id, 'deal',
        `📅 Сегодня размещение в «${html(d.title)}»: ${format}${d.service_name ? ` для «${html(d.service_name)}»` : ''}. После публикации отметьте «Пост вышел».`,
        `deal_${d.id}`, 'Открыть сделку');
      enqueue(db, d.buyer_id, 'deal',
        `📅 Сегодня выходит ваш пост в «${html(d.title)}» (${format}). Через 48 часов попросим оценить результат.`, `deal_${d.id}`, 'Открыть сделку');
      sent += 2;
    }
  }
  return sent;
}
