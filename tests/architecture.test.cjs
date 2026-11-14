const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const modules = Promise.all([
  import('../src/display/document.js'),
  import('../src/intelligence/toolRegistry.js'),
  import('../src/intelligence/retrieval/semanticTools.js'),
  import('../src/demo/mockProviders.js'),
  import('../src/intelligence/argumentResolution.js'),
  import('../src/intelligence/retrieval/benchmark.js'),
]);
const fixturePath = path.join(__dirname, '..', 'src', 'display', 'fixtures', 'display-documents.json');
const fixtures = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const manifests = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'seed', 'tool-manifests.json'), 'utf8'));

function sampleDocument(providerId, title, message, state = 'ready', assets = []) {
  return { schema: 'cue.display', version: 1, id: `${providerId}-${state}`, title, source: { app: providerId, name: providerId }, state, pages: [{ id: `${providerId}-page`, elements: [{ type: 'text', text: message, role: 'body' }] }], actions: [], assets };
}

function testProviders() {
  return [...new Set(manifests.map(tool => tool.providerId))].map(id => ({ id, execute: async (toolId, args) => {
    if (args.query === 'mock-error') return sampleDocument(id, 'Mock error', 'Simulated error', 'error');
    if (toolId === 'calendar.find_events') return { document: sampleDocument(id, 'Calendar events', 'Design review'), data: { events: [], firstEvent: { title: 'Dentist appointment', start: '2026-11-14T09:30:00+02:00' } } };
    if (toolId === 'alarm.create') {
      const time = new Date(args.time);
      time.setMinutes(time.getMinutes() + (args.offsetMinutes ?? 0));
      return sampleDocument(id, 'Alarm created', `${args.label} ${time.toISOString()}`, 'success');
    }
    if (toolId === 'web.search') return sampleDocument(id, 'Web results', 'Mock result', 'ready', [{ id: 'image', mimeType: 'image/svg+xml', alt: 'Illustration' }]);
    if (toolId === 'anki.search_cards' && args.query === 'not-a-card') return sampleDocument(id, 'Anki cards', 'No results', 'empty');
    if (args.query === 'mock-error') return sampleDocument(id, 'Mock error', 'Simulated error', 'error');
    return sampleDocument(id, toolId, toolId === 'anki.search_cards' ? 'Chloroplasts capture light energy.' : JSON.stringify(args), toolId.endsWith('.create_card') ? 'success' : 'ready');
  } }));
}

function fakeEmbed(text) {
  const vector = Array(384).fill(0);
  for (const token of text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    let hash = 2166136261;
    for (const character of token) hash = Math.imul(hash ^ character.codePointAt(0), 16777619) >>> 0;
    const index = hash % vector.length;
    vector[index] += hash & 1 ? 1 : -1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return { vector: vector.map(value => value / norm), dimensions: 384 };
}

async function environment(options = {}) {
  const [, , , mock] = await modules;
  return mock.createMockEnvironment({ manifests, providers: testProviders(), embed: options.embed ?? (async text => fakeEmbed(text)), threshold: options.threshold ?? 0.2, ambiguityMargin: options.ambiguityMargin ?? 0.02 });
}

test('Cue Display Document fixtures satisfy the v1 contract', async () => {
  const [display] = await modules;
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'display', 'schema', 'cue-display-v1.schema.json'), 'utf8'));
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  for (const fixture of fixtures) assert.deepEqual(display.validateDisplayDocument(fixture), { valid: true, errors: [] });
});

test('display validator checks nested components, assets, action IDs, and registry arguments', async () => {
  const [display, registryModule, , mock] = await modules;
  const runtime = await mock.createMockEnvironment({ manifests, providers: testProviders(), embed: async text => fakeEmbed(text) });
  const valid = display.validateDisplayDocument(fixtures[0], { registry: runtime.registry });
  assert.equal(valid.valid, true);
  const unknownComponent = structuredClone(fixtures[0]);
  unknownComponent.pages[0].elements[0].children.push({ type: 'video', src: 'javascript:alert(1)' });
  assert.match(display.validateDisplayDocument(unknownComponent).errors.join(' '), /unsupported component/);
  const missingAsset = structuredClone(fixtures[4]);
  missingAsset.pages[0].elements[0].assetId = 'missing';
  assert.match(display.validateDisplayDocument(missingAsset).errors.join(' '), /unknown asset/);
  const extended = structuredClone(fixtures[0]);
  extended.futureOptional = { value: true };
  assert.equal(display.validateDisplayDocument(extended).valid, true);
  extended.version = 2;
  assert.equal(display.validateDisplayDocument(extended).valid, false);
  const badAction = structuredClone(fixtures[0]);
  badAction.actions[0].toolId = 'unknown.execute';
  assert.equal(display.validateDisplayDocument(badAction, { registry: runtime.registry }).valid, false);
  const badArgs = structuredClone(fixtures[0]);
  badArgs.actions[0].arguments = { query: 42 };
  assert.equal(display.validateDisplayDocument(badArgs, { registry: runtime.registry }).valid, false);
  assert.equal(registryModule.validateArguments(runtime.registry.get('anki.search_cards').parameters, { query: 'x' }).valid, true);
});

test('retrieval aggregation is source-aware, configurable, and unaffected by weak extra examples', async () => {
  const [, , retrieval] = await modules;
  const records = [
    { namespace: 'tool', toolId: 'calendar.find_events', sourceType: 'description', vector: [1, 0] },
    { namespace: 'tool', toolId: 'calendar.find_events', sourceType: 'keyword', vector: [0.6, 0.8] },
    { namespace: 'tool', toolId: 'calendar.find_events', sourceType: 'example', vector: [0.8, 0.6] },
    ...Array.from({ length: 20 }, () => ({ namespace: 'tool', toolId: 'calendar.find_events', sourceType: 'example', vector: [0, 1] })),
  ];
  const candidate = retrieval.discoverTools([1, 0], records, { threshold: 0, strategy: 'weighted-max' })[0];
  assert.equal(candidate.bestDescriptionSimilarity, 1);
  assert.equal(candidate.bestKeywordSimilarity, 0.6);
  assert.equal(candidate.bestExampleSimilarity, 0.8);
  assert.ok(Math.abs(candidate.score - 0.81) < 1e-12);
});

test('synthetic benchmark covers registered tools, languages, ambiguity, and no-tool outcomes', async () => {
  const benchmarkCases = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'seed', 'tool-routing-benchmark.json'), 'utf8'));
  const toolIds = new Set(manifests.map(tool => tool.id));
  const positiveIds = new Set(benchmarkCases.filter(item => item.expectedToolId).map(item => item.expectedToolId));
  assert.deepEqual([...toolIds].sort(), [...positiveIds].sort());
  assert.ok(benchmarkCases.some(item => item.language === 'en'));
  assert.ok(benchmarkCases.some(item => item.language === 'fi'));
  assert.ok(benchmarkCases.some(item => item.expectedOutcome === 'ambiguous'));
  assert.ok(benchmarkCases.some(item => item.expectedOutcome === 'no_tool'));
  const [, , , , , benchmark] = await modules;
  const cases = [
    { id: 'positive', language: 'en', request: 'positive', expectedToolId: 'test.lookup' },
    { id: 'ambiguous', language: 'fi', request: 'ambiguous', expectedOutcome: 'ambiguous' },
    { id: 'negative', language: 'en', request: 'negative', expectedOutcome: 'no_tool' },
  ];
  const vectors = { positive: [1, 0], ambiguous: [Math.SQRT1_2, Math.SQRT1_2], negative: [0, 0, 1] };
  const records = [
    { namespace: 'tool', toolId: 'test.lookup', sourceType: 'example', vector: [1, 0] },
    { namespace: 'tool', toolId: 'test.first', sourceType: 'example', vector: [0, 1] },
  ];
  const result = await benchmark.evaluateToolBenchmark({ cases, records, embed: async request => vectors[request], config: { minimumScore: 0.99, plausibleScore: 0.5, ambiguityMargin: 0.1 } });
  assert.equal(result.top1ToolAccuracy, 1);
  assert.equal(result.ambiguityDetectionRate, 1);
  assert.equal(result.correctNoToolRate, 1);
  assert.equal(result.falseToolActivationRate, 0);
});

test('semantic retrieval finds expected tools in English and Finnish without mixing namespaces', async () => {
  const [, , retrieval, runtimeMock] = await modules;
  const runtime = await runtimeMock.createMockEnvironment({ manifests, providers: testProviders(), embed: async text => fakeEmbed(text), threshold: 0.2 });
  const cases = [
    ['Create a flashcard about photosynthesis.', 'anki.create_card'],
    ['Lisää tämä Anki-kortteihin.', 'anki.create_card'],
    ['What events do I have tomorrow?', 'calendar.find_events'],
    ['Etsi huomisen kalenteritapahtumat.', 'calendar.find_events'],
    ['Set an alarm for my first meeting.', 'alarm.create'],
    ['Search the web for recent research on this topic.', 'web.search'],
    ['Find the message I received from Alex.', 'notifications.search'],
  ];
  for (const [query, expected] of cases) {
    const candidates = retrieval.discoverTools(fakeEmbed(query).vector, runtime.exampleIndex, { threshold: 0.2 });
    assert.ok(candidates.some(candidate => candidate.toolId === expected), `${query} should retrieve ${expected}`);
    assert.ok(candidates.every(candidate => runtime.registry.get(candidate.toolId)), 'only registered tool IDs are returned');
  }
  assert.deepEqual(retrieval.discoverTools(fakeEmbed('qzxv plmokn').vector, runtime.exampleIndex, { threshold: 0.99 }), []);
  const status = retrieval.detectAmbiguity([{ toolId: 'a', score: 0.51 }, { toolId: 'b', score: 0.5 }], { minimumScore: 0.3, margin: 0.04 });
  assert.equal(status, 'ambiguous');
});

test('end-to-end request uses registered tools and returns a validated display document', async () => {
  const runtime = await environment();
  const result = await runtime.intelligence.handle('Search my Anki cards about photosynthesis.');
  assert.equal(result.kind, 'document');
  assert.equal(result.document.schema, 'cue.display');
  assert.equal(result.document.source.app, 'anki');
  assert.match(JSON.stringify(result.document), /chloroplasts/i);
  const noTool = await runtime.intelligence.handle('qzxv plmokn');
  assert.equal(noTool.kind, 'no_tool');
});

test('semantic routing excludes generative model selection and retains clarifications', async () => {
  const runtime = await environment();
  const worker = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'model.worker.ts'), 'utf8');
  assert.doesNotMatch(worker, /gemma|text-generation|resolve/i);
  const search = await runtime.intelligence.handle('Search my Anki cards about chloroplasts');
  assert.equal(search.kind, 'document');
  const clarification = await runtime.intelligence.handle('Create a flashcard about photosynthesis');
  assert.equal(clarification.kind, 'clarification');
  assert.deepEqual(clarification.resolution.missing, ['front', 'back']);
  const continued = await runtime.intelligence.handle('front: What is photosynthesis? back: Plants convert light into chemical energy.');
  assert.equal(continued.kind, 'confirmation_required');
  assert.equal(continued.pendingCall.toolId, 'anki.create_card');
  assert.deepEqual(continued.pendingCall.arguments, { front: 'What is photosynthesis', back: 'Plants convert light into chemical energy' });
});

test('deterministic argument parsing supports Finnish dates, time zones, DST ambiguity, and corrections', async () => {
  const [, , , , argumentResolution] = await modules;
  const tool = { parameters: { type: 'object', properties: { time: { type: 'string', format: 'date-time' } }, required: ['time'] } };
  const finnish = argumentResolution.resolveArguments({ request: 'Huomenna klo 14.00', tool, context: { now: new Date('2026-11-14T07:00:00Z'), timeZone: 'Europe/Helsinki', locale: 'fi-FI' } });
  assert.equal(finnish.arguments.time, '2026-11-15T14:00:00+02:00');
  assert.equal(finnish.fields.time.source, 'current_user_request');
  assert.equal(finnish.fields.time.method, 'chrono-node');
  const corrected = argumentResolution.resolveArguments({ request: '15:00', tool, previous: { time: { value: '2026-11-20T10:00:00+02:00', source: 'current_user_request' } }, context: { now: new Date('2026-11-14T07:00:00Z'), timeZone: 'Europe/Helsinki', locale: 'en' } });
  assert.equal(corrected.arguments.time, '2026-11-20T15:00:00+02:00');
  const daylightGap = argumentResolution.resolveArguments({ request: 'March 29 at 3:30', tool, context: { now: new Date('2026-03-01T10:00:00Z'), timeZone: 'Europe/Helsinki', locale: 'en' } });
  assert.ok(daylightGap.ambiguous.length > 0);
  const createTool = manifests.find(tool => tool.id === 'calendar.create_event');
  const initial = argumentResolution.resolveArguments({ request: 'Schedule a meeting next Friday', tool: createTool, context: { now: new Date('2026-11-14T07:00:00Z'), timeZone: 'Europe/Helsinki', locale: 'en' } });
  assert.equal(initial.fields.start.value, '2026-11-20');
  const startFollowup = argumentResolution.resolveArguments({ request: 'At 14:30', tool: createTool, previous: initial.fields, context: { now: new Date('2026-11-14T07:00:00Z'), timeZone: 'Europe/Helsinki', locale: 'en' } });
  assert.equal(startFollowup.arguments.start, '2026-11-20T14:30:00+02:00');
  assert.ok(startFollowup.missing.includes('end'));
  const endFollowup = argumentResolution.resolveArguments({ request: 'End at 15:00', tool: createTool, previous: startFollowup.fields, context: { now: new Date('2026-11-14T07:00:00Z'), timeZone: 'Europe/Helsinki', locale: 'en' } });
  assert.equal(endFollowup.arguments.end, '2026-11-20T15:00:00+02:00');
  assert.equal(endFollowup.arguments.start, '2026-11-20T14:30:00+02:00');
});

test('semantic multi-step requests use actual prior results and confirm only the write', async () => {
  const isolatedVector = index => { const vector = Array(384).fill(0); vector[index] = 1; return { vector, dimensions: 384 }; };
  const runtime = await environment({ embed: async text => ['Find my next dentist appointment', 'Find my first meeting tomorrow'].includes(text) ? isolatedVector(0) : ['set an alarm 30 minutes beforehand', 'Set an alarm for my first meeting'].includes(text) ? isolatedVector(1) : fakeEmbed(text) });
  const result = await runtime.intelligence.handle('Find my next dentist appointment and set an alarm 30 minutes beforehand');
  assert.equal(result.kind, 'confirmation_required', JSON.stringify(result));
  assert.equal(result.pendingCall.toolId, 'alarm.create');
  assert.equal(result.pendingCall.arguments.time, '2026-11-14T09:30:00+02:00');
  assert.equal(result.pendingCall.arguments.offsetMinutes, -30);
  assert.equal(result.completedOperations[0].toolId, 'calendar.find_events');
});

test('side effects require confirmation, and invalid or unknown calls are rejected', async () => {
  const runtime = await environment();
  const clarification = await runtime.intelligence.handle('Create a flashcard about photosynthesis.');
  assert.equal(clarification.kind, 'clarification');
  const pending = await runtime.intelligence.handle('front: What is photosynthesis? back: Plants convert light into chemical energy.');
  assert.equal(pending.kind, 'confirmation_required');
  assert.equal(pending.pendingCall.toolId, 'anki.create_card');
  const result = await runtime.dispatcher.dispatch(pending.pendingCall, { confirmed: true });
  assert.equal(result.document.id, 'anki-success');
  await assert.rejects(runtime.dispatcher.dispatch({ toolId: 'calendar.create_event', arguments: { title: 'Missing required fields' } }), /Invalid arguments/);
  await assert.rejects(runtime.dispatcher.dispatch({ toolId: 'provider.inject', arguments: {} }), /Unknown tool id/);
  const unavailable = await environment();
  unavailable.registry.providers.get('alarm').available = false;
  await assert.rejects(unavailable.dispatcher.dispatch({ toolId: 'alarm.find', arguments: { query: 'morning' } }), /Provider unavailable/);
  const restricted = await environment();
  restricted.registry.registerTool({ id: 'alarm.permission_test', providerId: 'alarm', name: 'Restricted alarm action', description: 'Requires alarm write permission.', examples: ['Test alarm write permission'], parameters: { type: 'object', properties: {}, additionalProperties: false }, requiredPermissions: ['alarm.write'], confirmation: 'none' });
  await assert.rejects(restricted.dispatcher.dispatch({ toolId: 'alarm.permission_test', arguments: {} }), /lacks execution permission/);
});

test('multi-tool plan uses a returned event time before creating the dependent alarm', async () => {
  const runtime = await environment();
  const plan = { operations: [
    { id: 'events', toolId: 'calendar.find_events', arguments: { date: '2026-11-14' } },
    { id: 'alarm', toolId: 'alarm.create', dependsOn: ['events'], arguments: { time: { $from: { operationId: 'events', path: 'firstEvent.start' } }, offsetMinutes: -15, label: 'Meeting alarm' } },
  ] };
  const pending = await runtime.dispatcher.dispatchPlan(plan);
  assert.equal(pending.state, 'confirmation_required');
  assert.equal(pending.operations[0].toolId, 'alarm.create');
  const result = await runtime.dispatcher.dispatchPlan(plan, { confirmed: true });
  assert.equal(result.document.id, 'alarm-success');
  assert.ok(JSON.stringify(result.document).includes('2026-11-14T07:15:00.000Z'));
});

test('mock providers cover empty, error, image, and independent knowledge retrieval', async () => {
  const runtime = await environment();
  const knowledge = await runtime.dispatcher.dispatch({ toolId: 'knowledge.search', arguments: { query: 'semantic retrieval' } });
  assert.equal(knowledge.document.source.app, 'knowledge');
  const web = await runtime.dispatcher.dispatch({ toolId: 'web.search', arguments: { query: 'local AI' } });
  assert.equal(web.document.assets[0].mimeType, 'image/svg+xml');
  const empty = await runtime.dispatcher.dispatch({ toolId: 'anki.search_cards', arguments: { query: 'not-a-card' } });
  assert.equal(empty.document.state, 'empty');
  const failure = await runtime.dispatcher.dispatch({ toolId: 'web.search', arguments: { query: 'mock-error' } });
  assert.equal(failure.document.state, 'error');
});
