import { ToolDispatcher } from '../intelligence/dispatcher.js';
import { buildToolExampleIndex, ToolIntelligence } from '../intelligence/toolIntelligence.js';
import { ToolRegistry } from '../intelligence/toolRegistry.js';

export async function createDatabaseEnvironment({ registryData, embed, postApi, threshold = undefined, plausibleThreshold = undefined, ambiguityMargin = undefined }) {
  if (!registryData || !Array.isArray(registryData.providers) || !Array.isArray(registryData.tools)) {
    throw new TypeError('The demo registry response is invalid');
  }
  const config = registryData.toolRetrievalConfig ?? {};
  const minimumScore = threshold ?? config.minimumScore ?? 0.58;
  const plausibleScore = plausibleThreshold ?? config.plausibleScore ?? 0.38;
  const candidateMargin = ambiguityMargin ?? config.ambiguityMargin ?? 0.08;
  const scoring = config.scoring ?? 'weighted-max';
  const weights = config.weights ?? { description: 0.35, keyword: 0.3, example: 0.35 };
  const registry = new ToolRegistry();
  for (const provider of registryData.providers) {
    registry.registerProvider({
      id: provider.id,
      available: provider.status === 'available',
      canExecute: true,
      permissions: [],
      execute: async (toolId, args, { confirmed } = {}) => {
        const response = await postApi('/api/demo/execute', { toolId, arguments: args, confirmed: confirmed === true });
        return response.result;
      },
    });
  }
  for (const tool of registryData.tools) {
    if (!registry.getProvider(tool.providerId)) throw new TypeError(`Tool references an unknown provider: ${tool.id}`);
    registry.registerTool(tool);
  }

  let exampleIndex = [];
  const pendingIds = new Set(registryData.pendingToolEmbeddingIds ?? []);
  if (pendingIds.size) {
    exampleIndex = await buildToolExampleIndex(registry.list().filter(tool => tool.available !== false), embed, { recordIds: pendingIds });
    for (let offset = 0; offset < exampleIndex.length; offset += 10) {
      const batch = exampleIndex.slice(offset, offset + 10).map(({ recordId, vector }) => ({ recordId, vector }));
      await postApi('/api/demo/index-tools', { entries: batch });
    }
  }

  const dispatcher = new ToolDispatcher(registry);
  const intelligence = new ToolIntelligence({
    registry,
    dispatcher,
    embed,
    examples: exampleIndex,
    threshold: minimumScore,
    plausibleThreshold: plausibleScore,
    ambiguityMargin: candidateMargin,
    scoring,
    weights,
    maxOperations: config.maxOperations ?? 4,
    searchTools: async vector => {
      const response = await postApi('/api/demo/tools/search', { vector, limit: 20, threshold: plausibleScore, scoring, weights });
      return response.results;
    },
  });
  return { registry, dispatcher, intelligence, exampleIndex, providers: registryData.providers, data: registryData.data };
}
