import { createDisplayDocument } from '../display/document.js';

export function words(value) {
  return String(value).toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

export function matches(query, fields) {
  const terms = new Set(words(query));
  if (!terms.size) return true;
  const available = new Set(fields.flatMap(words));
  return [...terms].some(term => available.has(term));
}

export function text(value, role = 'body') {
  return { type: 'text', text: String(value), role };
}

export function card(title, body, caption) {
  const children = [text(title, 'heading'), text(body)];
  if (caption) children.push(text(caption, 'caption'));
  return { type: 'container', layout: 'column', children };
}

export function document(providerId, providerName, title, elements, { state = 'ready', message, assets = [], actions = [] } = {}) {
  return createDisplayDocument({
    id: `${providerId}-${state}`,
    title,
    source: { app: providerId, name: providerName },
    state,
    message,
    elements,
    assets,
    actions,
  });
}

export function empty(providerId, name, title, query) {
  return document(providerId, name, title, [text(`No results for “${query}”.`)], { state: 'empty', message: 'No matching results.' });
}

export async function nextId(database, providerId, recordType, prefix) {
  const rows = await database.getRecords(providerId, recordType);
  const numbers = rows.map(item => String(item.id)).filter(id => id.startsWith(`${prefix}-`))
    .map(id => Number(id.slice(prefix.length + 1))).filter(Number.isInteger);
  return `${prefix}-${Math.max(0, ...numbers) + 1}`;
}

export function parseDateTime(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new TypeError(`${label} must be a valid ISO-8601 date-time.`);
  const hasTimezone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(value);
  return { value, timestamp: Date.parse(value), hasTimezone };
}

export function compareDateTimes(left, right) {
  if (left.hasTimezone !== right.hasTimezone) return undefined;
  return left.timestamp - right.timestamp;
}

export function addMinutes(value, minutes) {
  const parsed = parseDateTime(value, 'Alarm time');
  const offset = value.match(/([+-])(\d{2}):(\d{2})$/);
  const offsetMinutes = offset ? (offset[1] === '-' ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3])) : 0;
  const local = new Date(parsed.timestamp + minutes * 60000 + offsetMinutes * 60000).toISOString().replace(/Z$/, '');
  const timezone = offset ? `${offset[1]}${offset[2]}:${offset[3]}` : 'Z';
  return `${local}${timezone}`;
}
