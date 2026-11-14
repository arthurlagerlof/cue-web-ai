import { detectAmbiguity, discoverTools } from './retrieval/semanticTools.js';
import { clarificationForResolution, resolveArguments } from './argumentResolution.js';

export const EMBEDDING_MODEL = 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2';
export const EMBEDDING_DIMENSIONS = 384;

export async function buildToolExampleIndex(tools, embed, { model = EMBEDDING_MODEL, dimensions = EMBEDDING_DIMENSIONS, recordIds } = {}) {
  const index = [];
  for (const tool of tools) {
    const entries = [
      { sourceType: 'description', text: tool.description, recordId: `${tool.id}:0` },
      ...(tool.keywords ?? []).map((text, ordinal) => ({ sourceType: 'keyword', text, recordId: `${tool.id}:keyword:${ordinal}` })),
      ...(tool.examples ?? []).map((example, ordinal) => ({ sourceType: 'example', text: typeof example === 'string' ? example : example.text, locale: typeof example === 'string' ? undefined : example.locale, recordId: `${tool.id}:${ordinal + 1}` })),
    ];
    for (const entry of entries) {
      if (recordIds && !recordIds.has(entry.recordId)) continue;
      const result = await embed(entry.text);
      const vector = Array.isArray(result) ? result : result.vector;
      const actualDimensions = result.dimensions ?? vector?.length;
      if (!Array.isArray(vector) || actualDimensions !== dimensions || vector.length !== dimensions) throw new Error(`Unexpected embedding for ${tool.id}: expected ${dimensions} dimensions`);
      index.push({ namespace: 'tool', providerId: tool.providerId, toolId: tool.id, sourceType: entry.sourceType, locale: entry.locale, recordId: entry.recordId, text: entry.text, vector, model, dimensions });
    }
  }
  return index;
}

export function splitActionClauses(request) {
  const parts = request.split(/\s+(?:and\s+then|then|and|also|ja\s+sitten|ja)\s+/i);
  if (parts.length < 2 || parts.length > 4) return [request.trim()];
  const actionStart = /^(?:(?:please|then)\s+)?(?:find|search|look\s+up|show|open|retrieve|create|add|set|schedule|update|delete|remove|disable|enable|check|etsi|hae|näytä|nayta|avaa|luo|lisää|lisaa|aseta|varaa|siirrä|siirra|muuta|tarkista)\b/i;
  if (parts.slice(1).every(part => actionStart.test(part.trim()))) return parts.map(part => part.trim()).filter(Boolean);
  return [request.trim()];
}

export class ToolIntelligence {
  constructor({ registry, dispatcher, embed, examples, searchTools, threshold = 0.55, plausibleThreshold, ambiguityMargin = 0.08, weights, scoring = 'weighted-max', maxOperations = 4 }) {
    this.registry = registry; this.dispatcher = dispatcher; this.embed = embed; this.examples = examples; this.searchTools = searchTools;
    this.threshold = threshold; this.plausibleThreshold = plausibleThreshold ?? threshold; this.ambiguityMargin = ambiguityMargin; this.weights = weights; this.scoring = scoring; this.maxOperations = maxOperations;
    this.pendingOperation = undefined;
  }

  cancelPendingOperation() {
    const hadPending = this.pendingOperation !== undefined;
    this.pendingOperation = undefined;
    return hadPending;
  }

  async retrieve(segment) {
    const query = await this.embed(segment);
    const vector = Array.isArray(query) ? query : query.vector;
    const candidates = this.searchTools
      ? await this.searchTools(vector, { threshold: this.plausibleThreshold, limit: 20, scoring: this.scoring, weights: this.weights })
      : discoverTools(vector, this.examples, { threshold: this.plausibleThreshold, limit: 20, strategy: this.scoring, weights: this.weights });
    const ranked = candidates.map(item => ({ ...item, definition: this.registry.get(item.toolId) }))
      .filter(item => item.definition && item.definition.available !== false && this.registry.getProvider(item.definition.providerId)?.available !== false);
    if (!ranked.length) return { kind: 'no_tool' };
    const ambiguity = detectAmbiguity(ranked, { minimumScore: this.threshold, plausibleScore: this.plausibleThreshold, margin: this.ambiguityMargin });
    if (ambiguity === 'no_match') return { kind: 'no_tool' };
    if (ambiguity === 'ambiguous') return { kind: 'ambiguous', candidates: ranked.slice(0, 2) };
    return { kind: 'selected', definition: ranked[0].definition, retrieval: ranked[0] };
  }

  async handle(transcription, { confirmed = false, context = {} } = {}) {
    const text = transcription.trim();
    if (!text) return { kind: 'clarification', question: 'What would you like Cue to do?' };
    const segments = this.pendingOperation ? [text] : splitActionClauses(text);
    if (segments.length > this.maxOperations) return { kind: 'clarification', question: `I can handle at most ${this.maxOperations} operations at once. Please split the request.` };
    const operationResults = [];
    const executed = new Set();
    let previous = this.pendingOperation?.arguments ?? {};
    for (const [index, segment] of segments.entries()) {
      const match = this.pendingOperation
        ? { kind: 'selected', definition: this.registry.get(this.pendingOperation.toolId), retrieval: undefined }
        : await this.retrieve(segment);
      if (match.kind === 'no_tool') return operationResults.length ? { kind: 'partial_failure', text: 'No tool matched a remaining action.', results: operationResults } : { kind: 'no_tool', text: 'No matching local tool was found.' };
      if (match.kind === 'ambiguous') return { kind: 'clarification', question: `Did you mean ${match.candidates.map(item => item.definition.name).join(' or ')}?`, candidates: match.candidates.map(({ toolId, score, definition }) => ({ toolId, score, name: definition.name })), diagnostics: match.candidates };
      const tool = match.definition;
      const provider = this.registry.getProvider(tool.providerId);
      const providerLookup = provider?.resolveArgument
        ? (name, request, schema) => provider.resolveArgument({ tool, name, request, schema, conversation: context.conversation, toolResults: operationResults.map(item => item.data) })
        : context.providerLookup;
      const resolution = resolveArguments({ request: segment, tool, previous, context: { ...context, providerLookup, originalRequest: text, currentIntentSegment: segment, toolResults: operationResults.map(item => item.data) } });
      if (!resolution.complete) {
        this.pendingOperation = { toolId: tool.id, arguments: resolution.fields, originalRequest: this.pendingOperation?.originalRequest ?? text, remainingSegments: segments.slice(index + 1) };
        return { kind: 'clarification', question: clarificationForResolution(tool, resolution), resolution, toolId: tool.id, retrieval: match.retrieval, completedOperations: operationResults };
      }
      const call = { toolId: tool.id, arguments: resolution.arguments };
      const signature = JSON.stringify(call);
      if (executed.has(signature)) return { kind: 'clarification', question: 'The request would repeat an operation. Please clarify which distinct action you want.' };
      executed.add(signature);
      let result;
      try { result = await this.dispatcher.dispatch(call, { confirmed }); }
      catch (error) {
        if (operationResults.length) return { kind: 'partial_failure', text: `An operation failed after ${operationResults.length} earlier operation(s).`, error: error instanceof Error ? error.message : String(error), results: operationResults };
        throw error;
      }
      if (result.state === 'confirmation_required') {
        this.pendingOperation = undefined;
        return { kind: 'confirmation_required', ...result, pendingCall: call, resolution, retrieval: match.retrieval, completedOperations: operationResults };
      }
      operationResults.push({ toolId: tool.id, arguments: call.arguments, data: result.data, document: result.document, resolution, retrieval: match.retrieval });
      previous = resolution.fields;
    }
    this.pendingOperation = undefined;
    const last = operationResults.at(-1);
    return { kind: 'document', document: last.document, results: operationResults.map(({ toolId, arguments: args, data }) => ({ toolId, arguments: args, data })), resolution: last.resolution, retrieval: last.retrieval };
  }
}
