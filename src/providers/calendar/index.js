import { card, document, empty, matches, parseDateTime, compareDateTimes } from '../common.js';

const providerId = 'calendar';
const providerName = 'Google Calendar (mock)';

function eventType(item) {
  const explicit = String(item.eventType ?? item.type ?? '').toLowerCase();
  const title = String(item.title ?? '').toLowerCase();
  const inferred = /meeting|sync|review|planning|standup|call/.test(title) ? 'meeting'
    : /appointment|dentist/.test(title) ? 'appointment'
      : title.includes('lunch') ? 'lunch'
        : title.includes('reminder') ? 'reminder' : '';
  return { explicit, inferred };
}

export default {
  id: 'calendar',
  async execute(toolId, arguments_, { database }) {
    const events = await database.getRecords(providerId, 'events');
    if (toolId === 'calendar.find_events') {
      const dateQuery = arguments_.date;
      const query = String(arguments_.query ?? '').trim();
      let startBound = arguments_.start_datetime;
      let endBound = arguments_.end_datetime;
      const legacyDate = Boolean(dateQuery && !startBound && !endBound);
      if (dateQuery) {
        startBound ??= legacyDate ? undefined : `${dateQuery}T00:00:00`;
        endBound ??= legacyDate ? undefined : `${dateQuery}T23:59:59.999999`;
      }
      const start = startBound ? parseDateTime(startBound, 'Calendar search start') : undefined;
      const end = endBound ? parseDateTime(endBound, 'Calendar search end') : undefined;
      if (start && end && compareDateTimes(end, start) !== undefined && end.timestamp <= start.timestamp) {
        throw new RangeError('Calendar search end must follow its start.');
      }
      const found = events.filter(item => {
        if (legacyDate && !String(item.start ?? '').startsWith(dateQuery)) return false;
        if (!legacyDate && (start || end)) {
          let instant;
          try { instant = parseDateTime(item.start, 'Calendar event start'); }
          catch { return false; }
          if (start) {
            const comparison = compareDateTimes(instant, start);
            if (comparison === undefined || comparison < 0) return false;
          }
          if (end) {
            const comparison = compareDateTimes(instant, end);
            if (comparison === undefined || comparison >= 0) return false;
          }
        }
        const type = eventType(item);
        if (arguments_.event_type && arguments_.event_type !== type.explicit && arguments_.event_type !== type.inferred) return false;
        return !query || matches(query, [item.title ?? '', item.location ?? '', item.description ?? '', ...(item.attendees ?? [])]);
      });
      if (!found.length) return empty(providerId, providerName, 'Calendar events', query);
      found.sort((left, right) => String(left.start).localeCompare(String(right.start)) * (arguments_.sort === 'start_descending' ? -1 : 1));
      const actions = found.map(item => ({ id: `open-${item.id}`, toolId: 'calendar.get_event', arguments: { eventId: item.id }, label: 'Open event' }));
      const elements = found.map(item => {
        const element = card(item.title, `${item.start} — ${item.end}`, `${item.location ?? ''} · ${item.id}`);
        element.children.push({ type: 'action', actionId: `open-${item.id}`, label: 'Open event' });
        return element;
      });
      const output = document(providerId, providerName, 'Calendar events', elements, { actions });
      return { document: output, data: { events: found, firstEvent: found[0] } };
    }
    if (toolId === 'calendar.get_event') {
      const item = await database.getRecord(providerId, 'events', arguments_.eventId);
      return item
        ? document(providerId, providerName, item.title, [card(item.title, `${item.start} — ${item.end}`, item.location ?? '')])
        : empty(providerId, providerName, 'Calendar event', arguments_.eventId);
    }
    if (toolId === 'calendar.create_event') {
      const start = parseDateTime(arguments_.start, 'Calendar event start');
      const end = parseDateTime(arguments_.end, 'Calendar event end');
      if (compareDateTimes(start, end) === undefined || end.timestamp <= start.timestamp) throw new RangeError('Calendar event end must follow its start.');
      const item = {
        id: await database.nextId(providerId, 'events', 'event'),
        title: arguments_.title,
        start: arguments_.start,
        end: arguments_.end,
        location: arguments_.location ?? 'Demo location',
      };
      await database.putRecord(providerId, 'events', item);
      return document(providerId, providerName, 'Event created', [card(item.title, `${item.start} — ${item.end}`, item.location)], { state: 'success' });
    }
    if (toolId === 'calendar.check_availability') {
      const start = parseDateTime(arguments_.start, 'Availability interval start');
      const end = parseDateTime(arguments_.end, 'Availability interval end');
      if (compareDateTimes(start, end) === undefined || end.timestamp <= start.timestamp) throw new RangeError('Availability interval end must follow its start.');
      const conflicts = events.filter(item => {
        const eventStart = parseDateTime(item.start, 'Calendar event start');
        const eventEnd = parseDateTime(item.end, 'Calendar event end');
        return compareDateTimes(eventStart, end) !== undefined && compareDateTimes(start, eventEnd) !== undefined
          && eventStart.timestamp < end.timestamp && start.timestamp < eventEnd.timestamp;
      });
      const label = conflicts.length ? 'Unavailable' : 'Available';
      return document(providerId, providerName, 'Calendar availability', [
        card(label, `${start.value} — ${end.value}`, conflicts.map(item => item.title).join(', ')),
      ]);
    }
    if (toolId === 'calendar.delete_event') {
      const item = await database.getRecord(providerId, 'events', arguments_.eventId);
      if (!item) return empty(providerId, providerName, 'Calendar event', arguments_.eventId);
      await database.deleteRecord(providerId, 'events', arguments_.eventId);
      return document(providerId, providerName, 'Event deleted', [card(item.title, 'Removed from the synthetic calendar.')], { state: 'success' });
    }
    if (toolId === 'calendar.update_event') {
      const item = await database.getRecord(providerId, 'events', arguments_.eventId);
      if (!item) return empty(providerId, providerName, 'Calendar event', arguments_.eventId);
      const updated = { ...item };
      for (const key of ['title', 'start', 'end', 'location']) if (Object.hasOwn(arguments_, key)) updated[key] = arguments_[key];
      const start = parseDateTime(updated.start, 'Calendar event start');
      const end = parseDateTime(updated.end, 'Calendar event end');
      if (compareDateTimes(start, end) === undefined || end.timestamp <= start.timestamp) throw new RangeError('Calendar event end must follow its start.');
      await database.putRecord(providerId, 'events', updated);
      return document(providerId, providerName, 'Event updated', [card(updated.title, `${updated.start} — ${updated.end}`, updated.location ?? '')], { state: 'success' });
    }
    throw new Error(`Unsupported Calendar tool: ${toolId}`);
  },
};
