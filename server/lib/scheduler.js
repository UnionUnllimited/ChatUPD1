import { expirePromos } from './moderation.js';
import { publishTop } from './top.js';
import { flushOutbox } from './notify.js';
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
      if (autoPublishTop(db, config.topAutoPublishHourMsk)) log.info('Monthly top auto-published for', previousPeriod());
    } catch (e) { log.error('scheduler:', e.message); }
  };
  housekeeping();
  timers.push(setInterval(housekeeping, 5 * 60_000));
  return () => timers.forEach(clearInterval);
}
