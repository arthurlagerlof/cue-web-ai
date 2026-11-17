import { card, document, empty, matches } from '../common.js';

const providerId = 'notifications';
const providerName = 'Android notifications (mock)';

export default {
  id: 'notifications',
  async execute(toolId, arguments_, { database }) {
    if (toolId === 'notifications.search') {
      const query = arguments_.query;
      const found = (await database.getRecords(providerId, 'items')).filter(item => matches(query, [item.app, item.sender, item.preview]));
      if (!found.length) return empty(providerId, providerName, 'Notifications', query);
      const actions = found.map(item => ({ id: `open-${item.id}`, toolId: 'notifications.get', arguments: { notificationId: item.id }, label: 'Open notification' }));
      const elements = found.map(item => {
        const element = card(`${item.app} · ${item.sender}`, item.preview, item.timestamp);
        element.children.push({ type: 'action', actionId: `open-${item.id}`, label: 'Open notification' });
        return element;
      });
      return document(providerId, providerName, 'Notifications', elements, { actions });
    }
    if (toolId === 'notifications.get') {
      const item = await database.getRecord(providerId, 'items', arguments_.notificationId);
      return item
        ? document(providerId, providerName, 'Notification', [card(`${item.app} · ${item.sender}`, item.preview, item.timestamp)])
        : empty(providerId, providerName, 'Notification', arguments_.notificationId);
    }
    throw new Error(`Unsupported Notifications tool: ${toolId}`);
  },
};
