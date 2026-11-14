const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const modules = Promise.all([
  import('../src/display/document.js'),
  import('../src/intelligence/toolRegistry.js'),
  import('../src/intelligence/retrieval/semanticTools.js'),
  import('../src/demo/mockProviders.js'),
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
    if (toolId === 'calendar.find_events') return { document: sampleDocument(id, 'Calendar events', 'Design review'), data: { events: [], firstEvent: { start: '2026-11-14T09:30:00+02:00' } } };
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

function resolverFor(text) {
  if (/flashcard|anki-kortteihin|kortti/i.test(text)) return { kind: 'tool', toolId: 'anki.create_card', arguments: { front: 'What is photosynthesis?', back: 'Plants convert light into chemical energy.', tags: ['biology'] } };
  if (/search my anki|etsi anki/i.test(text)) return { kind: 'tool', toolId: 'anki.search_cards', arguments: { query: 'photosynthesis' } };
  if (/events|kalenteritapahtumat/i.test(text)) return { kind: 'tool', toolId: 'calendar.find_events', arguments: { date: '2026-11-14' } };
  if (/first meeting/i.test(text)) return { kind: 'multi_tool', operations: [
    { id: 'events', toolId: 'calendar.find_events', arguments: { date: '2026-11-14' } },
    { id: 'alarm', toolId: 'alarm.create', dependsOn: ['events'], arguments: { time: { $from: { operationId: 'events', path: 'firstEvent.start' } }, offsetMinutes: -15, label: 'Meeting alarm' } },
  ] };
  if (/search the web|hae verkosta/i.test(text)) return { kind: 'tool', toolId: 'web.search', arguments: { query: 'local AI research' } };
  if (/message.*alex|alexin/i.test(text)) return { kind: 'tool', toolId: 'notifications.search', arguments: { query: 'Alex' } };
  return { kind: 'clarification', question: 'Which item did you mean?' };
}

async function environment(resolve = ({ transcription }) => resolverFor(transcription)) {
  const [, , , mock] = await modules;
  return mock.createMockEnvironment({ manifests, providers: testProviders(), embed: async text => fakeEmbed(text), resolve, threshold: 0.2, ambiguityMargin: 0.02 });
}

test('Cue Display Document fixtures satisfy the v1 contract', async () => {
  const [display] = await modules;
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'display', 'schema', 'cue-display-v1.schema.json'), 'utf8'));
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  for (const fixture of fixtures) assert.deepEqual(display.validateDisplayDocument(fixture), { valid: true, errors: [] });
});

test('display validator checks nested components, assets, action IDs, and registry arguments', async () => {
  const [display, registryModule, , mock] = await modules;
  const runtime = await mock.createMockEnvironment({ manifests, providers: testProviders(), embed: async text => fakeEmbed(text), resolve: async () => ({ kind: 'answer', text: 'ok' }) });
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

test('semantic retrieval finds expected tools in English and Finnish without mixing namespaces', async () => {
  const [, , retrieval, runtimeMock] = await modules;
  const runtime = await runtimeMock.createMockEnvironment({ manifests, providers: testProviders(), embed: async text => fakeEmbed(text), resolve: async () => ({ kind: 'answer', text: 'unused' }), threshold: 0.2 });
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

test('resolver supports ordinary answers and clarification, but cannot invent tool IDs', async () => {
  const answerRuntime = await environment(async () => ({ kind: 'answer', text: 'This is a local ordinary answer.' }));
  const answer = await answerRuntime.intelligence.handle('Find my morning alarm');
  assert.equal(answer.kind, 'answer');
  const clarifyRuntime = await environment(async () => ({ kind: 'clarification', question: 'Which date do you mean?' }));
  const clarification = await clarifyRuntime.intelligence.handle('Find my morning alarm');
  assert.equal(clarification.kind, 'clarification');
  const invalidRuntime = await environment(async () => ({ kind: 'tool', toolId: 'remote.run', arguments: {} }));
  await assert.rejects(invalidRuntime.intelligence.handle('Find my morning alarm'), /unregistered or unretrieved tool/);
});

test('side effects require confirmation, and invalid or unknown calls are rejected', async () => {
  const runtime = await environment();
  const pending = await runtime.intelligence.handle('Create a flashcard about photosynthesis.');
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
