const test = require('node:test');
const assert = require('node:assert/strict');

const { UserDatabase } = require('../src/storage/userDatabase.ts');
const { createMemoryStorage } = require('../src/storage/storage.ts');
const { createHash } = require('node:crypto');

test('browser database seeds locally, preserves mutations across reopen, and resets to synthetic fixtures', async () => {
  const storage = createMemoryStorage();
  const database = await new UserDatabase(storage, false).initialize();
  const initial = await database.getRegistryData();
  assert.equal(initial.providers.length, 6);
  assert.equal(initial.tools.length, 18);
  const { EMBEDDING_MODEL } = await import('../src/intelligence/embeddingModel.js');
  const embeddingSeed = require('../data/seed/tool-embeddings.json');
  const cached = await database.getCachedEmbedding(embeddingSeed.entries[0].text, EMBEDDING_MODEL);
  assert.equal(cached.dimensions, 384);
  assert.equal(cached.vector.length, 384);

  await database.putRecord('anki', 'cards', { id: 'user-card', front: 'Local', back: 'Only' });
  const reopened = await new UserDatabase(storage, false).initialize();
  assert.equal((await reopened.getRecord('anki', 'cards', 'user-card')).back, 'Only');
  await reopened.resetDemoData();
  assert.equal(await reopened.getRecord('anki', 'cards', 'user-card'), undefined);
  assert.equal((await reopened.getRecords('anki', 'cards')).length, 20);
  assert.equal((await reopened.getCachedEmbedding(embeddingSeed.entries[0].text, EMBEDDING_MODEL)).vector.length, 384);
});

test('seeded indexes load without inference and regenerate only missing, changed or stale content', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-16T12:00:00Z') });
  const { createDatabaseEnvironment } = await import('../src/demo/databaseEnvironment.js');
  const { EMBEDDING_MODEL, EMBEDDING_CACHE_VERSION } = await import('../src/intelligence/embeddingModel.js');
  const storage = createMemoryStorage();
  const database = await new UserDatabase(storage, false).initialize();
  const calls = [];
  const embed = async (text, options) => {
    calls.push({ text, purpose: options.purpose });
    return { vector: Array(384).fill(1 / Math.sqrt(384)), dimensions: 384 };
  };
  const initial = await createDatabaseEnvironment({ database, embed });
  assert.equal(calls.length, 0);
  assert.ok(initial.exampleIndex.some(entry => entry.sourceType === 'keyword'));
  assert.ok(initial.providerDataIndex.length > 0);

  const registry = await database.getRegistryData();
  const oldText = registry.tools[0].description;
  const key = `${EMBEDDING_MODEL}:${EMBEDDING_CACHE_VERSION}:${createHash('sha256').update(oldText).digest('hex')}`;
  await storage.put('embeddings', key, { model: EMBEDDING_MODEL, version: 'outdated', dimensions: 384, vector: Array(384).fill(1) });
  const missingText = registry.tools[2].keywords[0];
  const missingKey = `${EMBEDDING_MODEL}:${EMBEDDING_CACHE_VERSION}:${createHash('sha256').update(missingText).digest('hex')}`;
  await storage.delete('embeddings', missingKey);
  const invalidText = registry.tools[3].description;
  const invalidKey = `${EMBEDDING_MODEL}:${EMBEDDING_CACHE_VERSION}:${createHash('sha256').update(invalidText).digest('hex')}`;
  await storage.put('embeddings', invalidKey, { model: EMBEDDING_MODEL, version: EMBEDDING_CACHE_VERSION, dimensions: 384, vector: Array(384).fill(0) });
  registry.tools[1].description = 'A changed tool description';
  await database.putRecord('anki', 'cards', { id: 'new-card', front: 'A new card', back: 'A new answer' });
  await createDatabaseEnvironment({ database, registryData: registry, embed });
  assert.deepEqual(new Set(calls.map(call => call.text)), new Set([oldText, missingText, invalidText, 'A changed tool description', 'A new card\nA new answer']));
  assert.ok(calls.every(call => call.purpose === 'index'));
  calls.length = 0;
  await createDatabaseEnvironment({ database, registryData: registry, embed });
  assert.equal(calls.length, 0);
});

test('packaged demo dates and embeddings stay fixed across days while user changes are indexed', async t => {
  const { seedDate } = require('../data/seed/tool-embeddings.json');
  assert.match(seedDate, /^\d{4}-\d{2}-\d{2}$/);
  const builtAt = Date.parse(`${seedDate}T12:00:00Z`);
  t.mock.timers.enable({ apis: ['Date'], now: builtAt });
  const { createDatabaseEnvironment } = await import('../src/demo/databaseEnvironment.js');
  const database = await new UserDatabase(createMemoryStorage(), false).initialize();
  const calls = [];
  const embed = async (text, options) => {
    calls.push({ text, purpose: options.purpose });
    return { vector: Array(384).fill(1 / Math.sqrt(384)), dimensions: 384 };
  };
  const built = await createDatabaseEnvironment({ database, embed });
  assert.equal(calls.length, 0);
  const builtStart = built.data.calendar.events.find(record => record.id === 'event-1').start;
  assert.equal(builtStart, `${new Date(builtAt - 2 * 86_400_000).toISOString().slice(0, 10)}T09:30:00+02:00`);
  assert.ok(built.providerDataIndex.find(item => item.recordId === 'event-1' && item.providerId === 'calendar').text.includes(builtStart));
  const later = new Date(builtAt + 40 * 86_400_000);
  t.mock.timers.setTime(later.getTime());
  const laterRuntime = await createDatabaseEnvironment({ database, embed });
  assert.equal(calls.length, 0);
  assert.equal(laterRuntime.data.calendar.events.find(record => record.id === 'event-1').start, builtStart);
  assert.ok(laterRuntime.demoClock.startsWith(later.toISOString().slice(0, 10)));
  const fresh = await new UserDatabase(createMemoryStorage(), false).initialize();
  await createDatabaseEnvironment({ database: fresh, embed });
  assert.equal(calls.length, 0);

  const event = await database.getRecord('calendar', 'events', 'event-1');
  await database.putRecord('calendar', 'events', { ...event, start: '2027-01-01T09:30:00+02:00' });
  await createDatabaseEnvironment({ database, embed });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].purpose, 'index');
  assert.ok(calls[0].text.includes('2027-01-01T09:30:00+02:00'));
  await createDatabaseEnvironment({ database, embed });
  assert.equal(calls.length, 1);
});

test('browser conversations and operation idempotency survive database reconstruction', async () => {
  const storage = createMemoryStorage();
  const database = await new UserDatabase(storage, false).initialize();
  const state = {
    conversationId: 'conversation-test',
    status: 'awaiting_confirmation',
    pendingConfirmation: {
      call: { toolId: 'anki.create_card', arguments: { front: 'Q', back: 'A' }, operationId: 'operation-test' },
    },
  };
  await database.saveConversationState(state);
  const reopened = await new UserDatabase(storage, false).initialize();
  assert.equal((await reopened.getConversationState()).pendingConfirmation.call.operationId, 'operation-test');

  const registry = await reopened.getRegistryData();
  const tool = registry.tools.find(item => item.id === 'anki.create_card');
  const provider = registry.providers.find(item => item.id === 'anki');
  let executions = 0;
  const run = async () => { executions++; return { document: { id: 'result' } }; };
  const context = { confirmed: true, operationId: 'operation-test' };
  const first = await reopened.executeRegisteredTool(tool, provider, { front: 'Q', back: 'A' }, context, run);
  const repeated = await reopened.executeRegisteredTool(tool, provider, { front: 'Q', back: 'A' }, context, run);
  assert.deepEqual(repeated, first);
  assert.equal(executions, 1);
  await assert.rejects(
    reopened.executeRegisteredTool(tool, provider, { front: 'different', back: 'A' }, context, run),
    /already used for a different action/,
  );
  await assert.rejects(
    reopened.executeRegisteredTool(tool, provider, { front: 'Q', back: 'A' }, { operationId: 'unconfirmed' }, run),
    /Confirmation required/,
  );
});

test('side-effect operation claims are atomic and failed actions are never retried automatically', async () => {
  const database = await new UserDatabase(createMemoryStorage(), false).initialize();
  const registry = await database.getRegistryData();
  const tool = registry.tools.find(item => item.id === 'anki.create_card');
  const provider = registry.providers.find(item => item.id === 'anki');
  let executions = 0;
  const run = async () => {
    executions++;
    await new Promise(resolve => setTimeout(resolve, 5));
    return { ok: true };
  };
  const context = { confirmed: true, operationId: 'parallel-operation' };
  const results = await Promise.all([
    database.executeRegisteredTool(tool, provider, { front: 'Q', back: 'A' }, context, run),
    database.executeRegisteredTool(tool, provider, { front: 'Q', back: 'A' }, context, run),
  ]);
  assert.deepEqual(results, [{ ok: true }, { ok: true }]);
  assert.equal(executions, 1);

  let failures = 0;
  const failedContext = { confirmed: true, operationId: 'failed-operation' };
  await assert.rejects(database.executeRegisteredTool(tool, provider, { front: 'F', back: 'A' }, failedContext, async () => {
    failures++;
    throw new Error('simulated adapter failure');
  }), /simulated adapter failure/);
  await assert.rejects(database.executeRegisteredTool(tool, provider, { front: 'F', back: 'A' }, failedContext, async () => {
    failures++;
    return { ok: true };
  }), /cannot be safely repeated after status failed/);
  assert.equal(failures, 1);
});

test('database version errors surface and local backup excludes unrelated secret stores', async () => {
  const storage = createMemoryStorage();
  await storage.put('meta', 'schemaVersion', 9);
  await assert.rejects(new UserDatabase(storage, false).initialize(), /Unsupported local database schema version/);

  const backupStorage = createMemoryStorage();
  const database = await new UserDatabase(backupStorage, false).initialize();
  await database.putRecord('knowledge', 'documents', { id: 'private-local-record', title: 'Local only' });
  await backupStorage.put('secrets', 'openrouter', 'not-exported');
  const backup = await database.exportBackup();
  assert.equal(backup.format, 'cue-browser-backup');
  assert.ok(backup.data.records.some(entry => entry.value.recordId === 'private-local-record'));
  assert.equal(Object.hasOwn(backup.data, 'secrets'), false);
  assert.equal(JSON.stringify(backup).includes('not-exported'), false);
});

test('database v1 migration preserves user records and initializes new counters', async () => {
  const storage = createMemoryStorage();
  await storage.put('meta', 'schemaVersion', 1);
  await storage.put('usage', 'requests', 5);
  await storage.put('records', JSON.stringify(['knowledge', 'documents', 'before-upgrade']), {
    providerId: 'knowledge',
    recordType: 'documents',
    recordId: 'before-upgrade',
    value: { id: 'before-upgrade', title: 'Preserved local record' },
    origin: 'user',
  });
  const database = await new UserDatabase(storage, false).initialize();
  assert.equal(await storage.get('meta', 'schemaVersion'), 2);
  assert.equal((await database.getRecord('knowledge', 'documents', 'before-upgrade')).title, 'Preserved local record');
  assert.equal((await database.getUsageStats()).requests, 5);
  assert.equal((await database.getUsageStats()).dots3Calls, 0);
});

test('usage statistics store only bounded local counters', async () => {
  const database = await new UserDatabase(createMemoryStorage(), false).initialize();
  await database.recordUsage('requests', 3);
  await database.recordUsage('externalCalls');
  await database.recordUsage('dots3Requests', 2);
  await database.recordUsage('dots3Calls', 3);
  await Promise.all(Array.from({ length: 25 }, () => database.recordUsage('requests')));
  assert.deepEqual(await database.getUsageStats(), {
    requests: 28,
    localCalls: 0,
    externalCalls: 1,
    dots3Requests: 2,
    dots3Calls: 3,
    executions: 0,
    successes: 0,
    failures: 0,
    clarifications: 0,
  });
  await assert.rejects(database.recordUsage('request-text'), /invalid/);
  await assert.rejects(database.recordUsage('requests', -1), /invalid/);
});
