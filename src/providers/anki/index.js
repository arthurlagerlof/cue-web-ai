import { card, document, empty, matches } from '../common.js';

const providerId = 'anki';
const providerName = 'Anki (synthetic demo)';

export default {
  id: 'anki',
  async execute(toolId, arguments_, { database }) {
    const cards = await database.getRecords(providerId, 'cards');
    if (toolId === 'anki.search_cards') {
      const found = cards.filter(item => matches(arguments_.query, [item.front ?? '', item.back ?? '', item.extra ?? '', ...(item.tags ?? [])]));
      if (!found.length) return empty(providerId, providerName, 'Anki cards', arguments_.query);
      const actions = found.map(item => ({ id: `open-${item.id}`, toolId: 'anki.get_card', arguments: { cardId: item.id }, label: 'Open card' }));
      const elements = found.map(item => {
        const element = card(item.front, item.back, `Tags: ${(item.tags ?? []).join(', ') || 'none'} · ${item.id}`);
        element.children.push({ type: 'action', actionId: `open-${item.id}`, label: 'Open card' });
        return element;
      });
      return document(providerId, providerName, 'Anki cards', elements, { actions });
    }
    if (toolId === 'anki.get_card') {
      const item = await database.getRecord(providerId, 'cards', arguments_.cardId);
      return item
        ? document(providerId, providerName, 'Anki card', [card(item.front, item.back, `Extra: ${item.extra ?? ''} · Tags: ${(item.tags ?? []).join(', ')}`)])
        : empty(providerId, providerName, 'Anki card', arguments_.cardId);
    }
    if (toolId === 'anki.create_card') {
      const noteId = `demo-note-${String(cards.length + 1).padStart(3, '0')}`;
      const item = {
        id: await database.nextId(providerId, 'cards', 'demo-card'),
        noteId,
        front: arguments_.front,
        back: arguments_.back,
        extra: arguments_.extra ?? '',
        tags: arguments_.tags ?? [],
        source: 'User-created in Cue',
      };
      await database.putRecord(providerId, 'cards', item);
      return document(providerId, providerName, 'Card created', [card(item.front, item.back, `Tags: ${item.tags.join(', ') || 'none'}`)], { state: 'success' });
    }
    throw new LookupError(`Unsupported Anki tool: ${toolId}`);
  },
};

class LookupError extends Error {}
