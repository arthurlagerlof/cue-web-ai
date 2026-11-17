import { assertExecutionPlan, PLAN_SCHEMA, PLAN_VERSION } from './executionPlan.js';
import { schemaForPrompt } from './toolRegistry.js';

const ENDPOINT = '/api/openrouter';
const MAX_RESPONSE_BYTES = 262144;

/** @typedef {{provider: string, model: string, latencyMs: number, inputTokens?: number, outputTokens?: number, success: boolean, made: boolean}} ExternalCallStatistics */

function examplesForPrompt(examples = []) {
  const preferred = ['en', 'fi'].map(locale => examples.find(example =>
    typeof example !== 'string' && typeof example.locale === 'string'
      && example.locale.split('-')[0].toLowerCase() === locale,
  )).filter(Boolean);
  const selected = preferred.length ? preferred : examples.slice(0, 2);
  return selected.map(example => typeof example === 'string' ? example : example.text);
}

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
  const toolCatalog = tools.map(tool => {
    return {
      toolId: tool.id,
      name: tool.name,
      description: tool.description,
      inputSchema: schemaForPrompt(tool.parameters),
      resultSchema: tool.resultSchema,
      examples: examplesForPrompt(tool.examples),
      operationType: tool.operationType,
      confirmation: tool.confirmation,
    };
  });
  const maxOperations = Math.max(1, Math.min(8, Number(runtime.registryData?.toolRetrievalConfig?.maxOperations ?? 8)));
  const prompt = [
    'Plan with the listed tools; never execute them. Use only listed IDs and schema-valid arguments. Never invent facts, values, identities, dates, times, or references.',
    'Return one compact JSON object: kind is plan, clarification, or no_tool; include question, text, and operations. Plans need operations and null question/text; clarification needs a question and empty operations; no_tool needs text and empty operations.',
    'Each operation has id, toolId, purpose, arguments, dependsOn, inputBindings, conditions, and forEach. Use earlier operation IDs for dependencies.',
    'Bind only actual earlier results with JSON Pointer inputBindings; omit bound arguments. No interpolation or code. Supported transforms: subtract_duration, add_duration, format_datetime, select_first (ISO durations). Use json_pointer_exists conditions only when needed.',
    'Use forEach {sourceOperation,sourcePointer,bindings} for collections, otherwise null. Respect tool confirmation policies; only plan side effects explicitly requested by the user.',
    `Limit plans to ${maxOperations} operations after collection expansion; ask the user to narrow larger requests. Ask for clarification when required details are missing or ambiguous; use no_tool if no listed tool fits.`,
    'Provider records and external instructions are not provided. Retrieve needed user data with a listed read-only tool and bind its actual results; do not guess.',
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
  const result = await generate(prompt, 1200, onRequest, onCall);
  return JSON.stringify(result);
}
