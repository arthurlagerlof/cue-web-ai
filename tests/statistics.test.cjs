const test = require('node:test');
const assert = require('node:assert/strict');

const {
  beginRequestMeasurement,
  calculateStatistics,
  completeRequestMeasurement,
  flushTelemetryQueue,
  markMultiStep,
  recordClarification,
  recordExternalCall,
  recordLocalInference,
  recordLocalProcessing,
  recordToolExecution,
  restoreRequestMeasurement,
  serializeRequestMeasurement,
} = require('../src/statistics.ts');
const { UserDatabase } = require('../src/storage/userDatabase.ts');
const { createMemoryStorage } = require('../src/storage/storage.ts');

function measuredRequest(id, startedAt, completeAt, baseline = false) {
  return beginRequestMeasurement(baseline, startedAt, id);
}

test('request statistics preserve measured modes, latency, model calls, tool outcomes, and averages', () => {
  const local = measuredRequest('10000000-0000-4000-8000-000000000001', 1000);
  recordLocalInference(local, 'local/mini-lm', 40);
  recordToolExecution(local, 50, true);

  const baseline = measuredRequest('10000000-0000-4000-8000-000000000002', 2000, undefined, true);
  recordExternalCall(baseline, {
    provider: 'openrouter', model: 'dots-studio/dots-3-note-preview:free',
    latencyMs: 300, inputTokens: 5, outputTokens: 7, success: true, made: true,
  });
  recordExternalCall(baseline, {
    provider: 'openrouter', model: 'dots-studio/dots-3-note-preview:free',
    latencyMs: 500, outputTokens: 8, success: false, made: true,
  });
  recordToolExecution(baseline, 60, true);
  recordToolExecution(baseline, 90, false);

  const hybrid = measuredRequest('10000000-0000-4000-8000-000000000003', 6000);
  recordLocalInference(hybrid, 'local/mini-lm', 20);
  recordLocalProcessing(hybrid);
  recordClarification(hybrid);
  markMultiStep(hybrid, 2);
  recordExternalCall(hybrid, {
    provider: 'openrouter', model: 'provider/model-a',
    latencyMs: 40, inputTokens: 3, outputTokens: 4, success: true, made: true,
  });
  recordExternalCall(hybrid, {
    provider: 'other-provider', model: 'model-b',
    latencyMs: 60, success: true, made: true,
  });
  recordToolExecution(hybrid, 30, true);

  const records = [
    completeRequestMeasurement(local, 'completed', 2000),
    completeRequestMeasurement(baseline, 'completed', 6000),
    completeRequestMeasurement(hybrid, 'clarification', 8000),
  ];
  assert.deepEqual(records.map(record => record.executionMode), ['local', 'external', 'hybrid']);
  assert.equal(records[0].responseMs, 1000);
  assert.equal(records[1].externalAiMs, 800);
  assert.equal(records[1].toolExecutionMs, 150);
  assert.equal(records[2].externalCalls, 2);
  assert.equal(records[2].localProcessing, true);
  assert.equal(records[2].clarifications, 1);
  assert.equal(records[2].multiStep, true);
  assert.deepEqual(records[2].externalModels.map(call => call.model), ['provider/model-a', 'model-b']);
  assert.equal(records[1].multiStep, true);

  const stats = calculateStatistics(records);
  assert.equal(stats.sampleSize, 3);
  assert.equal(stats.averageExternalApiCalls, 4 / 3);
  assert.equal(stats.averageBaselineApiCalls, 2);
  assert.ok(Math.abs(stats.averageApiCallsSaved - 2 / 3) < 1e-12);
  assert.equal(stats.averagePercentApiCallsAvoided, 100 / 3);
  assert.equal(stats.totalApiCallsSaved, 2);
  assert.equal(stats.averageResponseMs, 7000 / 3);
  assert.equal(stats.averageBaselineResponseMs, 4000);
  assert.ok(Math.abs(stats.averageTimeSavedMs - 5000 / 3) < 1e-12);
  assert.equal(stats.averageLocalInferenceMs, 20);
  assert.equal(stats.averageExternalAiMs, 900 / 3);
  assert.equal(stats.averageToolExecutionMs, 230 / 3);
  assert.equal(stats.completionRate, 2 / 3);
  assert.equal(stats.toolSuccessRate, 0.75);
  assert.equal(stats.totalToolFailures, 1);
  assert.equal(stats.totalClarifications, 1);
  assert.equal(stats.multiStepRequests, 2);
  assert.equal(stats.inputTokens, 8);
  assert.equal(stats.outputTokens, 19);
  assert.equal(stats.tokenUsageCalls, 3);
  assert.deepEqual(stats.byMode.map(mode => mode.mode), ['local', 'external', 'hybrid']);
  assert.equal(stats.byExternalModel.length, 3);
  assert.equal(stats.byExternalModel[0].model, 'dots-studio/dots-3-note-preview:free');
});

test('savings remain unavailable until there is an observed Dots3-only baseline', () => {
  const measurement = measuredRequest('20000000-0000-4000-8000-000000000001', 10);
  const stats = calculateStatistics([completeRequestMeasurement(measurement, 'completed', 40)]);
  assert.equal(stats.averageExternalApiCalls, 0);
  assert.equal(stats.averageBaselineApiCalls, null);
  assert.equal(stats.averageApiCallsSaved, null);
  assert.equal(stats.averagePercentApiCallsAvoided, null);
  assert.equal(stats.averageBaselineResponseMs, null);
  assert.equal(stats.averageTimeSavedMs, null);
  assert.equal(stats.totalApiCallsSaved, null);
  assert.equal(calculateStatistics([]).completionRate, null);
});

test('pending confirmation measurements can be resumed without storing request content', () => {
  const measurement = measuredRequest('25000000-0000-4000-8000-000000000001', 500);
  recordLocalInference(measurement, 'local/model', 25);
  recordToolExecution(measurement, 10, true);
  const snapshot = serializeRequestMeasurement(measurement);
  assert.equal(Object.hasOwn(snapshot, 'prompt'), false);
  assert.equal(Object.hasOwn(snapshot, 'transcript'), false);
  const restored = restoreRequestMeasurement(JSON.parse(JSON.stringify(snapshot)));
  recordToolExecution(restored, 20, true);
  const result = completeRequestMeasurement(restored, 'completed', 1000);
  assert.equal(result.toolCalls, 2);
  assert.equal(result.responseMs, 500);
  assert.deepEqual(result.localModels, ['local/model']);
});

test('local records are deduplicated and telemetry requires consent, retries offline, and uploads once', async () => {
  const database = await new UserDatabase(createMemoryStorage(), false).initialize();
  const measurement = measuredRequest('30000000-0000-4000-8000-000000000001', 100);
  recordLocalInference(measurement, 'local/model', 10);
  const record = completeRequestMeasurement(measurement, 'completed', 300);
  assert.equal(await database.recordRequestStatistic(record), true);
  assert.equal(await database.recordRequestStatistic(record), false);
  await database.queueRequestStatistic(record);

  let fetchCalls = 0;
  const noConsent = await flushTelemetryQueue(database, async () => {
    fetchCalls++;
    return new Response('', { status: 200 });
  }, 1000, false);
  assert.deepEqual(noConsent, { uploaded: 0, failed: 0 });
  assert.equal(fetchCalls, 0);
  assert.equal((await database.getPendingTelemetry()).length, 0);

  await database.setPreference('sharePublicTelemetry', true);
  await database.queueRequestStatistic(record);
  const failed = await flushTelemetryQueue(database, async () => {
    fetchCalls++;
    throw new TypeError('offline');
  }, 1000, false);
  assert.deepEqual(failed, { uploaded: 0, failed: 1 });
  const queued = await database.getPendingTelemetry();
  assert.equal(queued.length, 1);
  assert.equal(queued[0].attempts, 1);

  let uploaded;
  const retried = await flushTelemetryQueue(database, async (url, options) => {
    fetchCalls++;
    uploaded = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ accepted: true }), { status: 200 });
  }, queued[0].nextAttemptAt, false);
  assert.deepEqual(retried, { uploaded: 1, failed: 0 });
  assert.equal(fetchCalls, 2);
  assert.equal(uploaded.url, '/.netlify/functions/global-stats');
  assert.equal(uploaded.options.method, 'POST');
  assert.equal(uploaded.options.credentials, 'omit');
  assert.equal(uploaded.options.redirect, 'error');
  assert.equal(uploaded.body.requestId, record.requestId);
  assert.equal(Object.hasOwn(uploaded.body, 'prompt'), false);
  assert.equal((await database.getPendingTelemetry()).length, 0);
  assert.equal((await database.getRequestStatistics()).length, 1);
});
