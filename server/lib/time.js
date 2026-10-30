// All calendar logic (days for stats, months for the top) uses Moscow time,
// which is a fixed UTC+3 offset with no DST.
const MSK_OFFSET = 3 * 3600 * 1000;
export const DAY = 24 * 3600 * 1000;

let clock = () => Date.now();
export const now = () => clock();
// Tests can freeze time.
export function setClock(fn) { clock = fn || (() => Date.now()); }

const msk = (ts) => new Date(ts + MSK_OFFSET);
const pad = (n) => String(n).padStart(2, '0');

export function mskDay(ts = now()) {
  const d = msk(ts);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function periodOf(ts = now()) {
  const d = msk(ts);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

export function shiftPeriod(period, delta) {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

export const previousPeriod = (ts = now()) => shiftPeriod(periodOf(ts), -1);

// [start, end) of a month in epoch ms.
export function periodRange(period) {
  const [y, m] = period.split('-').map(Number);
  return [Date.UTC(y, m - 1, 1) - MSK_OFFSET, Date.UTC(y, m, 1) - MSK_OFFSET];
}

export function mskHour(ts = now()) { return msk(ts).getUTCHours(); }
export function mskDate(ts = now()) { return msk(ts).getUTCDate(); }

export const isPeriod = (s) => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
