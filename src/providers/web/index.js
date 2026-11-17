import { card, document, empty, matches, text } from '../common.js';

const providerId = 'web';
const providerName = 'Mock web search';

export default {
  id: 'web',
  async execute(toolId, arguments_, { database }) {
    if (toolId === 'web.search') {
      const query = arguments_.query;
      const all = await database.getRecords(providerId, 'results');
      const found = all.filter(item => matches(query, [item.title, item.summary, ...(item.keywords ?? [])]));
      const results = found.length ? found : all;
      if (!results.length) return empty(providerId, providerName, 'Web search', query);
      const actions = results.map(item => ({ id: `open-${item.id}`, toolId: 'web.get_article', arguments: { articleId: item.id }, label: 'Open article' }));
      const assets = await database.getAssets();
      const assetIds = new Set(assets.map(asset => asset.id));
      const elements = results.map(item => {
        const children = [text(item.title, 'heading'), text(item.summary), text(item.url, 'caption')];
        if (item.imageAssetId && assetIds.has(item.imageAssetId)) children.push({ type: 'image', assetId: item.imageAssetId, fit: 'contain' });
        children.push({ type: 'action', actionId: `open-${item.id}`, label: 'Open article' });
        return { type: 'container', layout: 'column', children };
      });
      return document(providerId, providerName, `Web results: ${query}`, elements, { assets, actions });
    }
    if (toolId === 'web.get_article') {
      const item = await database.getRecord(providerId, 'results', arguments_.articleId);
      return item
        ? document(providerId, providerName, item.title, [card(item.title, item.summary, item.url)])
        : empty(providerId, providerName, 'Article', arguments_.articleId);
    }
    throw new Error(`Unsupported Web Search tool: ${toolId}`);
  },
};
