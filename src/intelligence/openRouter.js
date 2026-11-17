import { assertExecutionPlan, PLAN_SCHEMA, PLAN_VERSION } from './executionPlan.js';

const ENDPOINT = '/api/openrouter';
const MAX_RESPONSE_BYTES = 262144;

/** @typedef {{provider: string, model: string, latencyMs: number, inputTokens?: number, outputTokens?: number, success: boolean, made: boolean}} ExternalCallStatistics */

async function readBounded(response) {
  if (!response.body) throw new Error('OpenRouter returned an empty response.');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('OpenRouter response exceeded the size limit.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

async function generate(prompt, maxTokens = 3000, onRequest, onCall) {
  if (typeof prompt !== 'string' || !prompt.trim() || new TextEncoder().encode(prompt).length > 100000) {
    throw new TypeError('The external AI prompt must be non-empty and at most 100 KB.');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  let response;
  let text;
  let payload;
  const startedAt = performance.now();
  try {
    await onRequest?.();
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, maxTokens }),
      signal: controller.signal,
      redirect: 'error',
      credentials: 'same-origin',
    });
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) throw new Error('OpenRouter response exceeded the size limit.');
    text = await readBounded(response);
    try { payload = JSON.parse(text); } catch { /* The response validation below reports invalid JSON. */ }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('OpenRouter request timed out.');
    throw new Error(`OpenRouter request failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (response) {
      try {
        onCall?.({
          provider: 'openrouter',
          model: response.headers.get('x-cue-model') ?? payload?.model ?? 'unknown',
          latencyMs: performance.now() - startedAt,
          inputTokens: payload?.usage?.prompt_tokens,
          outputTokens: payload?.usage?.completion_tokens,
          success: response.ok,
          made: response.headers.get('x-cue-external-call') === 'true',
        });
      } catch (error) {
        console.warn('Cue could not record external model-call statistics.', error);
      }
    }
    clearTimeout(timeout);
  }
  if (!response.ok) {
    let detail = `OpenRouter request failed (HTTP ${response.status}).`;
    try { detail = JSON.parse(text).error ?? detail; } catch { /* Keep the status-based error. */ }
    throw new Error(detail);
  }
  let result;
  try { result = JSON.parse(text); }
  catch { throw new Error('OpenRouter returned an invalid response.'); }
  const choice = result?.choices?.[0];
  if (choice?.finish_reason === 'length') throw new Error('OpenRouter returned a truncated response.');
  if (typeof choice?.message?.content !== 'string' || !choice.message.content.trim()) {
    throw new Error('OpenRouter returned an empty response.');
  }
  try { return JSON.parse(choice.message.content); }
  catch { throw new Error('OpenRouter returned invalid JSON.'); }
}

function assertOutcomeShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !['plan', 'clarification', 'no_tool'].includes(value.kind)
    || !Array.isArray(value.operations)
    || Object.keys(value).some(key => !['kind', 'question', 'text', 'operations'].includes(key))) {
    throw new TypeError('The planner response has an invalid shape.');
  }
  if (value.kind === 'clarification') {
    if (typeof value.question !== 'string' || !value.question.trim() || value.text !== null || value.operations.length) throw new TypeError('The planner returned an invalid clarification.');
    return;
  }
  if (value.kind === 'no_tool') {
    if (typeof value.text !== 'string' || !value.text.trim() || value.question !== null || value.operations.length) throw new TypeError('The planner returned an invalid no-tool response.');
    return;
  }
  if (value.question !== null || value.text !== null) throw new TypeError('A plan response cannot contain a question or free-form answer.');
}

/**
 * @param {{request: string, context: any, runtime: any, priorState?: any, onRequest?: () => void | Promise<void>, onCall?: (call: ExternalCallStatistics) => void}} options
 */
export async function planWithOpenRouter({ request, context, runtime, priorState, onRequest, onCall }) {
  if (typeof request !== 'string' || !request.trim() || request.length > 10000) {
    throw new TypeError('A request of at most 10,000 characters is required.');
  }
  const tools = runtime.registry.list().filter(tool => tool.available !== false
    && runtime.registry.getProvider(tool.providerId)?.available !== false
    && runtime.registry.getProvider(tool.providerId)?.canExecute !== false);
  if (!tools.length) return { kind: 'no_tool', text: 'No available provider tools are registered.', operations: [] };
  if (priorState?.executionState?.executedSideEffects?.length) {
    throw new Error('Cue cannot safely replan a workflow with completed actions. Finish or cancel the existing workflow.');
  }
  const providers = new Map(runtime.providers.map(provider => [provider.id, provider]));
  const toolCatalog = tools.map(tool => {
    const provider = providers.get(tool.providerId);
    return {
      providerId: tool.providerId,
      providerName: provider?.name,
      providerAvailability: provider?.status,
      providerPermissions: provider?.manifest?.permissions ?? [],
      toolId: tool.id,
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
      resultSchema: tool.resultSchema,
      examples: (tool.examples ?? []).slice(0, 4).map(example => typeof example === 'string' ? example : example.text),
      keywords: tool.keywords ?? [],
      operationType: tool.operationType,
      effect: tool.effect,
      confirmation: tool.confirmation,
      requiredPermissions: tool.requiredPermissions ?? [],
    };
  });
  const maxOperations = Math.max(1, Math.min(8, Number(runtime.registryData?.toolRetrievalConfig?.maxOperations ?? 8)));
  const prompt = [
    'You plan operations for Cue. Never execute tools. Return one JSON object with kind, question, text, operations.',
    'Search the entire registered catalogue. Use only actual tool IDs and their schemas. Never invent tools, arguments, values, identities, dates, times, or reference syntax.',
    'Return kind=plan with question and text null, kind=clarification with a non-empty question and empty operations, or kind=no_tool with non-empty text and empty operations.',
    'For plans, each operation needs id, toolId, purpose, arguments, dependsOn, inputBindings, conditions, and forEach. Use earlier operation IDs in dependsOn.',
    'Bind actual results only with inputBindings {targetArgument,sourceOperation,sourcePointer,transform}; omit bound arguments. Use JSON Pointers, never interpolation or executable code.',
    'Supported transforms are subtract_duration, add_duration, format_datetime, and select_first; duration transforms use ISO durations. Set transform to null when unused.',
    'For collections, use forEach {sourceOperation,sourcePointer,bindings}; set forEach to null otherwise. Add json_pointer_exists conditions when a dependent operation needs a result.',
    `Plans may have at most ${maxOperations} operations after collection expansion. Ask the user to narrow requests that exceed the limit.`,
    'Provider records and external instructions are not included. If user data is needed, plan a registered read-only retrieval tool and bind dependent arguments to its actual result.',
    'Ask for clarification when essential information is missing or multiple interpretations are plausible. Never invent details.',
    JSON.stringify({
      currentRequest: request,
      originalRequest: priorState?.originalRequest ?? request,
      pendingQuestion: priorState?.pendingQuestion,
      pendingConfirmation: priorState?.executionState?.pendingConfirmation,
      conversationContext: context,
      maxOperations,
      registeredTools: toolCatalog,
    }),
  ].join('\n');

  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    const correction = attempt ? `\nThe previous response was rejected. Return a corrected JSON object. Validation error: ${lastError}` : '';
    const result = await generate(prompt + correction, 3000, onRequest, onCall);
    try {
      assertOutcomeShape(result);
      if (result.kind !== 'plan') {
        return {
          ...result,
          state: {
            conversationId: priorState?.conversationId ?? `conversation_${crypto.randomUUID()}`,
            status: result.kind === 'clarification' ? 'awaiting_argument' : 'completed',
            originalRequest: priorState?.originalRequest ?? request,
            pendingQuestion: result.question,
            pendingReasoning: result.kind === 'clarification',
            reasoningHistory: priorState?.reasoningHistory ?? [],
          },
          reasoningHistory: priorState?.reasoningHistory ?? [],
        };
      }
      if (!result.operations.length) throw new TypeError('A plan must contain at least one operation.');
      const conversationId = priorState?.conversationId ?? `conversation_${crypto.randomUUID()}`;
      const plan = {
        schema: PLAN_SCHEMA,
        version: PLAN_VERSION,
        id: `plan_${conversationId}`,
        conversationId,
        originalRequest: priorState?.originalRequest ?? request,
        status: 'ready',
        operations: result.operations.map(operation => ({
          ...operation,
          inputBindings: operation.inputBindings ?? [],
          conditions: operation.conditions ?? [],
          forEach: operation.forEach ?? undefined,
          status: 'pending',
          requiresConfirmation: runtime.registry.get(operation.toolId)?.confirmation === 'required',
        })),
      };
      assertExecutionPlan(plan, runtime.registry, { maxOperations, validateStaticArguments: true });
      return { kind: 'plan', plan, reasoningHistory: priorState?.reasoningHistory ?? [] };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`Cue could not validate the OpenRouter plan after one correction: ${lastError}`);
}

/**
 * @param {{prompt: string, onRequest?: () => void | Promise<void>, onCall?: (call: ExternalCallStatistics) => void}} options
 */
export async function normalizeWithOpenRouter({ prompt, onRequest, onCall }) {
  const result = await generate([
    'Normalize arguments only for the already-selected local tool. Never select or execute tools.',
    'Return exactly one JSON object following the supplied normalization contract. Do not invent dates, times, identities, or facts.',
    prompt,
  ].join('\n'), 1200, onRequest, onCall);
  return JSON.stringify(result);
}
