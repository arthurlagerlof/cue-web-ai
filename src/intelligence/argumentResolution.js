import * as chrono from 'chrono-node';
import { validateArguments } from './toolRegistry.js';

const customParsers = new Map();

export function registerArgumentParser(key, parser) {
  if (typeof key !== 'string' || !key || typeof parser !== 'function') throw new TypeError('Argument parsers require a key and function');
  customParsers.set(key, parser);
  return () => customParsers.delete(key);
}

function zoneParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}

function zonedIso(parts, timeZone) {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second ?? 0);
  let instant = target;
  for (let attempt = 0; attempt < 4; attempt++) {
    const local = zoneParts(new Date(instant), timeZone);
    const represented = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
    instant += target - represented;
  }
  const actual = zoneParts(new Date(instant), timeZone);
  if (actual.year !== parts.year || actual.month !== parts.month || actual.day !== parts.day || actual.hour !== parts.hour || actual.minute !== parts.minute) return undefined;
  const offsets = new Set([-120, -60, 0, 60, 120].map(delta => {
    const sample = new Date(instant + delta * 60_000);
    const local = zoneParts(sample, timeZone);
    return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) - sample.getTime();
  }));
  const matchingInstants = [...offsets].map(offset => target - offset).filter(value => {
    const local = zoneParts(new Date(value), timeZone);
    return local.year === parts.year && local.month === parts.month && local.day === parts.day && local.hour === parts.hour && local.minute === parts.minute;
  });
  if (matchingInstants.length !== 1) return undefined;
  const offsetMinutes = Math.round((target - instant) / 60_000);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}:${String(parts.second ?? 0).padStart(2, '0')}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

function temporal(text, schema, { now, locale, timeZone, previousValue, currentValues }) {
  const engine = locale?.toLowerCase().startsWith('fi') ? chrono.fi : chrono.en;
  const matches = engine.parse(text, now);
  const role = schema['x-cue']?.role;
  const hasStartLabel = /\b(?:start|starting|from|beginning|alkaen|alkaa)\b/i.test(text);
  const hasEndLabel = /\b(?:end|ending|finish|until|päättyy)\b/i.test(text);
  if (role === 'interval_start' && hasEndLabel && !hasStartLabel && matches.length === 1) return undefined;
  let match = role === 'interval_end' && matches.length > 1 ? matches.at(-1) : matches[0];
  if (role === 'interval_end' && matches.length < 2) {
    const endExpression = text.match(/\b(?:to|until|through|ending|end(?:s)?(?:\s+at)?|finish(?:es)?(?:\s+at)?|asti|päättyy)\s+(\d{1,2}(?::\d{2})?(?:\s*[ap]m)?)\b/i);
    if (!endExpression) return undefined;
    match = engine.parse(endExpression[1], now)[0];
  }
  if (!match) return undefined;
  const start = match.start;
  let date = { year: start.get('year'), month: start.get('month'), day: start.get('day') };
  if (schema.format === 'date') return { value: `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`, text: match.text, method: 'chrono-node' };
  const timeOnly = schema.format === 'time';
  let hasTime = start.isCertain('hour');
  let hour = start.get('hour'), minute = start.get('minute'), second = start.get('second') ?? 0;
  const referenceValue = role === 'interval_end' ? (currentValues?.start ?? previousValue) : previousValue;
  const prior = typeof referenceValue === 'string' && referenceValue.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  const priorDate = typeof referenceValue === 'string' && referenceValue.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const dateCertain = start.isCertain('day') || start.isCertain('weekday') || start.isCertain('month');
  if (!timeOnly && (prior || priorDate) && hasTime && !dateCertain) {
    const reference = prior ?? priorDate;
    date = { year: Number(reference[1]), month: Number(reference[2]), day: Number(reference[3]) };
  } else if (!timeOnly && prior && !hasTime && dateCertain) {
    hour = Number(prior[4]); minute = Number(prior[5]); second = Number(prior[6] ?? 0); hasTime = true;
  }
  if (!hasTime && !timeOnly) {
    const partialValue = `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
    return { status: 'ambiguous', text: match.text, partialValue, reason: 'A time is required.' };
  }
  if (!hasTime) return { value: undefined, text: match.text, method: 'chrono-node' };
  if (start.isCertain('meridiem') === false && /\b(?:at|klo)\s+\d{1,2}\b/i.test(match.text) && start.get('hour') <= 12 && !/\d{1,2}:\d{2}/.test(match.text)) return { status: 'ambiguous', text: match.text, reason: 'Please specify AM or PM.' };
  const normalized = zonedIso({ ...date, hour, minute, second }, timeZone);
  if (!normalized) return { status: 'ambiguous', text: match.text, reason: 'That local time is ambiguous or falls in a daylight-saving gap.' };
  return { value: timeOnly ? normalized.slice(11, 19) : normalized, text: match.text, method: 'chrono-node' };
}

function queryText(text) {
  const cleaned = text.replace(/^[\s,.;:!?-]+|[\s,.;:!?-]+$/g, '');
  const result = cleaned.replace(/^(?:(?:please\s+)?(?:search|find|look\s+up|show|open|retrieve|etsi|hae|näytä|nayta|etsiä)\b[^.!?]*?\b(?:for|about|from|for|of|on|for|koskeva|aiheesta|hakusanalla)\s+|(?:search|find|etsi|hae)\s+(?:my\s+)?(?:anki\s+)?(?:cards?|kortit|knowledge\s+base|the\s+web|webistä|tietopankki)\s+(?:about|for|aiheesta|hakusanalla)\s+)/i, '').trim();
  return result || cleaned;
}

function extractValue(name, rule, text, context) {
  const hint = rule['x-cue'] ?? {};
  const parser = (rule.format && customParsers.get(rule.format)) ?? customParsers.get(rule.type);
  if (parser) {
    const parsed = parser({ name, rule, text, context });
    if (parsed !== undefined) return parsed;
  }
  if (hint.role === 'relative_datetime') {
    const hasRelation = /\b(?:before|beforehand|earlier|after|later|ennen|aikaisemmin|jälkeen|jalkeen)\b/i.test(text);
    const hasDuration = /\b\d+(?:\.\d+)?\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|sekuntia|minuuttia|minuutin|tuntia|tunnin|päivää|paivaa)\b/i.test(text);
    if (hasRelation && !hasDuration) return { status: 'ambiguous', reason: 'How long before or after the event should the alarm be?' };
    if (hasRelation && context.toolResults?.length) {
      for (const result of context.toolResults) for (const path of hint.referencePaths ?? []) {
        const value = path.split('.').reduce((current, key) => current == null ? undefined : current[key], result);
        if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return { value, source: 'tool_result', originalText: text.match(/\b(?:before|beforehand|earlier|after|later|ennen|aikaisemmin|jälkeen|jalkeen)\b/i)?.[0], method: 'explicit-reference-derivation' };
      }
    }
  }
  if (hint.role === 'derived_label' && context.toolResults?.length) {
    for (const result of context.toolResults) for (const path of hint.referencePaths ?? []) {
      const value = path.split('.').reduce((current, key) => current == null ? undefined : current[key], result);
      if (typeof value === 'string' && value.trim()) return { value, source: 'tool_result', method: 'derived-from-tool-result' };
    }
  }
  if (typeof hint.role === 'string') {
    if (hint.role === 'query') return { value: queryText(text), originalText: text, method: 'request-remainder' };
    if (hint.role === 'title') {
      const match = text.match(/\b(?:called|titled|named)\s+(.+?)(?:\s+(?:on|at|from)\b|[.!?]|$)/i);
      if (match) return { value: match[1].trim(), originalText: match[0], method: 'explicit-pattern' };
      const eventTitle = text.match(/\b(?:meeting|appointment|event|kokous|tapaaminen|tapahtuma)(?:\s+(?:with|for)\s+[\p{L}\p{N}'-]+)?/iu);
      if (eventTitle) return { value: eventTitle[0], originalText: eventTitle[0], method: 'intent-label-derivation' };
    }
    if (hint.role === 'question_text' || hint.role === 'answer_text') {
      const label = hint.role === 'question_text' ? '(?:front|question|q)' : '(?:back|answer|a)';
      const match = text.match(new RegExp(`\\b${label}\\s*[:=]\\s*(.+?)(?=\\s+\\b(?:front|question|q|back|answer|a|tags?)\\s*[:=]|$)`, 'i'));
      if (match) return { value: match[1].trim().replace(/[.!?]+$/, ''), originalText: match[0], method: 'labeled-text-extraction' };
    }
    if (hint.role === 'tag_list') {
      const match = text.match(/\btags?\s*[:=]\s*(.+?)(?:[.!?]|$)/i);
      if (match) return { value: match[1].split(/[,;]/).map(value => value.trim()).filter(Boolean), originalText: match[0], method: 'tag-list-extraction' };
    }
  }
  if (rule.enum?.length) {
    const found = rule.enum.filter(value => new RegExp(`(?:^|\\W)${String(value).replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}(?:$|\\W)`, 'i').test(text));
    if (found.length === 1) return { value: found[0], method: 'enum-extraction' };
    if (found.length > 1) return { status: 'ambiguous', reason: `Multiple values match ${name}.` };
  }
  if (rule.format === 'date' || rule.format === 'date-time' || rule.format === 'time') {
    return temporal(text, rule, context);
  }
  if (rule.format === 'duration') {
    const match = text.match(/\b(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|sekuntia|minuuttia|minuutin|tuntia|tunnin|päivää|paivaa)\b/i);
    if (match) {
      const unit = /day|päiv|paiv/i.test(match[2]) ? 'D' : /hour|hr|tunti/i.test(match[2]) ? 'H' : /second|sec|sekunt/i.test(match[2]) ? 'S' : 'M';
      return { value: unit === 'D' ? `P${match[1]}D` : `PT${match[1]}${unit}`, originalText: match[0], method: 'duration-extraction' };
    }
  }
  if (rule.format === 'phone' || /phone|telephone/i.test(name)) {
    const match = text.match(/(?:\+?\d[\d\s().-]{5,}\d)/);
    if (match) {
      const digits = match[0].replace(/\D/g, '');
      if (digits.length >= 7 && digits.length <= 15) return { value: match[0].trim(), originalText: match[0], method: 'phone-extraction' };
    }
  }
  if (rule.type === 'number' || rule.type === 'integer') {
    const duration = text.match(/\b(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?|days?|minutes?|minuuttia|minuutin|tuntia|tunnin)\b/i);
    const simple = text.match(/(?:^|\s)(-?\d+(?:\.\d+)?)(?:\s|$)/);
    const number = duration?.[1] ?? simple?.[1];
    if (number !== undefined) {
      let value = Number(number);
      if (duration && /hour|hr|tunti/i.test(duration[2]) && /offset|minute/i.test(name)) value *= 60;
      if (duration && /day/i.test(duration[2]) && /offset|minute/i.test(name)) value *= 1440;
      if (/offset/i.test(name) && /\b(?:before|beforehand|earlier|ennen|aikaisemmin)\b/i.test(text)) value = -Math.abs(value);
      if (/offset/i.test(name) && /\b(?:after|later|jälkeen|jalkeen)\b/i.test(text)) value = Math.abs(value);
      return { value: rule.type === 'integer' ? Math.trunc(value) : value, originalText: duration?.[0] ?? simple?.[0], method: 'numeric-extraction' };
    }
  }
  if (rule.type === 'boolean') {
    if (/\b(?:enable|enabled|yes|true|turn on|activate|kyllä|kylla|käytössä|kaytossa)\b/i.test(text)) return { value: true, method: 'boolean-lexicon' };
    if (/\b(?:disable|disabled|no|false|turn off|deactivate|ei|pois käytöstä|pois kaytosta)\b/i.test(text)) return { value: false, method: 'boolean-lexicon' };
  }
  if (rule.type === 'string') {
    if (hint.role === 'known_entity') {
      const match = text.match(/\b[a-z][a-z0-9_-]*-\d+\b/i);
      if (match) return { value: match[0], originalText: match[0], method: 'entity-id-extraction' };
    }
    const value = context.providerLookup?.(name, text, rule);
    if (value !== undefined) return { value, method: 'provider-lookup', source: 'provider_lookup' };
    if (/email/i.test(rule.format ?? name)) {
      const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
      if (match) return { value: match[0], originalText: match[0], method: 'email-extraction' };
    }
    if (/uri|url/i.test(rule.format ?? name)) {
      const match = text.match(/https?:\/\/[^\s)]+/i);
      if (match) return { value: match[0], originalText: match[0], method: 'url-extraction' };
    }
    if (/query|search/i.test(name)) return { value: queryText(text), method: 'request-remainder' };
    if (rule['x-cue']?.allowWholeRequest === true) return { value: text, method: 'explicit-text' };
  }
  return undefined;
}

export function resolveArguments({ request, tool, previous = {}, context = {} }) {
  const schema = tool.parameters ?? tool.inputSchema;
  const now = context.now instanceof Date ? context.now : new Date(context.now ?? Date.now());
  const locale = context.locale ?? 'en';
  const timeZone = context.timeZone ?? 'UTC';
  const arguments_ = {};
  const resolved = {};
  const missing = [];
  const ambiguous = [];
  const invalid = [];
  for (const [name, rule] of Object.entries(schema.properties ?? {})) {
    const previousValue = previous[name];
    const extracted = extractValue(name, rule, request, { ...context, now, locale, timeZone, previousValue: previousValue?.value ?? previousValue, currentValues: arguments_ });
    const reusablePrevious = previousValue !== undefined && previousValue.status !== 'partial';
    const candidate = extracted?.value !== undefined ? { ...extracted, source: extracted.source ?? 'current_user_request' }
      : reusablePrevious ? { value: previousValue.value ?? previousValue, source: previousValue.source ?? 'previous_conversation', method: previousValue.method ?? 'prior-resolution', originalText: previousValue.originalText }
      : undefined;
    if (extracted?.status === 'ambiguous') {
      ambiguous.push({ name, reason: extracted.reason, originalText: extracted.text });
      if (extracted.partialValue !== undefined) resolved[name] = { value: extracted.partialValue, status: 'partial', source: 'current_user_request', originalText: extracted.text, method: extracted.method ?? 'chrono-node' };
      continue;
    }
    if (!candidate) {
      if ((schema.required ?? []).includes(name)) missing.push(name);
      continue;
    }
    const validation = validateArguments(rule, candidate.value, `$ .${name}`.replace('$ ', '$'));
    if (!validation.valid) {
      invalid.push({ name, value: candidate.value, errors: validation.errors });
      continue;
    }
    arguments_[name] = candidate.value;
    resolved[name] = { value: candidate.value, status: 'resolved', source: candidate.source, originalText: extracted?.originalText ?? extracted?.text ?? candidate.originalText, method: candidate.method };
  }
  const requiredValidation = validateArguments(schema, arguments_);
  for (const error of requiredValidation.errors) {
    const name = error.match(/^\$\.([^:.[\]]+)/)?.[1];
    if (name && !(missing.includes(name)) && !ambiguous.some(item => item.name === name) && !invalid.some(item => item.name === name)) missing.push(name);
  }
  return { arguments: arguments_, fields: resolved, missing: [...new Set(missing)], ambiguous, invalid, complete: requiredValidation.valid };
}

export function clarificationForResolution(tool, resolution) {
  if (resolution.ambiguous.length) return resolution.ambiguous[0].reason;
  const fields = resolution.missing.map(name => tool.parameters.properties[name]?.description ?? name.replace(/([A-Z])/g, ' $1').toLowerCase());
  if (fields.length === 1) return `What ${fields[0]} should I use?`;
  if (fields.length > 1) return `Please provide ${fields.join(' and ')}.`;
  if (resolution.invalid.length) return `Please provide a valid ${resolution.invalid[0].name}.`;
  return 'Please clarify the required details.';
}
