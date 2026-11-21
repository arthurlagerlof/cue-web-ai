import { detectAmbiguity, discoverTools } from './retrieval/semanticTools.js';
import { clarificationForResolution, resolveArguments } from './argumentResolution.js';
import { normalizeArgumentsWithModel, shouldNormalizeArguments } from './argumentNormalization.js';
import { assertExecutionPlan, MAX_PLAN_OPERATIONS, PLAN_SCHEMA, PLAN_VERSION, readJsonPointer } from './executionPlan.js';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from './embeddingModel.js';

export { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from './embeddingModel.js';

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
  if (parts.length < 2) return [request.trim()];
  const actionStart = /^(?:(?:please|then)\s+)?(?:find|search|look\s+up|show|open|retrieve|create|add|set|schedule|update|delete|remove|disable|enable|check|etsi|hae|näytä|nayta|avaa|luo|lisää|lisaa|aseta|varaa|siirrä|siirra|muuta|tarkista)\b/i;
  if (parts.slice(1).every(part => actionStart.test(part.trim()))) return parts.map(part => part.trim()).filter(Boolean);
  return [request.trim()];
}

export function clarificationRestart(text) {
  const trimmed = text.trim();
  if (/^(?:go back|start over|restart|cancel|stop|never mind|nevermind)[.!?]*$/i.test(trimmed)) return '';
  const match = trimmed.match(/^(?:no[, ]+)?(?:i meant|i mean|what i meant was|instead[, ]+i (?:meant|mean))\s*[,:\-]?\s+(.+)$/i);
  return match ? match[1].trim() : undefined;
}

export function clarificationHasCompletedSideEffects(state) {
  return Boolean(state?.seenSideEffects?.length || state?.executionState?.executedSideEffects?.length);
}

export function requiresExternalPlanning(request) {
  const text = request.toLocaleLowerCase();
  if (splitActionClauses(request).length > 1) return 'multiple dependent actions';
  if (/\b(?:each|every|all)\b/.test(text) && /\b(?:create|set|add|send|update|summari[sz]e|compare|prepare)\b/.test(text)) {
    return 'collection iteration';
  }
  if (/\b(?:first|earliest|latest|matching|related|same|that|those|them|it)\b/.test(text)
    && /\b(?:and|then|before|after|for|with|using)\b/.test(text)) return 'contextual result reference';
  if (/\b(?:alarm|reminder)\b/.test(text)
    && /\b(?:before|after|beforehand|earlier|later)\b/.test(text)
    && !/\b\d+(?:\.\d+)?\s*(?:seconds?|minutes?|mins?|hours?|hrs?|days?)\b/.test(text)) {
    return 'implicit event context';
  }
  if (/\b(?:garden work|team meeting|dentist appointment|project review|family visit|grocery shopping)\b/.test(text)
    && /\b(?:tomorrow|today|this week|next week)\b/.test(text)
    && /\b(?:set|create|add|prepare|find|before|after)\b/.test(text)) return 'implicit provider discovery';
  return undefined;
}

export class ToolIntelligence {
  constructor({ registry, dispatcher, embed, examples, searchTools, searchProviderData, rerankTools, onRerankDecision, rerankMinimumScore = 0.20, rerankMargin = 0.10, normalizeArguments, argumentNormalizerEnabled = () => true, threshold = 0.55, plausibleThreshold, ambiguityMargin = 0.08, weights, scoring = 'weighted-max', topK = 5, maxOperations = 8, initialState }) {
    this.registry = registry; this.dispatcher = dispatcher; this.embed = embed; this.examples = examples; this.searchTools = searchTools;
    this.searchProviderData = searchProviderData; this.rerankTools = rerankTools; this.onRerankDecision = onRerankDecision; this.rerankMinimumScore = rerankMinimumScore; this.rerankMargin = rerankMargin;
    this.normalizeArguments = normalizeArguments; this.argumentNormalizerEnabled = argumentNormalizerEnabled;
    this.threshold = threshold; this.plausibleThreshold = plausibleThreshold ?? threshold; this.ambiguityMargin = ambiguityMargin; this.weights = weights; this.scoring = scoring; this.topK = Math.max(2, Math.floor(topK)); this.maxOperations = Math.max(1, Math.min(MAX_PLAN_OPERATIONS, Math.floor(maxOperations)));
    this.workflow = undefined;
    if (initialState) this.restoreState(initialState);
  }

  getState() {
    return this.workflow ? JSON.parse(JSON.stringify(this.workflow)) : { status: 'idle' };
  }

  requiresExternalPlanning(request) {
    return requiresExternalPlanning(request);
  }

  restoreState(state) {
    const statuses = new Set(['awaiting_tool_choice', 'awaiting_argument', 'awaiting_entity_choice', 'awaiting_confirmation', 'executing', 'completed', 'failed', 'cancelled']);
    if (!state || typeof state !== 'object' || !statuses.has(state.status) || !Array.isArray(state.segments) || !Number.isInteger(state.currentIndex)) {
      throw new TypeError('Persisted conversation state is invalid');
    }
    this.workflow = JSON.parse(JSON.stringify(state));
    if (this.workflow.executionPlan) assertExecutionPlan(this.workflow.executionPlan, this.registry);
  }

  ensureExecutionPlan(workflow) {
    if (!workflow.executionPlan) {
      workflow.executionPlan = {
        schema: PLAN_SCHEMA,
        version: PLAN_VERSION,
        id: `plan_${workflow.conversationId}`,
        conversationId: workflow.conversationId,
        originalRequest: workflow.originalRequest,
        status: 'running',
        operations: [],
      };
    }
    return workflow.executionPlan;
  }

  currentPlanOperation(workflow, tool, purpose) {
    const plan = this.ensureExecutionPlan(workflow);
    const id = `${workflow.conversationId}:${workflow.currentIndex}`;
    let operation = plan.operations.find(item => item.id === id);
    if (!operation) {
      const previous = plan.operations.at(-1);
      operation = {
        id,
        toolId: tool.id,
        purpose,
        arguments: {},
        dependsOn: previous ? [previous.id] : [],
        inputBindings: [],
        conditions: [],
        status: 'pending',
        requiresConfirmation: tool.confirmation === 'required',
      };
      plan.operations.push(operation);
    } else if (operation.toolId !== tool.id) {
      throw new Error('The selected tool no longer matches the stored operation');
    }
    operation.status = 'ready';
    plan.status = 'running';
    assertExecutionPlan(plan, this.registry);
    return operation;
  }

  cancelPendingOperation() {
    const hadPending = Boolean(this.workflow && !['completed', 'cancelled'].includes(this.workflow.status));
    if (hadPending) {
      this.workflow.status = 'cancelled';
      this.workflow.pendingArguments = [];
      this.workflow.pendingConfirmation = null;
      if (this.workflow.executionPlan) this.workflow.executionPlan.status = 'cancelled';
      this.workflow.updatedAt = new Date().toISOString();
    }
    return hadPending;
  }

  clarification(workflow, kind, question, extra = {}) {
    workflow.status = kind;
    workflow.pendingQuestion = question;
    const plan = this.ensureExecutionPlan(workflow);
    plan.status = 'waiting_for_input';
    const operation = plan.operations.find(item => item.id === `${workflow.conversationId}:${workflow.currentIndex}`);
    if (operation && !['succeeded', 'failed', 'skipped'].includes(operation.status)) operation.status = 'waiting_for_input';
    assertExecutionPlan(plan, this.registry);
    workflow.updatedAt = new Date().toISOString();
    workflow.remainingIntentSegments = workflow.segments.slice(workflow.currentIndex + 1);
    return { kind: 'clarification', question, ...extra, state: this.getState() };
  }

  resolveToolChoice(text, candidates) {
    const normalized = text.toLocaleLowerCase().trim();
    if (!normalized || /^(?:yes|yeah|yep|sure|ok|okay)$/i.test(normalized)) return undefined;
    const matched = candidates.map(candidate => {
      const name = candidate.name?.toLocaleLowerCase();
      const id = candidate.toolId?.toLocaleLowerCase();
      if (normalized === id || normalized === name || (name && normalized.includes(name)) || (id && normalized.includes(id))) return { candidate, score: 1 };
      const requestTokens = new Set(normalized.match(/[\p{L}\p{N}]+/gu) ?? []);
      const candidateTokens = [...new Set(`${name ?? ''} ${id ?? ''}`.match(/[\p{L}\p{N}]+/gu) ?? [])].filter(token => !['search', 'find', 'the', 'a', 'an', 'tool'].includes(token));
      const overlap = candidateTokens.filter(token => requestTokens.has(token)).length;
      return { candidate, score: candidateTokens.length ? overlap / candidateTokens.length : 0 };
    }).filter(item => item.score >= 0.5).sort((left, right) => right.score - left.score);
    if (!matched.length || (matched[1] && matched[0].score - matched[1].score < 0.25)) return undefined;
    return matched[0].candidate.toolId;
  }

  toolChoiceRemainder(text, candidate) {
    let remainder = text;
    for (const token of `${candidate.name ?? ''} ${candidate.toolId ?? ''}`.match(/[\p{L}\p{N}]+/gu) ?? []) {
      remainder = remainder.replace(new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'), ' ');
    }
    return remainder.replace(/\b(?:please|my|the|tool|choice|select|use|search|find)\b/gi, ' ')
      .replace(/^[\s,.;:!?-]+|[\s,.;:!?-]+$/g, '')
      .trim();
  }

  static isAffirmative(text) {
    return /^(?:yes|yeah|yep|sure|ok|okay|confirm|confirmed|do it|go ahead)$/i.test(text.trim());
  }

  static isCancellation(text) {
    return /^(?:cancel|stop|never mind|nevermind|no|don't|do not)$/i.test(text.trim());
  }

  async retrieve(segment) {
    const query = await this.embed(segment);
    const vector = Array.isArray(query) ? query : query.vector;
    const candidates = this.searchTools
      ? await this.searchTools(vector, { threshold: this.plausibleThreshold, limit: this.topK, scoring: this.scoring, weights: this.weights })
      : discoverTools(vector, this.examples, { threshold: this.plausibleThreshold, limit: this.topK, strategy: this.scoring, weights: this.weights });
    let ranked = candidates.map(item => ({ ...item, definition: this.registry.get(item.toolId) }))
      .filter(item => item.definition && item.definition.available !== false && this.registry.getProvider(item.definition.providerId)?.available !== false);
    if (!ranked.length) return { kind: 'no_tool' };
    if (this.searchProviderData) {
      const evidence = await this.searchProviderData(vector, [...new Set(ranked.map(item => item.definition.providerId))]);
      ranked = ranked.map(item => ({
        ...item,
        providerEvidence: this.registry.getProvider(item.definition.providerId)?.contextSearch
          ? evidence[item.definition.providerId] ?? { namespace: 'provider-data', indexedAt: undefined, hits: [] }
          : undefined,
      }));
    }
    let ambiguity = detectAmbiguity(ranked, { minimumScore: this.threshold, plausibleScore: this.plausibleThreshold, margin: this.ambiguityMargin });
    let rerankDiagnostics;
    if (ambiguity === 'ambiguous' && this.rerankTools) {
      try {
        const candidatesToRerank = ranked.slice(0, this.topK);
        const scores = await this.rerankTools(segment, candidatesToRerank.map(item => ({
          toolId: item.toolId,
          text: [item.definition.description, ...(item.definition.examples ?? []).map(example => typeof example === 'string' ? example : example.text)].filter(Boolean).join('\n'),
        })));
        if (!Array.isArray(scores) || scores.length !== candidatesToRerank.length
          || new Set(scores.map(item => item?.toolId)).size !== candidatesToRerank.length
          || scores.some(item => !item || !candidatesToRerank.some(candidate => candidate.toolId === item.toolId)
            || typeof item.score !== 'number' || !Number.isFinite(item.score) || item.score < 0 || item.score > 1)) {
          throw new TypeError('Cross-encoder returned invalid candidate scores');
        }
        const scoreById = new Map(scores.map(item => [item.toolId, item.score]));
        ranked = candidatesToRerank
          .filter(item => scoreById.has(item.toolId))
          .map(item => ({ ...item, crossEncoderScore: scoreById.get(item.toolId) }))
          .sort((left, right) => right.crossEncoderScore - left.crossEncoderScore);
        const topScore = ranked[0].crossEncoderScore;
        const secondScore = ranked[1]?.crossEncoderScore ?? null;
        const leadingMargin = secondScore === null ? null : topScore - secondScore;
        const scorePassed = topScore >= this.rerankMinimumScore;
        const marginPassed = leadingMargin === null || leadingMargin + Number.EPSILON >= this.rerankMargin;
        ambiguity = scorePassed && marginPassed ? 'matched' : 'ambiguous';
        rerankDiagnostics = {
          stage: 'cross_encoder',
          candidates: ranked.map(({ toolId, crossEncoderScore }) => ({ toolId, score: crossEncoderScore })),
          topScore, secondScore, margin: leadingMargin,
          minimumScore: this.rerankMinimumScore, minimumMargin: this.rerankMargin,
          scorePassed, marginPassed, decision: ambiguity === 'matched' ? 'selected' : 'ambiguous',
        };
      } catch (error) {
        rerankDiagnostics = { stage: 'cross_encoder', error: error instanceof Error ? error.message : String(error) };
      }
      if (rerankDiagnostics.candidates) this.onRerankDecision?.(rerankDiagnostics);
    }
    if (ambiguity === 'no_match') return { kind: 'no_tool' };
    if (ambiguity === 'ambiguous') return { kind: 'ambiguous', candidates: ranked.slice(0, 2), diagnostics: rerankDiagnostics };
    return { kind: 'selected', definition: ranked[0].definition, retrieval: { ...ranked[0], rerankDiagnostics } };
  }

  async handle(transcription, { confirmed = false, context = {} } = {}) {
    const text = transcription.trim();
    if (!text) return { kind: 'clarification', question: 'What would you like Cue to do?' };
    if (text.length > 10000) return { kind: 'clarification', question: 'Please keep each request under 10,000 characters.' };
    let workflow = this.workflow;
    let followup = false;
    let authorizePending = confirmed;
    let correctionText;
    if (workflow && ['awaiting_tool_choice', 'awaiting_argument', 'awaiting_entity_choice', 'awaiting_confirmation'].includes(workflow.status)) {
      if (ToolIntelligence.isCancellation(text)) {
        this.cancelPendingOperation();
        return { kind: 'cancelled', text: 'The pending operation was cancelled.', state: this.getState() };
      }
      if (workflow.status === 'awaiting_tool_choice') {
        const choice = this.resolveToolChoice(text, workflow.candidateTools);
        if (!choice) return this.clarification(workflow, 'awaiting_tool_choice', `Please choose ${workflow.candidateTools.map(item => item.name).join(' or ')}.`, { candidates: workflow.candidateTools });
        const selectedCandidate = workflow.candidateTools.find(candidate => candidate.toolId === choice);
        const remainder = selectedCandidate ? this.toolChoiceRemainder(text, selectedCandidate) : '';
        workflow.selectedToolId = choice;
        workflow.status = 'executing';
        if (remainder) {
          correctionText = remainder;
          followup = true;
        }
      } else if (workflow.status === 'awaiting_confirmation') {
        if (confirmed || ToolIntelligence.isAffirmative(text)) {
          authorizePending = true;
          workflow.status = 'executing';
        } else {
          correctionText = text;
          followup = true;
          workflow.status = 'executing';
        }
      } else if (workflow.status === 'awaiting_entity_choice') {
        const options = workflow.pendingEntityOptions ?? [];
        const normalized = text.toLocaleLowerCase().trim();
        const ordinal = /^(?:1|first|the first one)$/i.test(normalized) ? 0
          : /^(?:2|second|the second one)$/i.test(normalized) ? 1
            : /^(?:3|third|the third one)$/i.test(normalized) ? 2 : -1;
        const matches = options.filter(option => normalized === String(option.id).toLocaleLowerCase() || normalized === String(option.label).toLocaleLowerCase() || String(option.label).toLocaleLowerCase().includes(normalized));
        const choice = ordinal >= 0 ? options[ordinal] : matches.length === 1 ? matches[0] : undefined;
        if (!choice) {
          return this.clarification(workflow, 'awaiting_entity_choice', `Please choose ${options.map((option, index) => `${index + 1}: ${option.label}`).join(' or ')}.`, { entities: options });
        }
        workflow.resolvedArguments[workflow.pendingEntityField] = { value: choice.id, source: 'provider_lookup', method: 'explicit-entity-choice', originalText: text };
        workflow.pendingEntityOptions = [];
        workflow.pendingEntityField = undefined;
        workflow.status = 'executing';
      } else if (workflow.status === 'awaiting_argument') {
        correctionText = text;
        followup = true;
        workflow.status = 'executing';
      } else {
        correctionText = text;
        followup = true;
        workflow.status = 'executing';
      }
    } else if (workflow?.status === 'failed' && /^retry$/i.test(text)) {
      workflow.status = 'executing';
      workflow.pendingConfirmation = null;
      workflow.selectedToolId ??= workflow.pendingOperation?.toolId ?? null;
    } else {
      const segments = splitActionClauses(text);
      if (segments.length > this.maxOperations) return { kind: 'clarification', question: `I can handle at most ${this.maxOperations} operations at once. Please split the request.` };
      const now = context.now instanceof Date ? context.now.toISOString() : new Date(context.now ?? Date.now()).toISOString();
      workflow = this.workflow = {
        conversationId: globalThis.crypto?.randomUUID?.() ?? `conversation-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        status: 'executing',
        originalRequest: text,
        currentRequestSegment: segments[0],
        segments,
        currentIndex: 0,
        remainingIntentSegments: segments.slice(1),
        candidateTools: [],
        selectedToolId: null,
        resolvedArguments: {},
        pendingArguments: [],
        completedOperations: [],
        toolResults: [],
        pendingOperation: null,
        pendingConfirmation: null,
        context: { now, timeZone: context.timeZone ?? 'UTC', locale: context.locale ?? 'en' },
        seenSideEffects: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      };
    }

    workflow.context = { ...workflow.context, ...context, now: workflow.context?.now ?? context.now };
    const operationResults = workflow.completedOperations;
    while (workflow.currentIndex < workflow.segments.length) {
      const segment = workflow.segments[workflow.currentIndex];
      workflow.currentRequestSegment = segment;
      workflow.remainingIntentSegments = workflow.segments.slice(workflow.currentIndex + 1);
      const plan = this.ensureExecutionPlan(workflow);
      const savedRetrieval = Array.isArray(workflow.retrieval)
        ? workflow.retrieval.find(item => item.toolId === workflow.selectedToolId)
        : workflow.retrieval;
      const match = workflow.selectedToolId
        ? { kind: 'selected', definition: this.registry.get(workflow.selectedToolId), retrieval: savedRetrieval }
        : await this.retrieve(segment);
      if (match.kind === 'no_tool') {
        workflow.status = operationResults.length ? 'failed' : 'completed';
        plan.status = operationResults.length ? 'failed' : 'completed';
        assertExecutionPlan(plan, this.registry);
        return operationResults.length ? { kind: 'partial_failure', text: 'No tool matched a remaining action.', results: operationResults, state: this.getState() } : { kind: 'no_tool', text: 'No matching local tool was found.', state: this.getState() };
      }
      if (match.kind === 'ambiguous') {
        workflow.candidateTools = match.candidates.slice(0, 2).map(({ toolId, score, definition }) => ({ toolId, score, name: definition.name }));
        workflow.selectedToolId = null;
        workflow.retrieval = match.candidates;
        return this.clarification(workflow, 'awaiting_tool_choice', `Did you mean ${workflow.candidateTools.map(item => item.name).join(' or ')}?`, { candidates: workflow.candidateTools, diagnostics: { candidates: match.candidates, rerank: match.diagnostics } });
      }
      const tool = match.definition;
      if (!tool) {
        workflow.status = 'failed';
        plan.status = 'failed';
        assertExecutionPlan(plan, this.registry);
        return { kind: 'partial_failure', text: 'The selected tool is no longer registered.', results: operationResults, state: this.getState() };
      }
      const planOperation = this.currentPlanOperation(workflow, tool, segment);
      workflow.selectedToolId = tool.id;
      workflow.retrieval = match.retrieval;
      const provider = this.registry.getProvider(tool.providerId);
      const toolResults = operationResults.map(item => item.data);
      const providerLookup = provider?.resolveArgument
        ? (name, request, schema) => provider.resolveArgument({ tool, name, request, schema, conversation: context.conversation, toolResults })
        : context.providerLookup;
      const argumentRequest = correctionText ?? (followup ? text : segment);
      let resolution = resolveArguments({
        request: argumentRequest,
        tool,
        previous: workflow.resolvedArguments,
        context: { ...workflow.context, ...context, providerLookup, providerEvidence: match.retrieval?.providerEvidence, originalRequest: workflow.originalRequest, currentIntentSegment: segment, toolResults },
      });
      if (!resolution.complete && this.normalizeArguments && this.argumentNormalizerEnabled() && shouldNormalizeArguments({
        tool,
        request: argumentRequest,
        originalRequest: workflow.originalRequest,
        resolution,
      })) {
        try {
          const normalized = await this.normalizeArguments({
            originalRequest: workflow.originalRequest,
            request: argumentRequest,
            conversation: workflow.conversation ?? [],
            tool,
            deterministicArguments: resolution.fields,
            missing: resolution.missing,
            ambiguous: resolution.ambiguous,
            providerEvidence: match.retrieval?.providerEvidence?.hits ?? [],
            timeZone: workflow.context.timeZone,
            currentDate: workflow.context.now,
          });
          if (normalized.status === 'resolved') {
            const canonical = Object.entries(normalized.arguments).map(([name, value]) => {
              const printable = Array.isArray(value) ? value.join(', ') : String(value);
              return `${name}: ${printable}`;
            }).join('\n');
            const reparsed = resolveArguments({
              request: canonical,
              tool,
              previous: {},
              context: { ...workflow.context, ...context, originalRequest: workflow.originalRequest, currentIntentSegment: segment, toolResults },
            });
            for (const [name, source] of Object.entries(normalized.provenance)) {
              if (reparsed.fields[name]) reparsed.fields[name] = { ...reparsed.fields[name], source, method: `${normalized.model ?? 'model'}-argument-normalization` };
            }
            if (reparsed.complete) resolution = reparsed;
          } else if (normalized.missing.length) {
            resolution.missing = [...new Set([...resolution.missing, ...normalized.missing])];
          }
        } catch (error) {
          workflow.normalizationError = error instanceof Error ? error.message : String(error);
        }
      }
      if (!resolution.complete) {
        planOperation.arguments = Object.fromEntries(Object.entries(resolution.fields)
          .filter(([, field]) => field?.status === 'resolved')
          .map(([name, field]) => [name, field.value]));
        workflow.resolvedArguments = resolution.fields;
        workflow.pendingArguments = [...resolution.missing, ...resolution.ambiguous.map(item => item.name)];
        workflow.pendingOperation = { toolId: tool.id, arguments: resolution.fields };
        workflow.pendingConfirmation = null;
        workflow.retrieval = match.retrieval;
        const entityChoice = resolution.ambiguous.find(item => item.options?.length);
        if (entityChoice) {
          workflow.pendingEntityOptions = entityChoice.options;
          workflow.pendingEntityField = entityChoice.name;
          return this.clarification(workflow, 'awaiting_entity_choice', entityChoice.reason, { entities: entityChoice.options, resolution, toolId: tool.id, retrieval: match.retrieval, completedOperations: operationResults });
        }
        const detailQuestion = clarificationForResolution(tool, resolution);
        const question = workflow.normalizationError
          ? `I couldn't automatically prepare the arguments. ${detailQuestion} You can also ask me to try again.`
          : detailQuestion;
        return this.clarification(workflow, 'awaiting_argument', question, { resolution, toolId: tool.id, retrieval: match.retrieval, completedOperations: operationResults, normalizationError: workflow.normalizationError });
      }
      workflow.normalizationError = undefined;
      workflow.resolvedArguments = resolution.fields;
      workflow.pendingArguments = [];
      planOperation.arguments = resolution.arguments;
      planOperation.inputBindings = Object.entries(resolution.fields)
        .filter(([, field]) => field?.source === 'tool_result' && typeof field.sourcePointer === 'string')
        .flatMap(([targetArgument, field]) => {
          const sourceOperation = [...operationResults].reverse().find(item =>
            readJsonPointer(item.data, field.sourcePointer) === field.value)?.operationId;
          return sourceOperation ? [{ targetArgument, sourceOperation, sourcePointer: field.sourcePointer }] : [];
        });
      const call = { toolId: tool.id, arguments: resolution.arguments, operationId: workflow.pendingOperation?.operationId ?? `${workflow.conversationId}:${workflow.currentIndex}` };
      const signature = JSON.stringify({ toolId: call.toolId, arguments: call.arguments });
      if (authorizePending && workflow.pendingConfirmation?.identity !== signature) {
        workflow.status = 'failed';
        planOperation.status = 'failed';
        plan.status = 'failed';
        assertExecutionPlan(plan, this.registry);
        return { kind: 'partial_failure', text: 'The pending confirmation no longer matches this operation and its arguments.', results: operationResults, state: this.getState() };
      }
      if (workflow.seenSideEffects.includes(signature) && tool.confirmation === 'required') {
        workflow.status = 'failed';
        planOperation.status = 'failed';
        plan.status = 'failed';
        assertExecutionPlan(plan, this.registry);
        return { kind: 'partial_failure', text: 'A duplicate side effect was blocked.', results: operationResults, state: this.getState() };
      }
      let result;
      try {
        planOperation.status = 'running';
        assertExecutionPlan(plan, this.registry);
        result = await this.dispatcher.dispatch(call, { confirmed: authorizePending });
      } catch (error) {
        workflow.status = 'failed';
        planOperation.status = 'failed';
        plan.status = 'failed';
        workflow.pendingOperation = { toolId: tool.id, arguments: resolution.fields, operationId: call.operationId };
        assertExecutionPlan(plan, this.registry);
        return { kind: 'partial_failure', text: `An operation failed${operationResults.length ? ` after ${operationResults.length} earlier operation(s)` : ''}.`, error: error instanceof Error ? error.message : String(error), results: operationResults, state: this.getState() };
      }
      followup = false;
      correctionText = undefined;
      authorizePending = false;
      if (result.state === 'confirmation_required') {
        workflow.status = 'awaiting_confirmation';
        planOperation.status = 'waiting_for_confirmation';
        plan.status = 'waiting_for_confirmation';
        workflow.pendingQuestion = `Confirm ${tool.name} with arguments ${JSON.stringify(call.arguments)}?`;
        workflow.pendingOperation = { toolId: tool.id, arguments: resolution.fields, operationId: call.operationId };
        workflow.pendingConfirmation = { call, identity: signature };
        workflow.retrieval = match.retrieval;
        assertExecutionPlan(plan, this.registry);
        return { kind: 'confirmation_required', ...result, pendingCall: call, resolution, retrieval: match.retrieval, completedOperations: operationResults, state: this.getState() };
      }
      if (tool.confirmation === 'required') workflow.seenSideEffects.push(signature);
      operationResults.push({ toolId: tool.id, operationId: call.operationId, arguments: call.arguments, data: result.data, document: result.document, resolution, retrieval: match.retrieval });
      planOperation.status = 'succeeded';
      plan.status = 'running';
      workflow.toolResults = operationResults.map(item => item.data);
      const noMatchingMeeting = tool.id === 'calendar.find_events'
        && call.arguments.event_type === 'meeting'
        && (!Array.isArray(result.data?.events) || result.data.events.length === 0)
        && workflow.segments.slice(workflow.currentIndex + 1).some(next => /\b(?:alarm|beforehand|before|after)\b/i.test(next));
      if (noMatchingMeeting) {
        workflow.currentIndex = workflow.segments.length;
        workflow.remainingIntentSegments = [];
        workflow.status = 'completed';
        plan.status = 'completed';
        assertExecutionPlan(plan, this.registry);
        return {
          kind: 'answer',
          text: 'No matching meeting was found, so no synthetic alarm was created.',
          results: operationResults,
          state: this.getState(),
        };
      }
      workflow.currentIndex++;
      workflow.selectedToolId = null;
      workflow.pendingQuestion = undefined;
      workflow.resolvedArguments = {};
      workflow.pendingOperation = null;
      workflow.pendingConfirmation = null;
      workflow.retrieval = undefined;
      assertExecutionPlan(plan, this.registry);
    }
    workflow.status = 'completed';
    const plan = this.ensureExecutionPlan(workflow);
    plan.status = 'completed';
    assertExecutionPlan(plan, this.registry);
    workflow.updatedAt = new Date().toISOString();
    const last = operationResults.at(-1);
    return { kind: 'document', document: last.document, results: operationResults.map(({ toolId, arguments: args, data }) => ({ toolId, arguments: args, data })), resolution: last.resolution, retrieval: last.retrieval, state: this.getState() };
  }
}
