export const SEED_BASE_DATE = '2026-11-16';
const DAY_MS = 86_400_000;
const ISO_DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})(?=$|T)/;

export function utcDateString(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/** @template T @param {T} value @param {number} offsetDays @returns {T} */
export function shiftSeedDates(value, offsetDays) {
  if (offsetDays === 0) return value;
  if (typeof value === 'string') {
    return /** @type {T} */ (value.replace(ISO_DATE_PREFIX, date => utcDateString(new Date(Date.parse(date) + offsetDays * DAY_MS))));
  }
  if (Array.isArray(value)) return /** @type {T} */ (value.map(item => shiftSeedDates(item, offsetDays)));
  if (value && typeof value === 'object') {
    return /** @type {T} */ (Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shiftSeedDates(item, offsetDays)])));
  }
  return value;
}

export function seedOffsetDays(date = new Date()) {
  return Math.round((Date.parse(utcDateString(date)) - Date.parse(SEED_BASE_DATE)) / DAY_MS);
}
