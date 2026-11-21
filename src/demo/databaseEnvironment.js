import { ToolDispatcher } from '../intelligence/dispatcher.js';
import { buildToolExampleIndex, ToolIntelligence, EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from '../intelligence/toolIntelligence.js';
import { normalizeArgumentsWithModel } from '../intelligence/argumentNormalization.js';
import { buildProviderDataIndex, searchProviderData as searchLocalProviderData } from '../intelligence/retrieval/providerData.js';
import { discoverTools } from '../intelligence/retrieval/semanticTools.js';
import { ToolRegistry } from '../intelligence/toolRegistry.js';
import { EMBEDDING_CACHE_VERSION } from '../intelligence/embeddingModel.js';
import alarmAdapter from '../providers/alarm/index.js';
import ankiAdapter from '../providers/anki/index.js';
import calendarAdapter from '../providers/calendar/index.js';
import knowledgeAdapter from '../providers/knowledge/index.js';
import notificationsAdapter from '../providers/notifications/index.js';
import webAdapter from '../providers/web/index.js';

const providerAdapters = new Map([
  alarmAdapter, ankiAdapter, calendarAdapter, knowledgeAdapter, notificationsAdapter, webAdapter,
].map(adapter => [adapter.id, adapter]));

export async function createDatabaseEnvironment({ database, registryData, embed, rerankTools, onRerankDecision, onUsage, onToolExecution, onIndexStart, normalizeArguments, argumentNormalizerEnabled, threshold = undefined, plausibleThreshold = undefined, ambiguityMargin = undefined, initialState, initializeRetrieval = true }) {
  if (!database || typeof database.getRegistryData !== 'function') throw new TypeError('A browser-local database is required.');
  registryData ??= await database.getRegistryData();
  if (!registryData || !Array.isArray(registryData.providers) || !Array.isArray(registryData.tools)) {
    throw new TypeError('The local tool registry is invalid.');
  }
  if (typeof embed !== 'function') throw new TypeError('A browser-side embedding function is required.');
  const config = registryData.toolRetrievalConfig ?? {};
  const minimumScore = threshold ?? config.minimumScore ?? 0.58;
  const plausibleScore = plausibleThreshold ?? config.plausibleScore ?? 0.38;
  const candidateMargin = ambiguityMargin ?? config.ambiguityMargin ?? 0.08;
  const scoring = config.scoring ?? 'weighted-max';
  const weights = config.weights ?? { description: 0.35, keyword: 0.3, example: 0.35 };
  const crossEncoder = config.crossEncoder ?? {};
  const registry = new ToolRegistry();
  const toolsById = new Map(registryData.tools.map(tool => [tool.id, tool]));
  const providersById = new Map(registryData.providers.map(provider => [provider.id, provider]));
  const validVector = vector => Array.isArray(vector) && vector.length === EMBEDDING_DIMENSIONS
    && vector.every(Number.isFinite) && Math.abs(Math.hypot(...vector) - 1) <= 0.002;
  const embedCached = async (text, purpose = 'request') => {
    const cached = await database.getCachedEmbedding(text, EMBEDDING_MODEL);
    if (cached?.model === EMBEDDING_MODEL && cached.version === EMBEDDING_CACHE_VERSION
      && cached.dimensions === EMBEDDING_DIMENSIONS && validVector(cached.vector)) {
      return { vector: cached.vector, dimensions: cached.dimensions };
    }
    const result = await embed(text, { purpose });
    const vector = Array.isArray(result) ? result : result.vector;
    const dimensions = result.dimensions ?? vector?.length;
    if (dimensions !== EMBEDDING_DIMENSIONS || !validVector(vector)) {
      throw new Error(`Unexpected embedding: expected ${EMBEDDING_DIMENSIONS} finite, normalized dimensions.`);
    }
    await database.cacheEmbedding(text, EMBEDDING_MODEL, dimensions, vector);
    return { vector, dimensions };
  };
  let providerDataIndex = [];
  let retrievalReady = false;
  const embedForIndex = text => embedCached(text, 'index');
  const indexProviderData = async () => {
    const freshRegistry = await database.getRegistryData();
    providerDataIndex = await buildProviderDataIndex({
      providers: freshRegistry.providers,
      data: freshRegistry.data,
      embed: embedForIndex,
      dimensions: EMBEDDING_DIMENSIONS,
    });
  };

  for (const provider of registryData.providers) {
    const adapter = providerAdapters.get(provider.id);
    registry.registerProvider({
      id: provider.id,
      available: provider.status === 'available',
      canExecute: Boolean(adapter),
      permissions: provider.manifest?.permissions ?? [],
      contextSearch: provider.manifest?.contextSearch,
      execute: async (toolId, args, context = {}) => {
        if (!adapter) throw new Error(`No trusted local adapter is registered for ${provider.id}.`);
        const tool = toolsById.get(toolId);
        const storedProvider = providersById.get(provider.id);
        if (!tool || !storedProvider || tool.providerId !== provider.id) throw new Error(`Tool is not registered for provider ${provider.id}: ${toolId}`);
        let result;
        const startedAt = performance.now();
        let succeeded = false;
        try {
          result = await database.executeRegisteredTool(
            tool,
            storedProvider,
            args,
            context,
            () => adapter.execute(toolId, args, { database }),
          );
          succeeded = true;
        } catch (error) {
          await onUsage?.('failures');
          throw error;
        } finally {
          onToolExecution?.(performance.now() - startedAt, succeeded);
        }
        await onUsage?.('executions');
        await onUsage?.('successes');
        if (tool.confirmation === 'required' && retrievalReady) {
          const finishIndex = onIndexStart?.();
          try { await indexProviderData(); } finally { finishIndex?.(); }
        }
        return result;
      },
    });
  }
  for (const tool of registryData.tools) {
    if (!registry.getProvider(tool.providerId)) throw new TypeError(`Tool references an unknown provider: ${tool.id}`);
    registry.registerTool(tool);
  }

  const exampleIndex = [];
  let retrievalAttempt;
  const ensureRetrieval = async () => {
    if (retrievalReady) return;
    if (!retrievalAttempt) {
      retrievalAttempt = (async () => {
        const finishIndex = onIndexStart?.();
        try {
          const examples = await buildToolExampleIndex(
            registry.list().filter(tool => tool.available !== false && registry.getProvider(tool.providerId)?.available !== false),
            embedForIndex,
          );
          await indexProviderData();
          exampleIndex.splice(0, exampleIndex.length, ...examples);
          retrievalReady = true;
        } finally { finishIndex?.(); }
      })();
    }
    const attempt = retrievalAttempt;
    try {
      await attempt;
    } finally {
      if (retrievalAttempt === attempt) retrievalAttempt = undefined;
    }
  };
  if (initializeRetrieval) await ensureRetrieval();

  const dispatcher = new ToolDispatcher(registry, { maxOperations: config.maxOperations ?? 8 });
  const intelligence = new ToolIntelligence({
    registry,
    dispatcher,
    embed: embedCached,
    examples: exampleIndex,
    rerankTools,
    onRerankDecision,
    rerankMinimumScore: crossEncoder.minimumScore ?? 0.20,
    rerankMargin: crossEncoder.margin ?? 0.10,
    threshold: minimumScore,
    plausibleThreshold: plausibleScore,
    ambiguityMargin: candidateMargin,
    scoring,
    weights,
    topK: config.topK ?? 5,
    maxOperations: config.maxOperations ?? 8,
    initialState,
    argumentNormalizerEnabled,
    normalizeArguments: normalizeArguments
      ? input => normalizeArgumentsWithModel(input, { generate: normalizeArguments, includeProviderEvidence: false })
      : undefined,
    searchTools: async (vector, options = {}) => discoverTools(vector, exampleIndex, {
      limit: options.limit ?? config.topK ?? 5,
      threshold: options.threshold ?? plausibleScore,
      strategy: options.scoring ?? scoring,
      weights: options.weights ?? weights,
    }),
    searchProviderData: async (vector, providerIds) => searchLocalProviderData(vector, providerDataIndex, {
      providerIds,
      limit: 3,
      threshold: 0.3,
    }),
  });
  return {
    registry,
    dispatcher,
    intelligence,
    exampleIndex,
    ensureRetrieval,
    get providerDataIndex() { return providerDataIndex; },
    providers: registryData.providers,
    data: registryData.data,
    demoClock: registryData.demoClock,
    registryData,
  };
}
