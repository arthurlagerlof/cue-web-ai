import { card, document, empty, matches } from '../common.js';

const providerId = 'knowledge';
const providerName = 'Cue knowledge sample';

export default {
  id: 'knowledge',
  async execute(toolId, arguments_, { database }) {
    if (toolId !== 'knowledge.search') throw new Error(`Unsupported Knowledge tool: ${toolId}`);
    const query = arguments_.query;
    const found = (await database.getRecords(providerId, 'documents')).filter(item =>
      matches(query, [item.title ?? '', item.excerpt ?? '', item.language ?? '', ...(item.keywords ?? [])]));
    if (!found.length) return empty(providerId, providerName, 'Knowledge base', query);
    const elements = found.map(item => card(item.title, item.excerpt, `${String(item.language ?? 'en').toUpperCase()} · ${item.source?.name ?? ''} · ${item.source?.ref ?? ''}`));
    return document(providerId, providerName, 'Knowledge base', elements);
  },
};
