import { expirePromos } from './moderation.js';
import { publishTop } from './top.js';
import { flushOutbox } from './notify.js';
import { recomputeActive, evaluateTrust } from './health.js';
import { askReviews } from './ads.js';
import { sendReminders } from './reminders.js';
import { previousPeriod, mskDate, mskHour } from './time.js';

// The monthly top is recalculated on the 1st: admins can preview and publish it
// themselves; if nobody has by the configured hour, it is published automatically.
export function autoPublishTop(db, hourMsk) {
  if (mskDate() !== 1 || mskHour() < hourMsk) return false;
  const period = previousPeriod();
  if (db.get('SELECT 1 FROM top_snapshots WHERE period = ?', period)) return false;
  try {
    publishTop(db, period, null);
    return true;
  } catch {
    return false; // no data for the month
  }
}

export function startScheduler({ db, bot, config, log = console }) {
  const timers = [];
  let flushing = false;
  timers.push(setInterval(async () => {
    if (flushing) return;
    flushing = true;
    try { await flushOutbox(db, bot); } catch (e) { log.error('outbox:', e.message); } finally { flushing = false; }
  }, 1000));

  const housekeeping = () => {
    try {
      expirePromos(db);
      askReviews(db);
      sendReminders(db, { botUsername: config.botUsername });
      if (autoPublishTop(db, config.topAutoPublishHourMsk)) log.info('Monthly top auto-published for', previousPeriod());
    } catch (e) { log.error('scheduler:', e.message); }
  };
  housekeeping();
  timers.push(setInterval(housekeeping, 5 * 60_000));

  // Service health: failure statuses expire by timer, and votes older than the trust delay
  // are compared with the outcome. Every 10 minutes.
  const health = () => {
    try {
      recomputeActive(db);
      evaluateTrust(db);
    } catch (e) { log.error('health:', e.message); }
  };
  health();
  timers.push(setInterval(health, 10 * 60_000));
  // Confirmed channels: subscribers and avatars from Telegram once a day.
  const channels = async () => {
    if (!bot?.enabled) return;
    for (const ch of db.all('SELECT id, tg_chat_id FROM ad_channels WHERE verified_at IS NOT NULL AND tg_chat_id IS NOT NULL')) {
      await bot.refreshChannel(db, ch).catch((e) => log.warn('channel refresh:', e.message));
    }
  };
  timers.push(setTimeout(channels, 60_000));
  timers.push(setInterval(channels, 24 * 3600_000));
  return () => timers.forEach((t) => { clearInterval(t); clearTimeout(t); });
}
