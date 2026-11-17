import { addMinutes, card, document, empty, matches, parseDateTime } from '../common.js';

const providerId = 'alarm';
const providerName = 'Alarms (mock)';

export default {
  id: 'alarm',
  async execute(toolId, arguments_, { database }) {
    const items = await database.getRecords(providerId, 'items');
    if (toolId === 'alarm.find') {
      const found = items.filter(item => matches(arguments_.query, [item.label, item.time]));
      return found.length
        ? document(providerId, providerName, 'Alarms', found.map(item => card(item.label, item.time, item.enabled === false ? 'Disabled' : 'Enabled')))
        : empty(providerId, providerName, 'Alarms', arguments_.query);
    }
    if (toolId === 'alarm.create') {
      parseDateTime(arguments_.time, 'Alarm time');
      const time = addMinutes(arguments_.time, arguments_.offsetMinutes ?? 0);
      const item = { id: await database.nextId(providerId, 'items', 'alarm'), label: arguments_.label, time, enabled: true };
      await database.putRecord(providerId, 'items', item);
      return document(providerId, providerName, 'Alarm created', [card(item.label, item.time, 'Enabled')], { state: 'success' });
    }
    if (toolId === 'alarm.delete') {
      const item = await database.getRecord(providerId, 'items', arguments_.alarmId);
      if (!item) return empty(providerId, providerName, 'Alarm', arguments_.alarmId);
      await database.deleteRecord(providerId, 'items', arguments_.alarmId);
      return document(providerId, providerName, 'Alarm deleted', [card(item.label, item.time, 'Removed from the synthetic alarm list')], { state: 'success' });
    }
    if (toolId === 'alarm.update') {
      const item = await database.getRecord(providerId, 'items', arguments_.alarmId);
      if (!item) return empty(providerId, providerName, 'Alarm', arguments_.alarmId);
      const updated = { ...item };
      for (const key of ['label', 'time', 'enabled']) if (Object.hasOwn(arguments_, key)) updated[key] = arguments_[key];
      await database.putRecord(providerId, 'items', updated);
      return document(providerId, providerName, 'Alarm updated', [card(updated.label, updated.time, updated.enabled ? 'Enabled' : 'Disabled')], { state: 'success' });
    }
    throw new Error(`Unsupported Alarm tool: ${toolId}`);
  },
};
