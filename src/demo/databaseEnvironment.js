import { ToolDispatcher } from '../intelligence/dispatcher.js';
import { buildToolExampleIndex, ToolIntelligence } from '../intelligence/toolIntelligence.js';
import { ToolRegistry } from '../intelligence/toolRegistry.js';

export async function createDatabaseEnvironment({ registryData, embed, resolve, postApi, threshold = 0.35, ambiguityMargin = 0.04 }) {
  if (!registryData || !Array.isArray(registryData.providers) || !Array.isArray(registryData.tools)) {
    throw new TypeError('The demo registry response is invalid');
  }
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
  if (!registryData.toolEmbeddingsReady) {
    exampleIndex = await buildToolExampleIndex(registry.list().filter(tool => tool.available !== false), embed);
    for (let offset = 0; offset < exampleIndex.length; offset += 10) {
      const batch = exampleIndex.slice(offset, offset + 10).map(({ exampleId, vector }) => ({ exampleId, vector }));
      await postApi('/api/demo/index-tools', { entries: batch });
    }
  }

  const dispatcher = new ToolDispatcher(registry);
  const intelligence = new ToolIntelligence({
    registry,
    dispatcher,
    embed,
    resolve,
    examples: exampleIndex,
    threshold,
    ambiguityMargin,
    searchTools: async vector => {
      const response = await postApi('/api/demo/tools/search', { vector, limit: 5, threshold });
      return response.results;
    },
  });
  return { registry, dispatcher, intelligence, exampleIndex, providers: registryData.providers, data: registryData.data };
}
