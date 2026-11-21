const test = require('node:test');
const assert = require('node:assert/strict');

const request = {
  requestId: '4bf92f35-77ad-4a2d-a4ca-6e63f2e7d111',
  startedAt: '2026-11-17T06:00:00.000Z',
  completedAt: '2026-11-17T06:00:02.000Z',
  executionMode: 'external',
  localModels: [],
  localProcessing: false,
  externalModels: [{
    provider: 'openrouter',
    model: 'dots-studio/dots-3-note-preview:free',
    latencyMs: 1200,
    inputTokens: 40,
    outputTokens: 20,
    success: true,
  }],
  externalCalls: 1,
  inputTokens: 40,
  outputTokens: 20,
  tokenUsageCalls: 1,
  localInferenceMs: 0,
  externalAiMs: 1200,
  toolExecutionMs: 200,
  responseMs: 2000,
  toolCalls: 1,
  toolFailures: 0,
  clarifications: 0,
  multiStep: false,
  completionStatus: 'completed',
  selectedMode: 'dots3_always',
  requestText: 'Find my meeting',
};

test('telemetry accepts bounded request text and rejects unapproved fields', async () => {
  const { parseRequestStatistic } = await import('../netlify/functions/global-stats.mjs');
  assert.deepEqual(parseRequestStatistic(JSON.stringify(request)), request);
  assert.equal(parseRequestStatistic(JSON.stringify({ ...request, responseMs: 1800 })).responseMs, 1800);
  for (const body of [
    '{',
    JSON.stringify({ ...request, prompt: 'private' }),
    JSON.stringify({ ...request, externalCalls: 2 }),
    JSON.stringify({ ...request, requestId: 'not-a-uuid' }),
    JSON.stringify({ ...request, responseMs: -1 }),
    JSON.stringify({ ...request, responseMs: 2001 }),
    JSON.stringify({ ...request, executionMode: 'hybrid' }),
    JSON.stringify({ ...request, selectedMode: 'invalid' }),
    JSON.stringify({ ...request, requestText: 'x'.repeat(100001) }),
    JSON.stringify({ ...request, externalModels: [{ ...request.externalModels[0], arguments: { secret: true } }] }),
  ]) {
    assert.throws(() => parseRequestStatistic(body));
  }
});

test('request ingestion deduplicates IDs and GET exposes aggregate data only', async () => {
  const [{ handler }, pg] = await Promise.all([
    import('../netlify/functions/global-stats.mjs'),
    import('pg'),
  ]);
  const Pool = pg.Pool ?? pg.default.Pool;
  const originalConnect = Pool.prototype.connect;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const inserted = new Set();
  const queries = [];
  Pool.prototype.connect = async () => ({
    async query(sql, values) {
      queries.push({ sql, values });
      if (sql.trimStart().startsWith('INSERT')) {
        const duplicate = inserted.has(values[0]);
        inserted.add(values[0]);
        return { rowCount: duplicate ? 0 : 1, rows: [] };
      }
      if (sql.includes('GROUP BY execution_mode')) {
        return { rows: [{
          execution_mode: 'external', requests: '2', average_external_api_calls: 1.5,
          average_response_ms: 3000, average_local_inference_ms: 0,
          average_external_ai_ms: 1500, average_tool_execution_ms: 250,
          completion_rate: 0.5, tool_success_rate: 0.5,
        }] };
      }
      if (sql.includes('jsonb_array_elements')) {
        if (sql.includes('GROUP BY selected_mode')) return { rows: [{
          selected_mode: 'dots3_always', requests: '2', period_start: '2026-11-17T06:00:00.000Z',
          period_end: '2026-11-17T07:00:00.000Z', average_external_api_calls: 1.5,
          average_response_ms: 3000, average_local_inference_ms: 0, external_calls: '3',
          average_external_call_latency_ms: 1000, completion_rate: 0.5,
          tool_calls: '2', tool_success_rate: 0.5, average_input_tokens: 60,
          average_output_tokens: 30, token_sample_size: '2',
        }] };
        return { rows: [{
          provider: 'openrouter', model: 'dots-studio/dots-3-note-preview:free',
          requests: '2', calls: '3', average_latency_ms: 1500,
          input_tokens: '120', output_tokens: '60', token_usage_calls: '3',
        }] };
      }
      return { rows: [{
        sample_size: '2', period_start: '2026-11-17T06:00:00.000Z',
        period_end: '2026-11-17T07:00:00.000Z', local_models: [],
        total_external_api_calls: '3', average_external_api_calls: 1.5,
        average_response_ms: 3000,
        average_local_inference_ms: 0, average_external_ai_ms: 1500,
        average_tool_execution_ms: 250, completed_requests: '1',
        total_tool_calls: '2', total_tool_failures: '1',
        total_clarifications: '3', multi_step_requests: '1',
        input_tokens: '120', output_tokens: '60', token_usage_calls: '3',
      }] };
    },
    release() {},
  });
  process.env.DATABASE_URL = 'postgres://test.invalid/cue';
  try {
    const first = await handler({ httpMethod: 'POST', body: JSON.stringify(request) });
    const duplicate = await handler({ httpMethod: 'POST', body: JSON.stringify(request) });
    assert.equal(first.statusCode, 200);
    assert.deepEqual(JSON.parse(first.body), { accepted: true, duplicate: false });
    assert.deepEqual(JSON.parse(duplicate.body), { accepted: true, duplicate: true });
    assert.deepEqual(queries[0].values[0], request.requestId);
    assert.equal(queries[0].values.at(-1), request.requestText);
    assert.match(queries[0].sql, /ON CONFLICT \(request_id\) DO NOTHING/);

    const result = await handler({ httpMethod: 'GET' });
    assert.equal(result.statusCode, 200);
    const stats = JSON.parse(result.body);
    assert.equal(stats.sampleSize, 2);
    assert.equal(stats.averageExternalApiCalls, 1.5);
    assert.equal(stats.bySelectedMode[0].requests, 0);
    assert.equal(stats.bySelectedMode[2].averageInputTokens, 60);
    assert.equal(stats.bySelectedMode[2].averageExternalCallLatencyMs, 1000);
    assert.equal(stats.completionRate, 0.5);
    assert.equal(stats.toolSuccessRate, 0.5);
    assert.equal(stats.byExternalModel[0].calls, 3);
    assert.equal(Object.hasOwn(stats, 'requestId'), false);
    assert.doesNotMatch(result.body, /Find my meeting|requestText|4bf92f35/);
    assert.equal(queries.filter(query => /^(SELECT|WITH)/.test(query.sql.trimStart())).length, 4);
    assert.ok(queries.every(query => !/SELECT\s+\*/i.test(query.sql)));
    const { DEMO_SCENARIOS } = await import('../src/demo/demoScenarios.js');
    const beforeFiltered = queries.length;
    const filtered = await handler({ httpMethod: 'GET', queryStringParameters: { request: DEMO_SCENARIOS[0] } });
    assert.equal(filtered.statusCode, 200);
    const filteredQueries = queries.slice(beforeFiltered);
    assert.equal(filteredQueries.length, 4);
    for (const query of filteredQueries) {
      assert.deepEqual(query.values, [DEMO_SCENARIOS[0]]);
      assert.match(query.sql, /request_text = \$1/);
    }
    assert.match(filteredQueries[0].sql, /local_stats\.request_text = \$1/);
    assert.doesNotMatch(filtered.body, /requestText|4bf92f35/);
    const beforeInvalid = queries.length;
    const invalid = await handler({ httpMethod: 'GET', queryStringParameters: { request: 'Find my meeting' } });
    assert.equal(invalid.statusCode, 400);
    assert.equal(queries.length, beforeInvalid);
  } finally {
    Pool.prototype.connect = originalConnect;
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  }
});
