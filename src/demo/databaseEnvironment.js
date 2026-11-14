import { ToolDispatcher } from '../intelligence/dispatcher.js';
import { buildToolExampleIndex, ToolIntelligence } from '../intelligence/toolIntelligence.js';
import { normalizeArgumentsWithFallback } from '../intelligence/argumentNormalization.js';
import { buildProviderDataIndex } from '../intelligence/retrieval/providerData.js';
import { ToolRegistry } from '../intelligence/toolRegistry.js';

export async function createDatabaseEnvironment({ registryData, embed, postApi, normalizeArguments, fallbackNormalizeArguments, onNormalizerFallback, argumentNormalizerEnabled, threshold = undefined, plausibleThreshold = undefined, ambiguityMargin = undefined, initialState }) {
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
  let providerDataIndex = [];
  async function indexPendingProviderData(sourceRegistry) {
    const pendingIds = new Set(sourceRegistry.pendingProviderDataIds ?? []);
    const entries = await buildProviderDataIndex({
      providers: sourceRegistry.providers,
      data: sourceRegistry.data,
      embed,
      recordIds: pendingIds,
    });
    for (let offset = 0; offset < entries.length; offset += 10) {
      const batch = entries.slice(offset, offset + 10).map(({ providerId, recordType, recordId, contentHash, vector }) => ({
        providerId,
        recordType,
        recordId,
        contentHash,
        vector,
      }));
      await postApi('/api/demo/index-provider-data', { entries: batch });
    }
    return entries;
  }
  async function refreshProviderData() {
    const response = await fetch('/api/demo/registry', { credentials: 'same-origin', cache: 'no-store' });
    const freshRegistry = await response.json();
    if (!response.ok) throw new Error(freshRegistry.error ?? `Provider-data refresh failed (${response.status})`);
    providerDataIndex = await indexPendingProviderData(freshRegistry);
  }
  for (const provider of registryData.providers) {
    registry.registerProvider({
      id: provider.id,
      available: provider.status === 'available',
      canExecute: true,
      permissions: [],
      contextSearch: provider.manifest?.contextSearch,
      execute: async (toolId, args, { confirmed, operationId } = {}) => {
        const response = await postApi('/api/demo/execute', { toolId, arguments: args, confirmed: confirmed === true, operationId });
        if (registry.get(toolId)?.effect === 'side_effecting') await refreshProviderData();
        return response.result;
      },
    });
  }
  for (const tool of registryData.tools) {
    if (!registry.getProvider(tool.providerId)) throw new TypeError(`Tool references an unknown provider: ${tool.id}`);
    registry.registerTool(tool);
  }

  providerDataIndex = await indexPendingProviderData(registryData);
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
    topK: config.topK ?? 5,
    maxOperations: config.maxOperations ?? 4,
    initialState,
    argumentNormalizerEnabled,
    normalizeArguments: normalizeArguments
      ? input => normalizeArgumentsWithFallback(input, { primary: normalizeArguments, fallback: fallbackNormalizeArguments, onFallback: onNormalizerFallback })
      : undefined,
    searchTools: async vector => {
      const response = await postApi('/api/demo/tools/search', { vector, limit: config.topK ?? 5, threshold: plausibleScore, scoring, weights });
      return response.results;
    },
    searchProviderData: async (vector, providerIds) => {
      const response = await postApi('/api/demo/provider-data/search', { vector, providerIds, limit: 3, threshold: 0.3 });
      return response.results;
    },
  });
  return { registry, dispatcher, intelligence, exampleIndex, providerDataIndex, providers: registryData.providers, data: registryData.data };
}
