export type ExecutionMode = 'local' | 'external' | 'hybrid';
export type SelectedMode = 'web_ai' | 'automatic' | 'dots3_always';
export type CompletionStatus = 'completed' | 'clarification' | 'awaiting_confirmation' | 'failed' | 'cancelled';

export type ExternalModelCall = {
  provider: string;
  model: string;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  success: boolean;
};

export type RequestStatistic = {
  requestId: string;
  startedAt: string;
  completedAt: string;
  executionMode: ExecutionMode;
  localModels: string[];
  localProcessing: boolean;
  externalModels: ExternalModelCall[];
  externalCalls: number;
  inputTokens: number;
  outputTokens: number;
  tokenUsageCalls: number;
  localInferenceMs: number;
  externalAiMs: number;
  toolExecutionMs: number;
  responseMs: number;
  toolCalls: number;
  toolFailures: number;
  clarifications: number;
  multiStep: boolean;
  completionStatus: CompletionStatus;
  selectedMode: SelectedMode | null;
  requestText: string | null;
};

export type RequestMeasurement = {
  requestId: string;
  startedAt: string;
  startedAtMs: number;
  selectedMode: SelectedMode | null;
  requestText: string | null;
  localModels: Set<string>;
  localProcessing: boolean;
  externalModels: ExternalModelCall[];
  localInferenceMs: number;
  externalAiMs: number;
  toolExecutionMs: number;
  toolCalls: number;
  toolFailures: number;
  clarifications: number;
  multiStep: boolean;
  completed?: RequestStatistic;
};

export type StatisticsSummary = {
  sampleSize: number;
  periodStart: string | null;
  periodEnd: string | null;
  localModels: string[];
  averageExternalApiCalls: number | null;
  totalExternalApiCalls: number;
  averageResponseMs: number | null;
  averageLocalInferenceMs: number | null;
  averageExternalAiMs: number | null;
  averageToolExecutionMs: number | null;
  completionRate: number | null;
  toolSuccessRate: number | null;
  totalToolCalls: number;
  totalToolFailures: number;
  totalClarifications: number;
  multiStepRequests: number;
  inputTokens: number;
  outputTokens: number;
  tokenUsageCalls: number;
  bySelectedMode: ModeStatistics[];
  byMode: Array<{
    mode: ExecutionMode;
    requests: number;
    averageExternalApiCalls: number;
    averageResponseMs: number;
    averageLocalInferenceMs: number;
    averageExternalAiMs: number;
    averageToolExecutionMs: number;
    completionRate: number;
    toolSuccessRate: number | null;
  }>;
  byExternalModel: Array<{
    provider: string;
    model: string;
    requests: number;
    calls: number;
    averageLatencyMs: number;
    inputTokens: number;
    outputTokens: number;
    tokenUsageCalls: number;
  }>;
};

export type ModeStatistics = {
  mode: SelectedMode;
  requests: number;
  periodStart: string | null;
  periodEnd: string | null;
  averageExternalApiCalls: number | null;
  averageResponseMs: number | null;
  averageLocalInferenceMs: number | null;
  averageExternalCallLatencyMs: number | null;
  externalCalls: number;
  completionRate: number | null;
  toolSuccessRate: number | null;
  toolCalls: number;
  averageInputTokens: number | null;
  averageOutputTokens: number | null;
  tokenSampleSize: number;
};

export function beginRequestMeasurement(selectedMode: SelectedMode, startedAtMs = Date.now(), requestId = crypto.randomUUID()): RequestMeasurement {
  if (!Number.isSafeInteger(startedAtMs) || startedAtMs < 0 || !requestId) throw new TypeError('Request measurement identity is invalid.');
  return {
    requestId,
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    selectedMode,
    requestText: null,
    localModels: new Set(),
    localProcessing: false,
    externalModels: [],
    localInferenceMs: 0,
    externalAiMs: 0,
    toolExecutionMs: 0,
    toolCalls: 0,
    toolFailures: 0,
    clarifications: 0,
    multiStep: false,
  };
}

export function recordLocalProcessing(measurement: RequestMeasurement | undefined) {
  if (measurement) measurement.localProcessing = true;
}

export function serializeRequestMeasurement(measurement: RequestMeasurement) {
  return {
    requestId: measurement.requestId,
    startedAt: measurement.startedAt,
    startedAtMs: measurement.startedAtMs,
    selectedMode: measurement.selectedMode,
    requestText: measurement.requestText,
    localModels: [...measurement.localModels],
    localProcessing: measurement.localProcessing,
    externalModels: measurement.externalModels.map(call => ({ ...call })),
    localInferenceMs: measurement.localInferenceMs,
    externalAiMs: measurement.externalAiMs,
    toolExecutionMs: measurement.toolExecutionMs,
    toolCalls: measurement.toolCalls,
    toolFailures: measurement.toolFailures,
    clarifications: measurement.clarifications,
    multiStep: measurement.multiStep,
  };
}

export function restoreRequestMeasurement(value: unknown): RequestMeasurement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Stored request measurement is invalid.');
  const source = value as Record<string, unknown>;
  if (typeof source.requestId !== 'string' || typeof source.startedAt !== 'string'
    || typeof source.startedAtMs !== 'number' || !Number.isSafeInteger(source.startedAtMs) || source.startedAtMs < 0
    || Date.parse(source.startedAt) !== source.startedAtMs
    || (source.selectedMode !== undefined && source.selectedMode !== null && !['web_ai', 'automatic', 'dots3_always'].includes(String(source.selectedMode)))
    || (source.requestText !== undefined && source.requestText !== null && typeof source.requestText !== 'string')
    || typeof source.localProcessing !== 'boolean'
    || !Array.isArray(source.localModels) || source.localModels.some(model => typeof model !== 'string')
    || !Array.isArray(source.externalModels)
    || typeof source.multiStep !== 'boolean') {
    throw new TypeError('Stored request measurement is invalid.');
  }
  const nonNegativeFields = ['localInferenceMs', 'externalAiMs', 'toolExecutionMs', 'toolCalls', 'toolFailures', 'clarifications'];
  for (const field of nonNegativeFields) {
    if (!Number.isSafeInteger(source[field]) || (source[field] as number) < 0) throw new TypeError(`Stored request ${field} is invalid.`);
  }
  if ((source.toolFailures as number) > (source.toolCalls as number)) throw new TypeError('Stored tool-failure count is invalid.');
  const localModels = source.localModels as string[];
  const externalModels = source.externalModels as ExternalModelCall[];
  if (externalModels.some(call => !call || typeof call.provider !== 'string' || typeof call.model !== 'string'
    || !Number.isSafeInteger(call.latencyMs) || call.latencyMs < 0
    || (call.inputTokens !== null && (!Number.isSafeInteger(call.inputTokens) || call.inputTokens! < 0))
    || (call.outputTokens !== null && (!Number.isSafeInteger(call.outputTokens) || call.outputTokens! < 0))
    || typeof call.success !== 'boolean')) {
    throw new TypeError('Stored external model call is invalid.');
  }
  return {
    requestId: source.requestId,
    startedAt: source.startedAt,
    startedAtMs: source.startedAtMs as number,
    selectedMode: (source.selectedMode as SelectedMode | null | undefined) ?? null,
    requestText: (source.requestText as string | null | undefined) ?? null,
    localModels: new Set(localModels),
    localProcessing: source.localProcessing,
    externalModels: externalModels.map(call => ({ ...call })),
    localInferenceMs: source.localInferenceMs as number,
    externalAiMs: source.externalAiMs as number,
    toolExecutionMs: source.toolExecutionMs as number,
    toolCalls: source.toolCalls as number,
    toolFailures: source.toolFailures as number,
    clarifications: source.clarifications as number,
    multiStep: source.multiStep,
  };
}

function measuredDuration(value: number) {
  if (!Number.isFinite(value) || value < 0) throw new RangeError('Measured duration must be a non-negative finite number.');
  return Math.round(value);
}

export function recordLocalInference(measurement: RequestMeasurement | undefined, model: string | undefined, durationMs: number) {
  if (!measurement) return;
  if (model) measurement.localModels.add(model);
  measurement.localInferenceMs += measuredDuration(durationMs);
}

export function recordExternalCall(
  measurement: RequestMeasurement | undefined,
  call: { provider: string; model: string; latencyMs: number; inputTokens?: number; outputTokens?: number; success: boolean; made: boolean },
) {
  if (!measurement || !call.made) return;
  const inputTokens = Number.isSafeInteger(call.inputTokens) && call.inputTokens! >= 0 ? call.inputTokens! : null;
  const outputTokens = Number.isSafeInteger(call.outputTokens) && call.outputTokens! >= 0 ? call.outputTokens! : null;
  const normalized = {
    provider: call.provider,
    model: call.model,
    latencyMs: measuredDuration(call.latencyMs),
    inputTokens,
    outputTokens,
    success: call.success,
  };
  if (!normalized.provider || !normalized.model) throw new TypeError('External model call identity is invalid.');
  measurement.externalModels.push(normalized);
  measurement.externalAiMs += normalized.latencyMs;
}

export function recordToolExecution(measurement: RequestMeasurement | undefined, durationMs: number, success: boolean) {
  if (!measurement) return;
  measurement.toolCalls++;
  if (!success) measurement.toolFailures++;
  measurement.toolExecutionMs += measuredDuration(durationMs);
  if (measurement.toolCalls > 1) measurement.multiStep = true;
}

export function recordClarification(measurement: RequestMeasurement | undefined) {
  if (measurement) measurement.clarifications++;
}

export function markMultiStep(measurement: RequestMeasurement | undefined, operationCount: number) {
  if (measurement && operationCount > 1) measurement.multiStep = true;
}

export function completeRequestMeasurement(
  measurement: RequestMeasurement,
  completionStatus: CompletionStatus,
  completedAtMs = Date.now(),
): RequestStatistic {
  if (measurement.completed) return measurement.completed;
  if (!Number.isSafeInteger(completedAtMs) || completedAtMs < 0) throw new RangeError('Request completion time is invalid.');
  const finishedAtMs = Math.max(completedAtMs, measurement.startedAtMs);
  const hasLocal = measurement.localProcessing || measurement.localModels.size > 0;
  const hasExternal = measurement.externalModels.length > 0;
  const executionMode: ExecutionMode = hasLocal && hasExternal ? 'hybrid' : hasExternal ? 'external' : 'local';
  const inputTokens = measurement.externalModels.reduce((total, call) => total + (call.inputTokens ?? 0), 0);
  const outputTokens = measurement.externalModels.reduce((total, call) => total + (call.outputTokens ?? 0), 0);
  measurement.completed = {
    requestId: measurement.requestId,
    startedAt: measurement.startedAt,
    completedAt: new Date(finishedAtMs).toISOString(),
    executionMode,
    localModels: [...measurement.localModels],
    localProcessing: measurement.localProcessing,
    externalModels: measurement.externalModels.map(call => ({ ...call })),
    externalCalls: measurement.externalModels.length,
    inputTokens,
    outputTokens,
    tokenUsageCalls: measurement.externalModels.filter(call => call.inputTokens !== null || call.outputTokens !== null).length,
    localInferenceMs: measurement.localInferenceMs,
    externalAiMs: measurement.externalAiMs,
    toolExecutionMs: measurement.toolExecutionMs,
    responseMs: finishedAtMs - measurement.startedAtMs,
    toolCalls: measurement.toolCalls,
    toolFailures: measurement.toolFailures,
    clarifications: measurement.clarifications,
    multiStep: measurement.multiStep,
    completionStatus,
    selectedMode: measurement.selectedMode,
    requestText: measurement.requestText,
  };
  return measurement.completed;
}

function average(values: number[]) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

export function calculateStatistics(records: RequestStatistic[]): StatisticsSummary {
  const ordered = [...records].sort((left, right) => left.completedAt.localeCompare(right.completedAt));
  const averageExternalApiCalls = average(ordered.map(record => record.externalCalls));
  const averageResponseMs = average(ordered.map(record => record.responseMs));
  const totalExternalApiCalls = ordered.reduce((total, record) => total + record.externalCalls, 0);
  const totalToolCalls = ordered.reduce((total, record) => total + record.toolCalls, 0);
  const totalToolFailures = ordered.reduce((total, record) => total + record.toolFailures, 0);
  const externalCalls = ordered.flatMap(record => record.externalModels);
  const bySelectedMode: ModeStatistics[] = (['web_ai', 'automatic', 'dots3_always'] as const).map(mode => {
    const subset = ordered.filter(record => record.selectedMode === mode);
    const calls = subset.flatMap(record => record.externalModels);
    const toolCalls = subset.reduce((sum, record) => sum + record.toolCalls, 0);
    const failures = subset.reduce((sum, record) => sum + record.toolFailures, 0);
    const tokens = subset.filter(record => record.externalModels.every(call => call.inputTokens !== null && call.outputTokens !== null));
    return {
      mode, requests: subset.length,
      periodStart: subset[0]?.completedAt ?? null,
      periodEnd: subset.at(-1)?.completedAt ?? null,
      averageExternalApiCalls: average(subset.map(record => record.externalCalls)),
      averageResponseMs: average(subset.map(record => record.responseMs)),
      averageLocalInferenceMs: average(subset.map(record => record.localInferenceMs)),
      averageExternalCallLatencyMs: average(calls.map(call => call.latencyMs)),
      externalCalls: calls.length,
      completionRate: subset.length ? subset.filter(record => record.completionStatus === 'completed').length / subset.length : null,
      toolSuccessRate: toolCalls ? (toolCalls - failures) / toolCalls : null,
      toolCalls,
      averageInputTokens: average(tokens.map(record => record.inputTokens)),
      averageOutputTokens: average(tokens.map(record => record.outputTokens)),
      tokenSampleSize: tokens.length,
    };
  });
  const byMode = (['local', 'external', 'hybrid'] as const).flatMap(mode => {
    const subset = ordered.filter(record => record.executionMode === mode);
    if (!subset.length) return [];
    const calls = subset.reduce((total, record) => total + record.toolCalls, 0);
    const failures = subset.reduce((total, record) => total + record.toolFailures, 0);
    return [{
      mode,
      requests: subset.length,
      averageExternalApiCalls: average(subset.map(record => record.externalCalls))!,
      averageResponseMs: average(subset.map(record => record.responseMs))!,
      averageLocalInferenceMs: average(subset.map(record => record.localInferenceMs))!,
      averageExternalAiMs: average(subset.map(record => record.externalAiMs))!,
      averageToolExecutionMs: average(subset.map(record => record.toolExecutionMs))!,
      completionRate: subset.filter(record => record.completionStatus === 'completed').length / subset.length,
      toolSuccessRate: calls ? (calls - failures) / calls : null,
    }];
  });
  const modelGroups = new Map<string, ExternalModelCall[]>();
  for (const call of externalCalls) {
    const key = `${call.provider}\u0000${call.model}`;
    modelGroups.set(key, [...(modelGroups.get(key) ?? []), call]);
  }
  const byExternalModel = [...modelGroups].map(([key, calls]) => {
    const [provider, model] = key.split('\u0000');
    const measured = calls.filter(call => call.inputTokens !== null || call.outputTokens !== null);
    return {
      provider,
      model,
      requests: new Set(ordered.filter(record => record.externalModels.some(call => call.provider === provider && call.model === model)).map(record => record.requestId)).size,
      calls: calls.length,
      averageLatencyMs: average(calls.map(call => call.latencyMs))!,
      inputTokens: calls.reduce((total, call) => total + (call.inputTokens ?? 0), 0),
      outputTokens: calls.reduce((total, call) => total + (call.outputTokens ?? 0), 0),
      tokenUsageCalls: measured.length,
    };
  }).sort((left, right) => right.calls - left.calls || left.model.localeCompare(right.model));
  return {
    sampleSize: ordered.length,
    periodStart: ordered[0]?.completedAt ?? null,
    periodEnd: ordered.at(-1)?.completedAt ?? null,
    localModels: [...new Set(ordered.flatMap(record => record.localModels))].sort(),
    averageExternalApiCalls,
    totalExternalApiCalls,
    averageResponseMs,
    averageLocalInferenceMs: average(ordered.map(record => record.localInferenceMs)),
    averageExternalAiMs: average(ordered.map(record => record.externalAiMs)),
    averageToolExecutionMs: average(ordered.map(record => record.toolExecutionMs)),
    completionRate: ordered.length ? ordered.filter(record => record.completionStatus === 'completed').length / ordered.length : null,
    toolSuccessRate: totalToolCalls ? (totalToolCalls - totalToolFailures) / totalToolCalls : null,
    totalToolCalls,
    totalToolFailures,
    totalClarifications: ordered.reduce((total, record) => total + record.clarifications, 0),
    multiStepRequests: ordered.filter(record => record.multiStep).length,
    inputTokens: externalCalls.reduce((total, call) => total + (call.inputTokens ?? 0), 0),
    outputTokens: externalCalls.reduce((total, call) => total + (call.outputTokens ?? 0), 0),
    tokenUsageCalls: externalCalls.filter(call => call.inputTokens !== null || call.outputTokens !== null).length,
    bySelectedMode,
    byMode,
    byExternalModel,
  };
}

export async function uploadRequestStatistic(statistic: RequestStatistic, fetchImpl: typeof fetch = fetch) {
  const response = await fetchImpl('/.netlify/functions/global-stats', {
    method: 'POST',
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(statistic),
  });
  if (!response.ok) throw new Error(`Telemetry upload failed (${response.status}).`);
}

let pendingFlush: Promise<{ uploaded: number; failed: number }> | undefined;

export function flushTelemetryQueue(
  database: {
    getPreference(key: string): Promise<unknown>;
    getPendingTelemetry(): Promise<Array<{ requestId: string; statistic: RequestStatistic; attempts: number; nextAttemptAt: number }>>;
    updatePendingTelemetry(requestId: string, attempts: number, nextAttemptAt: number): Promise<void>;
    removePendingTelemetry(requestId: string): Promise<void>;
    clearPendingTelemetry(): Promise<void>;
  },
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
  scheduleRetry = true,
): Promise<{ uploaded: number; failed: number }> {
  if (pendingFlush) return pendingFlush;
  pendingFlush = (async () => {
    if (await database.getPreference('sharePublicTelemetryWithRequestText') !== true) {
      await database.clearPendingTelemetry();
      return { uploaded: 0, failed: 0 };
    }
    let uploaded = 0;
    let failed = 0;
    let retryDelay: number | undefined;
    for (const item of await database.getPendingTelemetry()) {
      if (item.nextAttemptAt > now) {
        retryDelay = Math.min(retryDelay ?? item.nextAttemptAt - now, item.nextAttemptAt - now);
        continue;
      }
      try {
        await uploadRequestStatistic(item.statistic, fetchImpl);
        await database.removePendingTelemetry(item.requestId);
        uploaded++;
      } catch {
        const attempts = item.attempts + 1;
        const delay = Math.min(60_000, 1_000 * (2 ** Math.min(attempts, 6)));
        await database.updatePendingTelemetry(item.requestId, attempts, now + delay);
        failed++;
        retryDelay = Math.min(retryDelay ?? delay, delay);
      }
    }
    if (scheduleRetry && retryDelay !== undefined && typeof window !== 'undefined') {
      window.setTimeout(() => {
        void flushTelemetryQueue(database, fetchImpl).catch(error => console.warn('Cue could not retry pending telemetry.', error));
      }, retryDelay);
    }
    return { uploaded, failed };
  })().finally(() => { pendingFlush = undefined; });
  return pendingFlush;
}
