import { ToolDispatcher } from '../intelligence/dispatcher.js';
import { buildToolExampleIndex, ToolIntelligence } from '../intelligence/toolIntelligence.js';
import { ToolRegistry } from '../intelligence/toolRegistry.js';

export async function createMockEnvironment({ manifests = [], providers = [], embed, resolve, searchTools, threshold = 0.35, ambiguityMargin = 0.04 }) {
  const registry = new ToolRegistry();
  for (const provider of providers) registry.registerProvider(provider);
  for (const tool of manifests) registry.registerTool(tool);
  const exampleIndex = await buildToolExampleIndex(registry.list(), embed);
  const dispatcher = new ToolDispatcher(registry);
  const intelligence = new ToolIntelligence({ registry, dispatcher, embed, resolve, examples: exampleIndex, searchTools, threshold, ambiguityMargin });
  return { registry, dispatcher, intelligence, exampleIndex };
}
