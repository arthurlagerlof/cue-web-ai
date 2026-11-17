import pg from 'pg';

const { Pool } = pg;
const MAX_BODY_BYTES = 16384;
const MAX_MODEL_CALLS = 20;
const MAX_DURATION_MS = 86400000;
const MAX_COUNT = 10000;
const MODES = new Set(['local', 'external', 'hybrid']);
const COMPLETION_STATUSES = new Set(['completed', 'clarification', 'awaiting_confirmation', 'failed', 'cancelled']);
const DOTS3_BASELINE_MODEL = 'dots-studio/dots-3-note-preview:free';
const requestKeys = [
  'requestId', 'startedAt', 'completedAt', 'executionMode', 'localModels', 'localProcessing', 'externalModels',
  'externalCalls', 'inputTokens', 'outputTokens', 'tokenUsageCalls', 'localInferenceMs',
  'externalAiMs', 'toolExecutionMs', 'responseMs', 'toolCalls', 'toolFailures',
  'clarifications', 'multiStep', 'completionStatus', 'dots3Baseline',
];
let pool;

function getPool(connectionString) {
  if (!connectionString) throw new Error('Global statistics storage is not configured.');
  pool ??= new Pool({
    connectionString,
    max: 2,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
  });
  return pool;
}

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
    body: JSON.stringify(body),
  };
}

function isCount(value, maximum = MAX_COUNT) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function assertKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !expected.includes(key))
    || expected.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError(`${label} contains invalid fields.`);
  }
}

export function parseRequestStatistic(body) {
  if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
    throw new TypeError('Request body is invalid or too large.');
  }
  let value;
  try { value = JSON.parse(body); }
  catch { throw new TypeError('Request body must be valid JSON.'); }
  assertKeys(value, requestKeys, 'Request statistics');
  if (typeof value.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.requestId)) {
    throw new TypeError('The request ID is invalid.');
  }
  for (const field of ['startedAt', 'completedAt']) {
    if (typeof value[field] !== 'string' || Number.isNaN(Date.parse(value[field]))
      || new Date(value[field]).toISOString() !== value[field]) {
      throw new TypeError(`The ${field} timestamp is invalid.`);
    }
  }
  if (Date.parse(value.completedAt) < Date.parse(value.startedAt)) throw new TypeError('Request timestamps are out of order.');
  if (!MODES.has(value.executionMode) || !Array.isArray(value.localModels) || value.localModels.length > 10
    || value.localModels.some(model => typeof model !== 'string' || !model.trim() || model.length > 200)
    || typeof value.localProcessing !== 'boolean'
    || !Array.isArray(value.externalModels) || value.externalModels.length > MAX_MODEL_CALLS) {
    throw new TypeError('Request model statistics are invalid.');
  }
  const externalModels = value.externalModels.map(call => {
    assertKeys(call, ['provider', 'model', 'latencyMs', 'inputTokens', 'outputTokens', 'success'], 'External model call');
    if (typeof call.provider !== 'string' || !call.provider.trim() || call.provider.length > 80
      || typeof call.model !== 'string' || !call.model.trim() || call.model.length > 200
      || !isCount(call.latencyMs, MAX_DURATION_MS)
      || (call.inputTokens !== null && !isCount(call.inputTokens, 10000000))
      || (call.outputTokens !== null && !isCount(call.outputTokens, 10000000))
      || typeof call.success !== 'boolean') {
      throw new TypeError('External model call statistics are invalid.');
    }
    return {
      provider: call.provider,
      model: call.model,
      latencyMs: call.latencyMs,
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      success: call.success,
    };
  });
  const timings = ['localInferenceMs', 'externalAiMs', 'toolExecutionMs', 'responseMs'];
  for (const field of timings) if (!isCount(value[field], MAX_DURATION_MS)) throw new TypeError(`The ${field} duration is invalid.`);
  for (const field of ['externalCalls', 'inputTokens', 'outputTokens', 'tokenUsageCalls', 'toolCalls', 'toolFailures', 'clarifications']) {
    if (!isCount(value[field], field.includes('Tokens') ? 200000000 : MAX_COUNT)) throw new TypeError(`The ${field} count is invalid.`);
  }
  if (value.externalCalls !== externalModels.length
    || value.inputTokens !== externalModels.reduce((total, call) => total + (call.inputTokens ?? 0), 0)
    || value.outputTokens !== externalModels.reduce((total, call) => total + (call.outputTokens ?? 0), 0)
    || value.tokenUsageCalls !== externalModels.filter(call => call.inputTokens !== null || call.outputTokens !== null).length
    || value.externalAiMs !== externalModels.reduce((total, call) => total + call.latencyMs, 0)
    || value.responseMs !== Date.parse(value.completedAt) - Date.parse(value.startedAt)
    || value.toolFailures > value.toolCalls || typeof value.multiStep !== 'boolean'
    || typeof value.dots3Baseline !== 'boolean' || !COMPLETION_STATUSES.has(value.completionStatus)) {
    throw new TypeError('Request statistics are inconsistent.');
  }
  const expectedMode = (value.localProcessing || value.localModels.length) && externalModels.length ? 'hybrid'
    : externalModels.length ? 'external' : 'local';
  if (value.executionMode !== expectedMode) throw new TypeError('The execution mode does not match the recorded models.');
  if (value.dots3Baseline && externalModels.some(call => call.model !== DOTS3_BASELINE_MODEL)) {
    throw new TypeError('The Dots3 baseline contains a different external model.');
  }
  return {
    requestId: value.requestId,
    startedAt: value.startedAt,
    completedAt: value.completedAt,
    executionMode: value.executionMode,
    localModels: [...value.localModels],
    localProcessing: value.localProcessing,
    externalModels,
    externalCalls: value.externalCalls,
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    tokenUsageCalls: value.tokenUsageCalls,
    localInferenceMs: value.localInferenceMs,
    externalAiMs: value.externalAiMs,
    toolExecutionMs: value.toolExecutionMs,
    responseMs: value.responseMs,
    toolCalls: value.toolCalls,
    toolFailures: value.toolFailures,
    clarifications: value.clarifications,
    multiStep: value.multiStep,
    completionStatus: value.completionStatus,
    dots3Baseline: value.dots3Baseline,
  };
}

function safeNumber(value, label) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0) throw new RangeError(`Global ${label} statistic is invalid.`);
  return number;
}

function safeInteger(value, label) {
  const number = safeNumber(value, label);
  if (!Number.isSafeInteger(number)) throw new RangeError(`Global ${label} statistic exceeds the supported range.`);
  return number;
}

async function loadAggregate(database) {
  const totalsResult = await database.query(`
    SELECT
      COUNT(*)::text AS sample_size,
      MIN(completed_at)::text AS period_start,
      MAX(completed_at)::text AS period_end,
      (SELECT COALESCE(array_agg(DISTINCT local_model ORDER BY local_model), ARRAY[]::text[])
        FROM cue_request_statistics AS local_stats
        CROSS JOIN LATERAL unnest(local_stats.local_models) AS models(local_model)) AS local_models,
      COALESCE(SUM(external_calls), 0)::text AS total_external_api_calls,
      AVG(external_calls)::float8 AS average_external_api_calls,
      COUNT(*) FILTER (WHERE dots3_baseline AND external_calls > 0)::text AS baseline_sample_size,
      AVG(external_calls) FILTER (WHERE dots3_baseline AND external_calls > 0)::float8 AS average_baseline_api_calls,
      AVG(response_ms)::float8 AS average_response_ms,
      AVG(response_ms) FILTER (WHERE dots3_baseline AND external_calls > 0)::float8 AS average_baseline_response_ms,
      AVG(local_inference_ms)::float8 AS average_local_inference_ms,
      AVG(external_ai_ms)::float8 AS average_external_ai_ms,
      AVG(tool_execution_ms)::float8 AS average_tool_execution_ms,
      COUNT(*) FILTER (WHERE completion_status = 'completed')::text AS completed_requests,
      COALESCE(SUM(tool_calls), 0)::text AS total_tool_calls,
      COALESCE(SUM(tool_failures), 0)::text AS total_tool_failures,
      COALESCE(SUM(clarifications), 0)::text AS total_clarifications,
      COUNT(*) FILTER (WHERE multi_step)::text AS multi_step_requests,
      COALESCE(SUM(input_tokens), 0)::text AS input_tokens,
      COALESCE(SUM(output_tokens), 0)::text AS output_tokens,
      COALESCE(SUM(token_usage_calls), 0)::text AS token_usage_calls
    FROM cue_request_statistics
  `);
  const modeResult = await database.query(`
    SELECT
      execution_mode,
      COUNT(*)::text AS requests,
      AVG(external_calls)::float8 AS average_external_api_calls,
      AVG(response_ms)::float8 AS average_response_ms,
      AVG(local_inference_ms)::float8 AS average_local_inference_ms,
      AVG(external_ai_ms)::float8 AS average_external_ai_ms,
      AVG(tool_execution_ms)::float8 AS average_tool_execution_ms,
      COUNT(*) FILTER (WHERE completion_status = 'completed')::float8 / COUNT(*) AS completion_rate,
      CASE WHEN SUM(tool_calls) = 0 THEN NULL
        ELSE (SUM(tool_calls) - SUM(tool_failures))::float8 / SUM(tool_calls) END AS tool_success_rate
    FROM cue_request_statistics
    GROUP BY execution_mode
  `);
  const modelResult = await database.query(`
    SELECT
      model_call->>'provider' AS provider,
      model_call->>'model' AS model,
      COUNT(DISTINCT request_id)::text AS requests,
      COUNT(*)::text AS calls,
      AVG((model_call->>'latencyMs')::float8) AS average_latency_ms,
      COALESCE(SUM((model_call->>'inputTokens')::bigint), 0)::text AS input_tokens,
      COALESCE(SUM((model_call->>'outputTokens')::bigint), 0)::text AS output_tokens,
      COUNT(*) FILTER (WHERE model_call->>'inputTokens' IS NOT NULL OR model_call->>'outputTokens' IS NOT NULL)::text AS token_usage_calls
    FROM cue_request_statistics
    CROSS JOIN LATERAL jsonb_array_elements(external_models) AS calls(model_call)
    GROUP BY model_call->>'provider', model_call->>'model'
    ORDER BY COUNT(*) DESC, model_call->>'model'
  `);
  const row = totalsResult.rows[0];
  const sampleSize = safeInteger(row.sample_size, 'request count');
  const totalExternalApiCalls = safeInteger(row.total_external_api_calls, 'external API call');
  const baselineSampleSize = safeInteger(row.baseline_sample_size, 'baseline sample');
  const averageExternalApiCalls = row.average_external_api_calls === null ? null : safeNumber(row.average_external_api_calls, 'average external API call');
  const averageBaselineApiCalls = row.average_baseline_api_calls === null ? null : safeNumber(row.average_baseline_api_calls, 'baseline API call');
  const averageResponseMs = row.average_response_ms === null ? null : safeNumber(row.average_response_ms, 'average response time');
  const averageBaselineResponseMs = row.average_baseline_response_ms === null ? null : safeNumber(row.average_baseline_response_ms, 'baseline response time');
  const averageApiCallsSaved = averageBaselineApiCalls === null || averageExternalApiCalls === null
    ? null
    : averageBaselineApiCalls - averageExternalApiCalls;
  return {
    sampleSize,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    localModels: row.local_models ?? [],
    baselineModel: DOTS3_BASELINE_MODEL,
    baselineSampleSize,
    averageExternalApiCalls,
    averageBaselineApiCalls,
    averageApiCallsSaved,
    averagePercentApiCallsAvoided: averageApiCallsSaved === null || averageBaselineApiCalls === null || averageBaselineApiCalls <= 0
      ? null
      : (averageApiCallsSaved / averageBaselineApiCalls) * 100,
    totalApiCallsSaved: averageBaselineApiCalls === null
      ? null
      : averageBaselineApiCalls * sampleSize - totalExternalApiCalls,
    totalExternalApiCalls,
    averageResponseMs,
    averageBaselineResponseMs,
    averageTimeSavedMs: averageBaselineResponseMs === null || averageResponseMs === null
      ? null
      : averageBaselineResponseMs - averageResponseMs,
    averageLocalInferenceMs: row.average_local_inference_ms === null ? null : safeNumber(row.average_local_inference_ms, 'local inference time'),
    averageExternalAiMs: row.average_external_ai_ms === null ? null : safeNumber(row.average_external_ai_ms, 'external AI time'),
    averageToolExecutionMs: row.average_tool_execution_ms === null ? null : safeNumber(row.average_tool_execution_ms, 'tool execution time'),
    completionRate: sampleSize ? safeInteger(row.completed_requests, 'completed request') / sampleSize : null,
    toolSuccessRate: safeInteger(row.total_tool_calls, 'tool call') > 0
      ? (safeInteger(row.total_tool_calls, 'tool call') - safeInteger(row.total_tool_failures, 'tool failure')) / safeInteger(row.total_tool_calls, 'tool call')
      : null,
    totalToolCalls: safeInteger(row.total_tool_calls, 'tool call'),
    totalToolFailures: safeInteger(row.total_tool_failures, 'tool failure'),
    totalClarifications: safeInteger(row.total_clarifications, 'clarification'),
    multiStepRequests: safeInteger(row.multi_step_requests, 'multi-step request'),
    inputTokens: safeInteger(row.input_tokens, 'input token'),
    outputTokens: safeInteger(row.output_tokens, 'output token'),
    tokenUsageCalls: safeInteger(row.token_usage_calls, 'token usage call'),
    byMode: modeResult.rows.map(mode => ({
      mode: mode.execution_mode,
      requests: safeInteger(mode.requests, 'mode request'),
      averageExternalApiCalls: safeNumber(mode.average_external_api_calls, 'mode API call'),
      averageResponseMs: safeNumber(mode.average_response_ms, 'mode response time'),
      averageLocalInferenceMs: safeNumber(mode.average_local_inference_ms, 'mode local inference time'),
      averageExternalAiMs: safeNumber(mode.average_external_ai_ms, 'mode external AI time'),
      averageToolExecutionMs: safeNumber(mode.average_tool_execution_ms, 'mode tool execution time'),
      completionRate: safeNumber(mode.completion_rate, 'mode completion rate'),
      toolSuccessRate: mode.tool_success_rate === null ? null : safeNumber(mode.tool_success_rate, 'mode tool success rate'),
    })),
    byExternalModel: modelResult.rows.map(model => ({
      provider: model.provider,
      model: model.model,
      requests: safeInteger(model.requests, 'model request'),
      calls: safeInteger(model.calls, 'model call'),
      averageLatencyMs: safeNumber(model.average_latency_ms, 'model latency'),
      inputTokens: safeInteger(model.input_tokens, 'model input token'),
      outputTokens: safeInteger(model.output_tokens, 'model output token'),
      tokenUsageCalls: safeInteger(model.token_usage_calls, 'model token usage call'),
    })),
  };
}

export const handleGlobalStats = async (event, connectionString) => {
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') return response(405, { error: 'Method not allowed.' });
  let statistic;
  if (event.httpMethod === 'POST') {
    try { statistic = parseRequestStatistic(event.body ?? ''); }
    catch (error) { return response(400, { error: error.message }); }
  }
  let database;
  try {
    database = await getPool(connectionString).connect();
    if (statistic) {
      const result = await database.query(`
        INSERT INTO cue_request_statistics (
          request_id, started_at, completed_at, execution_mode, local_models, local_processing, external_models,
          external_calls, input_tokens, output_tokens, token_usage_calls, local_inference_ms,
          external_ai_ms, tool_execution_ms, response_ms, tool_calls, tool_failures,
          clarifications, multi_step, completion_status, dots3_baseline
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12,
          $13, $14, $15, $16, $17, $18, $19, $20, $21
        ) ON CONFLICT (request_id) DO NOTHING
      `, [
        statistic.requestId, statistic.startedAt, statistic.completedAt, statistic.executionMode,
        statistic.localModels, statistic.localProcessing, JSON.stringify(statistic.externalModels), statistic.externalCalls,
        statistic.inputTokens, statistic.outputTokens, statistic.tokenUsageCalls,
        statistic.localInferenceMs, statistic.externalAiMs, statistic.toolExecutionMs,
        statistic.responseMs, statistic.toolCalls, statistic.toolFailures,
        statistic.clarifications, statistic.multiStep, statistic.completionStatus, statistic.dots3Baseline,
      ]);
      return response(200, { accepted: true, duplicate: result.rowCount === 0 });
    }
    return response(200, await loadAggregate(database));
  } catch (error) {
    console.error('Request statistics service failed.');
    return response(503, { error: 'Global statistics are temporarily unavailable.' });
  } finally {
    database?.release();
  }
};

export const handler = event => handleGlobalStats(event, process.env.DATABASE_URL);
