import { detectAmbiguity, discoverTools } from './retrieval/semanticTools.js';
import { validateArguments } from './toolRegistry.js';

function validateResolution(resolution) {
  const record = value => value && typeof value === 'object' && !Array.isArray(value);
  if (!record(resolution)) throw new TypeError('Intent resolver output must be an object');
  const exactKeys = keys => Object.keys(resolution).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(resolution, key));
  if (resolution.kind === 'answer' && exactKeys(['kind', 'text']) && typeof resolution.text === 'string') return resolution;
  if (resolution.kind === 'clarification' && exactKeys(['kind', 'question']) && typeof resolution.question === 'string') return resolution;
  if (resolution.kind === 'tool' && exactKeys(['kind', 'toolId', 'arguments']) && typeof resolution.toolId === 'string' && record(resolution.arguments)) return resolution;
  if (resolution.kind === 'multi_tool' && exactKeys(['kind', 'operations']) && Array.isArray(resolution.operations) && resolution.operations.length > 0 && resolution.operations.every(operation => record(operation) && Object.keys(operation).every(key => ['id', 'toolId', 'arguments', 'dependsOn'].includes(key)) && typeof operation.id === 'string' && typeof operation.toolId === 'string' && record(operation.arguments) && (operation.dependsOn === undefined || Array.isArray(operation.dependsOn) && operation.dependsOn.every(id => typeof id === 'string')))) return resolution;
  throw new TypeError('Intent resolver output does not match the structured resolution schema');
}

export const EMBEDDING_MODEL = 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2';
export const EMBEDDING_DIMENSIONS = 384;

export async function buildToolExampleIndex(tools, embed, { model = EMBEDDING_MODEL, dimensions = EMBEDDING_DIMENSIONS } = {}) {
  const index = [];
  for (const tool of tools) for (const [ordinal, example] of [tool.description, ...tool.examples].entries()) {
    const result = await embed(example);
    const vector = Array.isArray(result) ? result : result.vector;
    const actualDimensions = result.dimensions ?? vector?.length;
    if (!Array.isArray(vector) || actualDimensions !== dimensions || vector.length !== dimensions) throw new Error(`Unexpected embedding for ${tool.id}: expected ${dimensions} dimensions`);
    index.push({ namespace: 'tool', ownerType: 'tool_example', ownerId: `${tool.id}:${ordinal}`, exampleId: `${tool.id}:${ordinal}`, toolId: tool.id, text: example, vector, model, dimensions });
  }
  return index;
}

export class ToolIntelligence {
  constructor({ registry, dispatcher, embed, resolve, examples, searchTools, threshold = 0.35, ambiguityMargin = 0.04 }) {
    this.registry = registry; this.dispatcher = dispatcher; this.embed = embed; this.resolve = resolve; this.examples = examples; this.searchTools = searchTools;
    this.threshold = threshold; this.ambiguityMargin = ambiguityMargin;
  }
  async handle(transcription, { confirmed = false } = {}) {
    const text = transcription.trim();
    if (!text) return { kind: 'clarification', question: 'What would you like Cue to do?' };
    const query = await this.embed(text);
    const vector = Array.isArray(query) ? query : query.vector;
    const candidates = this.searchTools
      ? await this.searchTools(vector, { threshold: this.threshold, limit: 5 })
      : discoverTools(vector, this.examples, { threshold: this.threshold, limit: 5 });
    const ambiguity = detectAmbiguity(candidates, { minimumScore: this.threshold, margin: this.ambiguityMargin });
    if (ambiguity === 'no_match') return { kind: 'no_tool', text: 'No matching local tool was found.' };
    const ranked = candidates.map(item => ({ ...item, definition: this.registry.get(item.toolId) }))
      .filter(item => item.definition && item.definition.available !== false && this.registry.getProvider(item.definition.providerId)?.available !== false);
    if (!ranked.length) return { kind: 'no_tool', text: 'No matching local tool was found.' };
    const resolution = validateResolution(await this.resolve({ transcription: text, candidates: ranked.map(({ toolId, score, definition }) => ({ toolId, score, name: definition.name, description: definition.description, parameters: definition.parameters })) }));
    if (resolution.kind === 'answer' || resolution.kind === 'clarification') return resolution;
    const permittedIds = new Set(ranked.map(candidate => candidate.toolId));
    const operations = resolution.kind === 'tool' ? [{ id: 'operation-1', toolId: resolution.toolId, arguments: resolution.arguments }] : resolution.operations;
    if (!Array.isArray(operations) || !operations.length) throw new TypeError('Tool resolution requires operations');
    for (const operation of operations) {
      if (!permittedIds.has(operation.toolId)) throw new TypeError(`Resolver selected an unregistered or unretrieved tool: ${operation.toolId}`);
      if (operation.arguments && !Object.values(operation.arguments).some(value => value && typeof value === 'object' && '$from' in value)) {
        const validation = validateArguments(this.registry.get(operation.toolId).parameters, operation.arguments);
        if (!validation.valid) return { kind: 'clarification', question: `Please clarify the required details for ${this.registry.get(operation.toolId).name}.`, errors: validation.errors };
      }
    }
    const result = operations.length === 1
      ? await this.dispatcher.dispatch({ toolId: operations[0].toolId, arguments: operations[0].arguments }, { confirmed })
      : await this.dispatcher.dispatchPlan({ operations }, { confirmed });
    return result.state === 'confirmation_required'
      ? { kind: 'confirmation_required', ...result, pendingCall: operations.length === 1 ? { toolId: operations[0].toolId, arguments: operations[0].arguments } : undefined, pendingPlan: operations.length > 1 ? { operations } : undefined }
      : { kind: 'document', document: result.document, results: result.results };
  }
}
