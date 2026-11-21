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
  import('../src/intelligence/retrieval/providerData.js'),
  import('../src/intelligence/argumentNormalization.js'),
  import('../src/intelligence/executionPlan.js'),
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
    if (toolId === 'calendar.find_events') {
      const source = [
        { id: 'event-lunch', title: 'Lunch break', start: '2026-11-15T08:00:00+02:00', end: '2026-11-15T08:30:00+02:00' },
        { id: 'event-meeting', title: 'Project sync meeting', start: '2026-11-15T10:00:00+02:00', end: '2026-11-15T10:30:00+02:00' },
        { id: 'event-dentist', title: 'Dentist appointment', start: '2026-11-14T09:30:00+02:00', end: '2026-11-14T10:00:00+02:00' },
      ];
      const events = source.filter(event => {
        const start = new Date(event.start);
        return (!args.date || event.start.startsWith(args.date))
          && (!args.start_datetime || start >= new Date(args.start_datetime))
          && (!args.end_datetime || start < new Date(args.end_datetime))
          && (!args.event_type || (args.event_type === 'meeting' && /meeting|sync|review|planning/i.test(event.title))
            || (args.event_type === 'appointment' && /appointment|dentist/i.test(event.title)))
          && (!args.query || event.title.toLowerCase().includes(args.query.toLowerCase()));
      }).sort((left, right) => left.start.localeCompare(right.start));
      return {
        document: sampleDocument(id, 'Calendar events', events[0]?.title ?? 'No matching events', events.length ? 'ready' : 'empty'),
        data: { events, firstEvent: events[0] },
      };
    }
    if (toolId === 'alarm.create') {
      const time = new Date(args.time);
      time.setMinutes(time.getMinutes() + (args.offsetMinutes ?? 0));
      return sampleDocument(id, 'Alarm created', `${args.label} ${time.toISOString()}`, 'success');
    }
    if (toolId === 'web.search') return sampleDocument(id, 'Web results', 'Mock result', 'ready', [{ id: 'image', mimeType: 'image/svg+xml', alt: 'Illustration' }]);
    if (toolId === 'anki.search_cards' && args.query === 'not-a-card') return sampleDocument(id, 'Anki cards', 'No results', 'empty');
    if (args.query === 'mock-error') return sampleDocument(id, 'Mock error', 'Simulated error', 'error');
    return sampleDocument(id, toolId, toolId === 'anki.search_cards' ? 'Chloroplasts capture light energy.' : JSON.stringify(args), toolId.endsWith('.create_card') ? 'success' : 'ready');
  }, ...(id === 'calendar' ? { contextSearch: { recordTypes: ['events'], fields: ['title', 'start'] } } : {}) }));
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

function localTestDatabase(registryData) {
  const embeddings = new Map();
  const { EMBEDDING_CACHE_VERSION } = require('../src/intelligence/embeddingModel.js');
  return {
    async getRegistryData() { return registryData; },
    async getCachedEmbedding(text, model) { return embeddings.get(`${model}\0${text}`); },
    async cacheEmbedding(text, model, dimensions, vector) {
      embeddings.set(`${model}\0${text}`, { model, version: EMBEDDING_CACHE_VERSION, dimensions, vector });
    },
    async getRecords(providerId, recordType) { return registryData.data?.[providerId]?.[recordType] ?? []; },
    async getRecord(providerId, recordType, recordId) {
      return (await this.getRecords(providerId, recordType)).find(record => record.id === recordId);
    },
    async putRecord(providerId, recordType, record) {
      const records = registryData.data[providerId][recordType];
      const index = records.findIndex(item => item.id === record.id);
      if (index < 0) records.push(record);
      else records[index] = record;
    },
    async deleteRecord(providerId, recordType, recordId) {
      registryData.data[providerId][recordType] = (registryData.data[providerId][recordType] ?? []).filter(record => record.id !== recordId);
    },
    async getAssets() { return registryData.data?.web?.assets ?? []; },
    async nextId(providerId, recordType, prefix) {
      const records = await this.getRecords(providerId, recordType);
      return `${prefix}-${records.length + 1}`;
    },
    async executeRegisteredTool(_tool, _provider, _args, _context, execute) { return execute(); },
  };
}

async function environment(options = {}) {
  const [, , , mock] = await modules;
  return mock.createMockEnvironment({
    manifests, providers: testProviders(), embed: options.embed ?? (async text => fakeEmbed(text)),
    searchTools: options.searchTools, searchProviderData: options.searchProviderData, rerankTools: options.rerankTools,
    normalizeArguments: options.normalizeArguments, argumentNormalizerEnabled: options.argumentNormalizerEnabled, initialState: options.initialState,
    threshold: options.threshold ?? 0.2, ambiguityMargin: options.ambiguityMargin ?? 0.02,
  });
}

test('Cue Display Document fixtures satisfy the v1 contract', async () => {
  const [display] = await modules;
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'display', 'schema', 'cue-display-v1.schema.json'), 'utf8'));
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  for (const fixture of fixtures) assert.deepEqual(display.validateDisplayDocument(fixture), { valid: true, errors: [] });
  assert.equal(display.validateDisplayDocument(display.createDisplayDocument({
    id: 'clarification-test',
    title: 'Clarification needed',
    source: { app: 'cue', name: 'Cue' },
    state: 'clarification_required',
  })).valid, true);
});

test('display message is not repeated when a text element already shows it', async () => {
  const [display] = await modules;
  const duplicate = display.createDisplayDocument({
    id: 'duplicate-message',
    title: 'Result',
    source: { app: 'cue', name: 'Cue' },
    message: 'Request completed.',
    elements: [{ type: 'container', layout: 'column', children: [{ type: 'text', text: 'Request completed.' }] }],
  });
  assert.equal(display.hasMessageElement(duplicate), true);

  const distinct = display.createDisplayDocument({
    id: 'distinct-message',
    title: 'Result',
    source: { app: 'cue', name: 'Cue' },
    message: 'Summary',
    elements: [{ type: 'text', text: 'Details' }],
  });
  assert.equal(display.hasMessageElement(distinct), false);
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
  const choiceDocument = display.createDisplayDocument({
    id: 'tool-choice',
    title: 'Choose a tool',
    source: { app: 'cue', name: 'Cue' },
    state: 'clarification_required',
    actions: [{ id: 'choice-1', kind: 'interaction_option', interactionId: 'conversation:awaiting_tool_choice:0', optionId: 'calendar.find_events', label: 'Find calendar events' }],
    elements: [{ type: 'action', actionId: 'choice-1', label: 'Find calendar events' }],
  });
  assert.equal(display.validateDisplayDocument(choiceDocument, { registry: runtime.registry }).valid, true);
  choiceDocument.actions[0].optionId = 'unregistered.fake';
  assert.equal(display.validateDisplayDocument(choiceDocument, { registry: runtime.registry }).valid, true, 'interaction options are validated against the pending interaction, not the tool registry');
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

test('provider-data indexes are provider-owned, namespaced, and do not mix sessions or tool examples', async () => {
  const [, , , , , , providerData] = await modules;
  const index = await providerData.buildProviderDataIndex({
    providers: [{ id: 'calendar', status: 'available', manifest: { contextSearch: { recordTypes: ['events'], fields: ['title'] } } }],
    data: { calendar: { events: [{ id: 'event-1', title: 'Project review' }], toolExamples: [{ id: 'example-1', text: 'search calendar' }] } },
    embed: async text => ({ vector: text === 'Project review' ? [1, 0] : [0, 1], dimensions: 2 }),
    dimensions: 2,
  });
  assert.equal(index.length, 1);
  assert.equal(index[0].namespace, 'provider-data');
  const hits = providerData.searchProviderData([1, 0], index, { providerIds: ['calendar'], threshold: 0.2 });
  assert.equal(hits.calendar.hits[0].record.id, 'event-1');
  assert.deepEqual(providerData.searchProviderData([1, 0], index, { providerIds: ['anki'] }), {});
});

test('database environment caches browser embeddings and searches local provider data', async () => {
  const tool = manifests.find(item => item.id === 'anki.create_card');
  const registryData = {
    providers: [{ id: 'anki', status: 'available', manifest: { permissions: [], contextSearch: { recordTypes: ['cards'], fields: ['front', 'back', 'tags'] } } }],
    tools: [tool],
    data: { anki: { cards: [{ id: 'card-1', front: 'What is photosynthesis?', back: 'Plants convert light into chemical energy.', tags: ['biology'] }] } },
    toolRetrievalConfig: { minimumScore: 0.2, plausibleScore: 0.1 },
  };
  const database = localTestDatabase(registryData);
  const { createDatabaseEnvironment } = await import('../src/demo/databaseEnvironment.js');
  const runtime = await createDatabaseEnvironment({
    database,
    registryData,
    embed: async () => ({ vector: Array(384).fill(1 / Math.sqrt(384)), dimensions: 384 }),
  });
  const outcome = await runtime.intelligence.handle('Create a flashcard about photosynthesis');
  assert.equal(outcome.kind, 'clarification');
  assert.equal(outcome.retrieval.providerEvidence.hits[0].record.id, 'card-1');
  assert.equal(runtime.providerDataIndex[0].providerId, 'anki');
  assert.equal(runtime.providerDataIndex[0].vector.length, 384);
  assert.match(runtime.providerDataIndex[0].contentHash, /^[a-f0-9]{64}$/);
  assert.ok((await database.getCachedEmbedding('What is photosynthesis?\nPlants convert light into chemical energy.\nbiology', 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2')).vector.length === 384);
});

test('hosted planning can defer retrieval indexing until a local mode needs it', async () => {
  const tool = manifests.find(item => item.id === 'anki.create_card');
  const registryData = {
    providers: [{ id: 'anki', status: 'available', manifest: { permissions: [], contextSearch: { recordTypes: ['cards'], fields: ['front'] } } }],
    tools: [tool],
    data: { anki: { cards: [{ id: 'card-1', front: 'Photosynthesis' }] } },
  };
  let embeddings = 0;
  const { createDatabaseEnvironment } = await import('../src/demo/databaseEnvironment.js');
  const runtime = await createDatabaseEnvironment({
    database: localTestDatabase(registryData),
    registryData,
    initializeRetrieval: false,
    embed: async () => { embeddings++; return { vector: Array(384).fill(1 / Math.sqrt(384)), dimensions: 384 }; },
  });
  assert.ok(runtime.registry.get(tool.id));
  assert.equal(embeddings, 0);
  assert.equal(runtime.exampleIndex.length, 0);
  await Promise.all([runtime.ensureRetrieval(), runtime.ensureRetrieval()]);
  assert.ok(embeddings > 0);
  assert.ok(runtime.exampleIndex.length > 0);
  assert.equal(runtime.providerDataIndex.length, 1);
  const count = embeddings;
  await runtime.ensureRetrieval();
  assert.equal(embeddings, count);
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

test('cross-encoder reranks only uncertain MiniLM results and requires a decisive margin', async () => {
  const candidates = [
    { toolId: 'calendar.find_events', score: 0.71, margin: 0.01 },
    { toolId: 'calendar.create_event', score: 0.70 },
  ];
  let calls = 0;
  const confident = await environment({
    threshold: 0.5,
    ambiguityMargin: 0.05,
    searchTools: async () => [{ toolId: 'calendar.find_events', score: 0.9 }, { toolId: 'calendar.create_event', score: 0.7 }],
    rerankTools: async () => { calls++; return []; },
  });
  assert.equal((await confident.intelligence.retrieve('Find a meeting')).kind, 'selected');
  assert.equal(calls, 0);

  const reranked = await environment({
    threshold: 0.5,
    ambiguityMargin: 0.05,
    rerankTools: async (_query, inputs) => {
      calls++;
      assert.equal(inputs.length, 2);
      assert.ok(inputs.every(input => input.text.length > 20));
      return [{ toolId: 'calendar.find_events', score: 0.88 }, { toolId: 'calendar.create_event', score: 0.34 }];
    },
    searchTools: async () => candidates,
  });
  const selected = await reranked.intelligence.retrieve('Find my meeting');
  assert.equal(selected.kind, 'selected');
  assert.equal(selected.definition.id, 'calendar.find_events');
  assert.equal(selected.retrieval.crossEncoderScore, 0.88);
  assert.equal(calls, 1);

  const uncertain = await environment({
    threshold: 0.5,
    ambiguityMargin: 0.05,
    rerankTools: async () => [{ toolId: 'calendar.find_events', score: 0.7 }, { toolId: 'calendar.create_event', score: 0.67 }],
    searchTools: async () => candidates,
  });
  const uncertainResult = await uncertain.intelligence.retrieve('Calendar request');
  assert.equal(uncertainResult.kind, 'ambiguous');
  assert.deepEqual(uncertainResult.diagnostics.candidates.map(item => item.score), [0.7, 0.67]);

  const lowScore = await environment({
    threshold: 0.5,
    ambiguityMargin: 0.05,
    rerankTools: async () => [{ toolId: 'calendar.find_events', score: 0.19 }, { toolId: 'calendar.create_event', score: 0.01 }],
    searchTools: async () => candidates,
  });
  assert.equal((await lowScore.intelligence.retrieve('Calendar request')).kind, 'ambiguous');

  const unavailable = await environment({
    threshold: 0.5,
    ambiguityMargin: 0.05,
    rerankTools: async () => { throw new Error('wasm download failure'); },
    searchTools: async () => candidates,
  });
  const failedResult = await unavailable.intelligence.retrieve('Calendar request');
  assert.equal(failedResult.kind, 'ambiguous');
  assert.equal(failedResult.diagnostics.error, 'wasm download failure');
});

test('configured cross-encoder thresholds select the decisive calendar result without fallback', async () => {
  const { createDatabaseEnvironment } = await import('../src/demo/databaseEnvironment.js');
  const ids = ['calendar.find_events', 'calendar.create_event', 'calendar.update_event', 'calendar.get_event'];
  const scores = [0.581, 0.016, 0.010, 0.004];
  const decisions = [];
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'seed', 'tool-retrieval-config.json'), 'utf8'));
  const registryData = {
    providers: [{ id: 'calendar', status: 'available', manifest: { permissions: [], contextSearch: { recordTypes: ['events'], fields: ['title', 'start'] } } }],
    tools: ids.map(id => manifests.find(tool => tool.id === id)),
    data: { calendar: { events: [] } },
    toolRetrievalConfig: config,
  };
  const database = localTestDatabase(registryData);
  const runtime = await createDatabaseEnvironment({
    database,
    registryData,
    embed: async () => ({ vector: Array(384).fill(1 / Math.sqrt(384)), dimensions: 384 }),
    rerankTools: async () => ids.map((toolId, index) => ({ toolId, score: scores[index] })).reverse(),
    onRerankDecision: decision => decisions.push(decision),
  });
  const outcome = await runtime.intelligence.handle('What events do I have tomorrow?', {
    context: { now: new Date('2026-11-15T12:00:00Z'), timeZone: 'UTC', locale: 'en' },
  });
  assert.equal(outcome.kind, 'document');
  assert.equal(outcome.state.status, 'completed');
  assert.equal(outcome.retrieval.toolId, 'calendar.find_events');
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].topScore, 0.581);
  assert.equal(decisions[0].secondScore, 0.016);
  assert.ok(Math.abs(decisions[0].margin - 0.565) < 1e-12);
  assert.equal(decisions[0].minimumScore, 0.20);
  assert.equal(decisions[0].minimumMargin, 0.10);
  assert.equal(decisions[0].scorePassed, true);
  assert.equal(decisions[0].marginPassed, true);
  assert.equal(decisions[0].decision, 'selected');
});

test('cross-encoder applies score and margin boundaries including one candidate', async () => {
  const runtime = await environment({ threshold: 0.7 });
  runtime.intelligence.plausibleThreshold = 0.3;
  for (const [scores, expected, scorePassed, marginPassed] of [
    [[0.199, 0.01], 'ambiguous', false, true],
    [[0.20, 0.10], 'selected', true, true],
    [[0.30, 0.20], 'selected', true, true],
    [[0.20, 0.101], 'ambiguous', true, false],
    [[0.20], 'selected', true, true],
    [[0.199], 'ambiguous', false, true],
  ]) {
    const ids = ['calendar.find_events', 'calendar.create_event'].slice(0, scores.length);
    runtime.intelligence.searchTools = async () => ids.map(toolId => ({ toolId, score: 0.6 }));
    runtime.intelligence.rerankTools = async () => ids.map((toolId, index) => ({ toolId, score: scores[index] }));
    const result = await runtime.intelligence.retrieve('Calendar request');
    assert.equal(result.kind, expected, `scores ${scores.join(', ')}`);
    const decision = expected === 'selected' ? result.retrieval.rerankDiagnostics : result.diagnostics;
    assert.equal(decision.scorePassed, scorePassed);
    assert.equal(decision.marginPassed, marginPassed);
    if (scores.length === 1) {
      assert.equal(decision.secondScore, null);
      assert.equal(decision.margin, null);
    }
  }
});

test('cross-encoder logits map monotonically to bounded routing scores', async () => {
  const { crossEncoderScoreFromLogit } = await import('../src/intelligence/retrieval/crossEncoderScore.js');
  const lower = crossEncoderScoreFromLogit(-2);
  const neutral = crossEncoderScoreFromLogit(0);
  const higher = crossEncoderScoreFromLogit(2);
  assert.ok(lower >= 0 && lower < neutral && neutral < higher && higher <= 1);
  assert.equal(neutral, 0.5);
  assert.equal(higher, 1 / (1 + Math.exp(-2)));
  assert.throws(() => crossEncoderScoreFromLogit(Number.NaN), /must be finite/);
});

async function crossEncoderWorker({ gpu = true, loadError, inferenceError } = {}) {
  const vm = require('node:vm');
  const ts = require('typescript');
  const { crossEncoderScoreFromLogit } = await import('../src/intelligence/retrieval/crossEncoderScore.js');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'model.worker.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const messages = [];
  const loads = [];
  const runs = [];
  const disposals = [];
  const self = {};
  const pipeline = async (_task, _modelId, options) => {
    loads.push({ device: options.device, dtype: options.dtype });
    options.progress_callback({ status: 'progress', file: 'onnx/model_quantized.onnx', progress: 50 });
    if (loadError?.[options.device]) throw new Error(loadError[options.device]);
    const model = async () => {
      runs.push(options.device);
      if (inferenceError?.[options.device]) throw new Error(inferenceError[options.device]);
      return { logits: { data: [1] } };
    };
    model.dispose = async () => { disposals.push(options.device); };
    return { tokenizer: () => ({}), model };
  };
  const context = {
    exports: {}, self, Error,
    navigator: gpu ? { gpu: { requestAdapter: async () => ({}) } } : {},
    postMessage: message => messages.push(message),
    require: name => {
      if (name === '@huggingface/transformers') return { pipeline, env: {} };
      if (name === './asrModels') return { ASR_MODELS: {} };
      if (name.endsWith('crossEncoderScore.js')) return { crossEncoderScoreFromLogit };
      if (name.endsWith('embeddingModel.js')) return { EMBEDDING_TOKENIZER: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2' };
      throw new Error(`Unexpected import: ${name}`);
    },
  };
  vm.runInNewContext(compiled, context);
  const send = async (id = 1) => self.onmessage({ data: { id, stage: 'rerank', text: 'query', candidates: [{ toolId: 'a', text: 'candidate' }, { toolId: 'b', text: 'candidate' }] } });
  return { send, messages, loads, runs, disposals };
}

test('embedding worker loads the quantized model', async () => {
  const vm = require('node:vm');
  const ts = require('typescript');
  const { crossEncoderScoreFromLogit } = await import('../src/intelligence/retrieval/crossEncoderScore.js');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'model.worker.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const messages = [];
  let dtype;
  let revision;
  const self = {};
  const pipeline = async (_task, _modelId, options) => {
    dtype = options.dtype;
    revision = options.revision;
    return async () => ({ data: Float32Array.of(0.25), dims: [1, 1] });
  };
  const context = {
    exports: {}, self, Error,
    postMessage: message => messages.push(message),
    require: name => {
      if (name === '@huggingface/transformers') return { pipeline, env: {} };
      if (name === './asrModels') return { ASR_MODELS: {} };
      if (name.endsWith('crossEncoderScore.js')) return { crossEncoderScoreFromLogit };
      if (name.endsWith('embeddingModel.js')) return { EMBEDDING_TOKENIZER: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', EMBEDDING_REVISION: 'pinned-revision' };
      throw new Error(`Unexpected import: ${name}`);
    },
  };
  vm.runInNewContext(compiled, context);
  await self.onmessage({ data: { id: 1, stage: 'embed', text: 'query' } });
  assert.equal(dtype, 'q8');
  assert.equal(revision, 'pinned-revision');
  assert.deepEqual(Array.from(messages.find(message => message.status === 'complete').result.vector), [0.25]);
});

async function whisperWorker({ gpu = true, loadError = {}, inferenceError = {} } = {}) {
  const vm = require('node:vm');
  const ts = require('typescript');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'model.worker.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const messages = [], loads = [], runs = [], disposals = [];
  const self = {};
  const pipeline = async (task, modelId, options) => {
    loads.push({ task, modelId, device: options.device, dtype: options.dtype });
    if (loadError[options.device]) throw new Error(loadError[options.device]);
    const instance = async (audio, settings) => {
      runs.push({ device: options.device, audio: Array.from(audio), settings });
      if (inferenceError[options.device]) throw new Error(inferenceError[options.device]);
      return { text: 'recognized speech' };
    };
    instance.dispose = async () => { disposals.push(options.device); };
    return instance;
  };
  vm.runInNewContext(compiled, {
    exports: {}, self, Error, Float32Array,
    navigator: gpu ? { gpu: { requestAdapter: async () => ({}) } } : {},
    postMessage: message => messages.push(message),
    require: name => {
      if (name === '@huggingface/transformers') return { pipeline, env: {} };
      if (name === './asrModels') return { ASR_MODELS: { tiny: { modelId: 'whisper-tiny' }, base: { modelId: 'whisper-base' } } };
      if (name.endsWith('crossEncoderScore.js')) return {};
      if (name.endsWith('embeddingModel.js')) return {};
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  const send = async (id = 1, asrModel = 'tiny') => self.onmessage({
    data: { id, stage: 'transcribe', asrModel, audio: Float32Array.of(0.1, 0.2), sampleRate: 16000 },
  });
  return { send, messages, loads, runs, disposals };
}

test('Whisper uses WebGPU when available and reuses the loaded model', async () => {
  const worker = await whisperWorker();
  await worker.send();
  await worker.send(2);
  assert.deepEqual(worker.loads, [{ task: 'automatic-speech-recognition', modelId: 'whisper-tiny', device: 'webgpu', dtype: 'q4' }]);
  assert.equal(worker.runs.length, 2);
  assert.equal(worker.messages.filter(message => message.status === 'complete').length, 2);
  assert.equal(worker.messages.find(message => message.status === 'complete').result, 'recognized speech');
});

test('Whisper falls back to CPU when WebGPU is unavailable or fails', async () => {
  for (const [options, expectedLoads] of [
    [{ gpu: false }, ['wasm']],
    [{ loadError: { webgpu: 'GPU initialization failed' } }, ['webgpu', 'wasm']],
    [{ inferenceError: { webgpu: 'GPU device lost' } }, ['webgpu', 'wasm']],
  ]) {
    const worker = await whisperWorker(options);
    await worker.send();
    await worker.send(2);
    assert.deepEqual(worker.loads.map(load => load.device), expectedLoads);
    assert.equal(worker.loads.at(-1).dtype, 'q8');
    assert.equal(worker.messages.filter(message => message.status === 'complete').length, 2);
    assert.ok(worker.messages.some(message => message.status === 'notice' && /WASM/.test(message.message)));
    if (options.inferenceError) assert.deepEqual(worker.disposals, ['webgpu']);
  }
});

test('Whisper preserves the selected model and surfaces CPU failures', async () => {
  const worker = await whisperWorker({ gpu: false });
  await worker.send();
  await worker.send(2, 'base');
  assert.deepEqual(worker.loads.map(load => load.modelId), ['whisper-tiny', 'whisper-base']);
  for (const options of [
    { gpu: false, loadError: { wasm: 'Failed to fetch model' } },
    { gpu: false, inferenceError: { wasm: 'CPU inference failed' } },
  ]) {
    const failed = await whisperWorker(options);
    await failed.send();
    assert.match(failed.messages.find(message => message.status === 'error').error, /Whisper wasm .*Failed|Whisper wasm .*failed/);
    assert.equal(failed.messages.some(message => message.status === 'complete'), false);
  }
});

test('cross-encoder lazily loads q8 on WebGPU and reports progress and success', async () => {
  const worker = await crossEncoderWorker();
  assert.equal(worker.loads.length, 0);
  await worker.send();
  await worker.send(2);
  assert.deepEqual(worker.loads, [{ device: 'webgpu', dtype: 'q8' }]);
  assert.equal(worker.runs.length, 4);
  assert.ok(worker.messages.some(message => /loading started \(webgpu/.test(message.message) && message.statusOnly));
  assert.ok(worker.messages.some(message => /download progress.*model_quantized\.onnx 50%/.test(message.message) && message.statusOnly));
  assert.ok(worker.messages.some(message => /loading completed \(webgpu\)/.test(message.message) && message.statusOnly));
  assert.ok(worker.messages.some(message => /reranking succeeded \(webgpu/.test(message.message) && !message.statusOnly));
  assert.equal(worker.messages.filter(message => message.status === 'complete').length, 2);
  assert.equal(worker.messages.find(message => message.status === 'complete').result[0].score, 1 / (1 + Math.exp(-1)));
});

test('cross-encoder falls back to WASM on unavailable GPU, initialization and inference failure', async () => {
  const noGpu = await crossEncoderWorker({ gpu: false });
  await noGpu.send();
  assert.deepEqual(noGpu.loads, [{ device: 'wasm', dtype: 'q8' }]);
  const loadFailure = await crossEncoderWorker({ loadError: { webgpu: 'Unsupported operator' } });
  await loadFailure.send();
  assert.deepEqual(loadFailure.loads.map(load => load.device), ['webgpu', 'wasm']);
  assert.ok(loadFailure.messages.some(message => /webgpu loading error.*retrying with WASM/.test(message.message)));
  const inferenceFailure = await crossEncoderWorker({ inferenceError: { webgpu: 'GPU device lost' } });
  await inferenceFailure.send();
  await inferenceFailure.send(2);
  assert.deepEqual(inferenceFailure.loads.map(load => load.device), ['webgpu', 'wasm']);
  assert.deepEqual(inferenceFailure.runs, ['webgpu', 'wasm', 'wasm', 'wasm', 'wasm']);
  assert.deepEqual(inferenceFailure.disposals, ['webgpu']);
  assert.ok(inferenceFailure.messages.some(message => /WebGPU inference error.*retrying with WASM/.test(message.message)));
});

test('cross-encoder reports download, loading and inference timeouts or failures', async () => {
  for (const [options, expected] of [
    [{ loadError: { wasm: 'Failed to fetch model' } }, /download failure/],
    [{ loadError: { wasm: 'Invalid ONNX graph' } }, /loading error/],
    [{ loadError: { wasm: 'request timed out' } }, /loading timeout/],
    [{ inferenceError: { wasm: 'inference timed out' } }, /inference timeout/],
    [{ inferenceError: { wasm: 'bad logits' } }, /inference error/],
  ]) {
    const worker = await crossEncoderWorker({ gpu: false, ...options });
    await worker.send();
    assert.match(worker.messages.find(message => message.status === 'error').error, expected);
    assert.ok(worker.messages.some(message => /Cross-encoder failed:/.test(message.message)));
  }
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
  assert.doesNotMatch(worker, /text-generation|resolve/i);
  const search = await runtime.intelligence.handle('Search my Anki cards about chloroplasts');
  assert.equal(search.kind, 'document');
  const clarification = await runtime.intelligence.handle('Create a flashcard about photosynthesis');
  assert.equal(clarification.kind, 'clarification');
  assert.deepEqual(clarification.resolution.missing, ['front', 'back']);
  const continued = await runtime.intelligence.handle('front: What is photosynthesis? back: Plants convert light into chemical energy.');
  assert.equal(continued.kind, 'confirmation_required');
  assert.equal(continued.pendingCall.toolId, 'anki.create_card');
  assert.deepEqual(continued.pendingCall.arguments, { front: 'What is photosynthesis?', back: 'Plants convert light into chemical energy.' });
});

test('request-level routing escalates multi-step, collection, and implicit-context intents but keeps simple requests local', async () => {
  const { requiresExternalPlanning } = await import('../src/intelligence/toolIntelligence.js');
  assert.equal(requiresExternalPlanning('Set an alarm for 7:00 tomorrow'), undefined);
  assert.equal(requiresExternalPlanning('Find my first meeting today and set an alarm 15 minutes beforehand'), 'multiple dependent actions');
  assert.equal(requiresExternalPlanning('What events do I have today? Create an alarm at the start time of each event'), 'collection iteration');
  assert.equal(requiresExternalPlanning('Set an alarm before the garden work tomorrow'), 'implicit event context');
});

test('clarification restart recognizes explicit corrections without consuming normal replies', async () => {
  const { clarificationRestart, clarificationHasCompletedSideEffects } = await import('../src/intelligence/toolIntelligence.js');
  assert.equal(clarificationRestart('No, I meant search my Anki cards for plants'), 'search my Anki cards for plants');
  assert.equal(clarificationRestart('go back'), '');
  assert.equal(clarificationRestart('start over'), '');
  assert.equal(clarificationRestart('no'), undefined);
  assert.equal(clarificationRestart('No, the answer is plants'), undefined);
  assert.equal(clarificationHasCompletedSideEffects({ seenSideEffects: ['done'] }), true);
  assert.equal(clarificationHasCompletedSideEffects({ executionState: { executedSideEffects: ['done'] } }), true);
  assert.equal(clarificationHasCompletedSideEffects({ completedOperations: [{}] }), false);

  const runtime = await environment();
  const first = await runtime.intelligence.handle('Create a flashcard about photosynthesis');
  assert.equal(first.state.status, 'awaiting_argument');
  runtime.intelligence.cancelPendingOperation();
  const corrected = await runtime.intelligence.handle(clarificationRestart('No, I meant search my Anki cards about photosynthesis'));
  assert.equal(corrected.kind, 'document');
  assert.equal(corrected.results[0].toolId, 'anki.search_cards');
  assert.notEqual(corrected.state.conversationId, first.state.conversationId);
});

test('clarification survives runtime reconstruction and short choices resume the original request', async () => {
  const toolChoiceRuntime = await environment({
    searchTools: async () => [
      { toolId: 'knowledge.search', score: 0.7, bestDescriptionSimilarity: 0.7, bestKeywordSimilarity: 0.7, bestExampleSimilarity: 0.7, margin: 0.01 },
      { toolId: 'anki.search_cards', score: 0.69, bestDescriptionSimilarity: 0.69, bestKeywordSimilarity: 0.69, bestExampleSimilarity: 0.69 },
    ],
  });
  const question = await toolChoiceRuntime.intelligence.handle('Search my local knowledge base for bananas');
  assert.equal(question.state.status, 'awaiting_tool_choice');
  const restored = await environment({ initialState: question.state, searchTools: async () => { throw new Error('Tool retrieval must not run for a choice response'); } });
  const ambiguousYes = await restored.intelligence.handle('yes');
  assert.equal(ambiguousYes.state.status, 'awaiting_tool_choice');
  const answer = await restored.intelligence.handle('Knowledge search');
  assert.equal(answer.kind, 'document');
  assert.equal(answer.results[0].toolId, 'knowledge.search');
  assert.equal(answer.results[0].arguments.query, 'bananas');

  const choiceWithArguments = await environment({
    searchTools: async () => [
      { toolId: 'knowledge.search', score: 0.7, bestDescriptionSimilarity: 0.7, bestKeywordSimilarity: 0.7, bestExampleSimilarity: 0.7, margin: 0.01 },
      { toolId: 'anki.search_cards', score: 0.69, bestDescriptionSimilarity: 0.69, bestKeywordSimilarity: 0.69, bestExampleSimilarity: 0.69 },
    ],
  });
  const secondQuestion = await choiceWithArguments.intelligence.handle('Search my local knowledge base for bananas');
  const secondAnswer = await choiceWithArguments.intelligence.handle('Knowledge search for pears');
  assert.equal(secondQuestion.state.status, 'awaiting_tool_choice');
  assert.equal(secondAnswer.kind, 'document');
  assert.equal(secondAnswer.results[0].arguments.query, 'pears');

  const argumentRuntime = await environment();
  const argumentQuestion = await argumentRuntime.intelligence.handle('Create a flashcard about photosynthesis');
  const argumentRestored = await environment({ initialState: argumentQuestion.state });
  const confirmation = await argumentRestored.intelligence.handle('front: What is photosynthesis? back: Plants convert light into chemical energy.');
  assert.equal(confirmation.kind, 'confirmation_required');
  assert.equal(confirmation.state.originalRequest, 'Create a flashcard about photosynthesis');
  const completed = await argumentRestored.intelligence.handle('yes', { confirmed: true });
  assert.equal(completed.kind, 'document');
});

test('calendar search resolves full local date ranges and Stage 2 evidence cannot override intent', async () => {
  const [, , , , argumentResolution] = await modules;
  const tool = manifests.find(item => item.id === 'calendar.find_events');
  const context = { now: new Date('2026-11-18T12:00:00Z'), timeZone: 'Europe/Helsinki', locale: 'en-US' };
  const week = argumentResolution.resolveArguments({ request: 'What events do I have this week?', tool, context });
  assert.equal(week.arguments.start_datetime, '2026-11-16T00:00:00+02:00');
  assert.equal(week.arguments.end_datetime, '2026-11-23T00:00:00+02:00');
  const tomorrow = argumentResolution.resolveArguments({ request: 'What events do I have tomorrow?', tool, context });
  assert.equal(tomorrow.arguments.start_datetime, '2026-11-19T00:00:00+02:00');
  assert.equal(tomorrow.arguments.end_datetime, '2026-11-20T00:00:00+02:00');

  const runtime = await environment({
    searchTools: async () => [
      { toolId: 'calendar.find_events', score: 0.9, bestDescriptionSimilarity: 0.9, bestKeywordSimilarity: 0.9, bestExampleSimilarity: 0.9, margin: 0.2 },
      { toolId: 'calendar.update_event', score: 0.7, bestDescriptionSimilarity: 0.7, bestKeywordSimilarity: 0.7, bestExampleSimilarity: 0.7 },
    ],
    searchProviderData: async () => ({ calendar: { namespace: 'provider-data', indexedAt: '2026-11-18T12:00:00.000Z', hits: [{ record: { id: 'event-1', title: 'Matching event' }, similarity: 0.99 }] } }),
  });
  const result = await runtime.intelligence.handle('What events do I have tomorrow?', { context });
  assert.equal(result.kind, 'document');
  assert.equal(result.results[0].toolId, 'calendar.find_events');
  assert.equal(result.retrieval.providerEvidence.hits[0].record.id, 'event-1');
});

test('calendar weeks start on Monday even if an old Sunday preference is supplied', async () => {
  const [, , , , argumentResolution] = await modules;
  const tool = manifests.find(item => item.id === 'calendar.find_events');
  for (const [now, request, start, end] of [
    ['2026-11-22T12:00:00Z', 'this week', '2026-11-16T00:00:00+02:00', '2026-11-23T00:00:00+02:00'],
    ['2026-11-22T12:00:00Z', 'next week', '2026-11-23T00:00:00+02:00', '2026-11-30T00:00:00+02:00'],
    ['2026-11-23T12:00:00Z', 'next week', '2026-11-30T00:00:00+02:00', '2026-12-07T00:00:00+02:00'],
  ]) {
    const result = argumentResolution.resolveArguments({
      request: `What events do I have ${request}?`, tool,
      context: { now: new Date(now), timeZone: 'Europe/Helsinki', locale: 'en-US', weekStartsOn: 0 },
    });
    assert.equal(result.arguments.start_datetime, start);
    assert.equal(result.arguments.end_datetime, end);
  }
});

test('argument normalization is conditional, schema-checked, retried once, and never selects tools', async () => {
  const [, , , , , , , normalization] = await modules;
  const tool = manifests.find(item => item.id === 'anki.create_card');
  const source = { originalRequest: 'Create a flashcard about photosynthesis', request: 'Create a flashcard about photosynthesis', tool, deterministicArguments: {}, missing: ['front', 'back'], ambiguous: [], timeZone: 'Europe/Helsinki', currentDate: '2026-11-14T12:00:00+02:00' };
  assert.equal(normalization.shouldNormalizeArguments({ ...source, resolution: { complete: false } }), true);
  assert.equal(normalization.shouldNormalizeArguments({ ...source, request: 'front: Q? back: A.', resolution: { complete: true } }), false);
  const prompts = [];
  const normalized = await normalization.normalizeArgumentsWithModel(source, {
    generate: async prompt => {
      prompts.push(prompt);
      if (prompts.length === 1) return 'not json';
      return JSON.stringify({
        status: 'resolved',
        arguments: { front: 'What is photosynthesis?', back: 'Plants convert light into chemical energy.' },
        missing: [],
        ambiguous: [],
        provenance: { front: 'model_generated', back: 'model_generated' },
      });
    },
  });
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /Minimize internal reasoning/);
  assert.match(prompts[0], /Return the required JSON directly/);
  assert.match(prompts[0], /selected tool/);
  assert.match(prompts[0], /generate concise front\/back content/);
  assert.match(prompts[0], /Never invent user-specific facts/);
  assert.match(prompts[0], /anki\.create_card/);
  assert.match(prompts[0], /question_text/);
  assert.doesNotMatch(prompts[0], /acceptedSources/);
  assert.deepEqual(normalized.arguments, { front: 'What is photosynthesis?', back: 'Plants convert light into chemical energy.' });
  assert.throws(() => normalization.validateNormalizedResponse(JSON.stringify({
    status: 'resolved', arguments: { toolId: 'alarm.create' }, missing: [], ambiguous: [], provenance: { toolId: 'model_extracted' },
  }), { tool }), /unsupported argument/);
  assert.throws(() => normalization.validateNormalizedResponse(JSON.stringify({
    status: 'resolved', arguments: { front: 'changed', back: 'A.' }, missing: [], ambiguous: [], provenance: { front: 'model_extracted', back: 'model_extracted' },
  }), { tool, deterministicArguments: { front: { value: 'explicit?', source: 'current_user_request' } } }), /replace an explicit/);
  const calendarTool = manifests.find(item => item.id === 'calendar.create_event');
  assert.throws(() => normalization.validateNormalizedResponse(JSON.stringify({
    status: 'resolved',
    arguments: { title: 'Review', start: 'Friday at 2', end: '2026-11-20T15:00:00+02:00' },
    missing: [], ambiguous: [], provenance: { title: 'model_extracted', start: 'model_extracted', end: 'model_extracted' },
  }), { tool: calendarTool }), /explicit timezone|tool schema/);
});

test('model-assisted argument normalization is invoked only for suitable Anki generation requests', async () => {
  let calls = 0;
  const runtime = await environment({
    normalizeArguments: async () => {
      calls++;
      return JSON.stringify({
        status: 'resolved',
        arguments: { front: 'What is photosynthesis?', back: 'Plants convert light into chemical energy.' },
        missing: [],
        ambiguous: [],
        provenance: { front: 'model_generated', back: 'model_generated' },
      });
    },
  });
  const natural = await runtime.intelligence.handle('Create a flashcard about photosynthesis');
  assert.equal(natural.kind, 'confirmation_required', JSON.stringify(natural));
  assert.equal(calls, 1);
  assert.equal(natural.pendingCall.arguments.front, 'What is photosynthesis?');
  assert.equal(natural.resolution.fields.front.source, 'model_generated');
  const explicitRuntime = await environment({
    normalizeArguments: async () => { calls++; throw new Error('Deterministic parsing should skip model normalization'); },
  });
  const explicit = await explicitRuntime.intelligence.handle('Create a card with front: What is photosynthesis? back: Plants convert light into chemical energy.');
  assert.equal(explicit.kind, 'confirmation_required');
  assert.equal(calls, 1);

  const partialRuntime = await environment({
    normalizeArguments: async () => {
      calls++;
      return JSON.stringify({
        status: 'resolved',
        arguments: { back: 'Plants convert light into chemical energy.' },
        missing: [], ambiguous: [], provenance: { back: 'model_generated' },
      });
    },
  });
  const partial = await partialRuntime.intelligence.handle('Create an Anki card about plants and invent the answer. front: What is photosynthesis?');
  assert.equal(partial.kind, 'confirmation_required', JSON.stringify(partial));
  assert.equal(partial.pendingCall.arguments.front, 'What is photosynthesis?');
  assert.equal(partial.pendingCall.arguments.back, 'Plants convert light into chemical energy.');
  assert.equal(calls, 2);

  const disabledRuntime = await environment({
    argumentNormalizerEnabled: () => false,
    normalizeArguments: async () => { calls++; throw new Error('Disabled normalizer must not run'); },
  });
  const disabled = await disabledRuntime.intelligence.handle('Create a flashcard about photosynthesis');
  assert.equal(disabled.kind, 'clarification');
  assert.equal(calls, 2);
  assert.equal(disabled.normalizationError, undefined);
});

test('Anki clarification continues the original generation request after an incomplete model response', async () => {
  const prompts = [];
  const runtime = await environment({
    searchTools: async () => [{ toolId: 'anki.create_card', score: 0.9, bestDescriptionSimilarity: 0.9, bestKeywordSimilarity: 0.9, bestExampleSimilarity: 0.9, margin: 0.2 }],
    normalizeArguments: async prompt => {
      prompts.push(prompt);
      if (prompts.length === 1) throw new Error('OpenRouter returned an empty response after one retry.');
      return JSON.stringify({
        status: 'resolved',
        arguments: { front: 'What is photosynthesis?', back: 'Plants convert light into chemical energy.' },
        missing: [], ambiguous: [],
        provenance: { front: 'model_generated', back: 'model_generated' },
      });
    },
  });
  const first = await runtime.intelligence.handle('Create an Anki card about photosynthesis');
  assert.equal(first.kind, 'clarification');
  assert.equal(prompts.length, 1, JSON.stringify(first));
  assert.match(first.normalizationError, /empty/);
  assert.match(first.question, /couldn't automatically prepare/);
  const answer = 'Invent the front and back based on a logical basic question about photosynthesis';
  const continued = await runtime.intelligence.handle(answer);
  assert.equal(continued.kind, 'confirmation_required', JSON.stringify(continued));
  assert.equal(continued.pendingCall.arguments.front, 'What is photosynthesis?');
  assert.equal(continued.pendingCall.arguments.back, 'Plants convert light into chemical energy.');
  assert.match(prompts[1], /Create an Anki card about photosynthesis/);
  assert.ok(prompts[1].includes(answer));
  assert.equal(continued.normalizationError, undefined);
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
  const runtime = await environment({ embed: async text => ['Find my next dentist appointment', 'Find my first meeting tomorrow'].includes(text) ? isolatedVector(0) : ['set an alarm 30 minutes beforehand', 'Set an alarm for my first meeting', 'set an alarm 30 minutes beforehand'].includes(text) ? isolatedVector(1) : fakeEmbed(text) });
  const result = await runtime.intelligence.handle('Find my next dentist appointment and set an alarm 30 minutes beforehand');
  assert.equal(result.kind, 'confirmation_required', JSON.stringify(result));
  assert.equal(result.pendingCall.toolId, 'alarm.create');
  assert.equal(result.pendingCall.arguments.time, '2026-11-14T09:30:00+02:00');
  assert.equal(result.pendingCall.arguments.offsetMinutes, -30);
  assert.equal(result.completedOperations[0].toolId, 'calendar.find_events');
  assert.equal(result.state.executionPlan.schema, 'cue.execution-plan');
  assert.equal(result.state.executionPlan.status, 'waiting_for_confirmation');
  assert.equal(result.state.executionPlan.operations[0].status, 'succeeded');
  assert.equal(result.state.executionPlan.operations[1].status, 'waiting_for_confirmation');
  assert.deepEqual(result.state.executionPlan.operations[1].inputBindings, [{
    targetArgument: 'time',
    sourceOperation: result.state.executionPlan.operations[0].id,
    sourcePointer: '/firstEvent/start',
  }, {
    targetArgument: 'label',
    sourceOperation: result.state.executionPlan.operations[0].id,
    sourcePointer: '/firstEvent/title',
  }]);
});

test('multi-step clarification, confirmation correction, cancellation, and empty meeting results resume safely', async () => {
  const isolatedVector = index => { const vector = Array(384).fill(0); vector[index] = 1; return { vector, dimensions: 384 }; };
  const embed = async text => {
    if (['Find my first meeting tomorrow', 'Find my first meeting tomorrow and set an alarm 15 minutes beforehand'].includes(text)) return isolatedVector(0);
    if (['set an alarm 15 minutes beforehand', 'Set an alarm for my first meeting'].includes(text)) return isolatedVector(1);
    return fakeEmbed(text);
  };
  const context = { now: new Date('2026-11-14T08:00:00Z'), timeZone: 'Europe/Helsinki', locale: 'en-US' };
  const request = 'Find my first meeting tomorrow and set an alarm 15 minutes beforehand';

  const firstRuntime = await environment({ embed });
  const pending = await firstRuntime.intelligence.handle(request, { context });
  assert.equal(pending.kind, 'confirmation_required');
  assert.equal(pending.pendingCall.toolId, 'alarm.create');
  assert.equal(pending.pendingCall.arguments.time, '2026-11-15T10:00:00+02:00');
  assert.equal(pending.pendingCall.arguments.offsetMinutes, -15);
  assert.equal(pending.completedOperations[0].data.firstEvent.id, 'event-meeting');
  const changed = await firstRuntime.intelligence.handle('Make it 20 minutes earlier', { context });
  assert.equal(changed.kind, 'confirmation_required');
  assert.equal(changed.pendingCall.arguments.offsetMinutes, -20);
  const cancelled = await firstRuntime.intelligence.handle('cancel');
  assert.equal(cancelled.kind, 'cancelled');
  assert.equal(cancelled.state.status, 'cancelled');

  const confirmRuntime = await environment({ embed });
  const ready = await confirmRuntime.intelligence.handle(request, { context });
  const completed = await confirmRuntime.intelligence.handle('yes', { confirmed: true, context });
  assert.equal(completed.kind, 'document');
  assert.equal(completed.results[0].toolId, 'calendar.find_events');
  assert.equal(completed.results[1].toolId, 'alarm.create');

  const emptyRuntime = await environment({ embed });
  const noMeeting = await emptyRuntime.intelligence.handle(request, { context: { ...context, now: new Date('2026-11-15T08:00:00Z') } });
  assert.equal(noMeeting.kind, 'answer');
  assert.equal(noMeeting.results.length, 1);
  assert.equal(noMeeting.state.remainingIntentSegments.length, 0);
  assert.ok(ready.state.pendingConfirmation.identity);
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

test('malformed interpolation is rejected before any plan operation or confirmation', async () => {
  const runtime = await environment();
  const calendar = runtime.registry.getProvider('calendar');
  const alarm = runtime.registry.getProvider('alarm');
  let executions = 0;
  for (const provider of [calendar, alarm]) {
    const execute = provider.execute;
    provider.execute = async (...args) => { executions++; return execute(...args); };
  }
  const plan = {
    schema: 'cue.execution-plan', version: 1, id: 'invalid-interpolation', conversationId: 'invalid-interpolation',
    originalRequest: 'Set an alarm for the event', status: 'ready',
    operations: [
      { id: 'events', toolId: 'calendar.find_events', purpose: 'Find events', arguments: { date: '2026-11-15' }, dependsOn: [], inputBindings: [], conditions: [], status: 'pending', requiresConfirmation: false },
      { id: 'alarm', toolId: 'alarm.create', purpose: 'Create alarm', arguments: { label: '${events[0].title}', time: '${events[0].start}' }, dependsOn: ['events'], inputBindings: [], conditions: [], status: 'pending', requiresConfirmation: true },
    ],
  };
  await assert.rejects(() => runtime.dispatcher.dispatchPlan(plan), /interpolation|ISO date-time/);
  assert.equal(executions, 0);
});

test('invalid resolved dates are rejected before confirmation', async () => {
  const runtime = await environment();
  const calendar = runtime.registry.getProvider('calendar');
  calendar.execute = async () => ({
    document: sampleDocument('calendar', 'Calendar events', 'Invalid event'),
    data: { firstEvent: { start: 'not-a-date' } },
  });
  const plan = {
    schema: 'cue.execution-plan', version: 1, id: 'invalid-bound-date', conversationId: 'invalid-bound-date',
    originalRequest: 'Set an alarm for the event', status: 'ready',
    operations: [
      { id: 'events', toolId: 'calendar.find_events', purpose: 'Find events', arguments: { date: '2026-11-15' }, dependsOn: [], inputBindings: [], conditions: [], status: 'pending', requiresConfirmation: false },
      { id: 'alarm', toolId: 'alarm.create', purpose: 'Create alarm', arguments: { label: 'Event' }, dependsOn: ['events'], inputBindings: [{ targetArgument: 'time', sourceOperation: 'events', sourcePointer: '/firstEvent/start' }], conditions: [], status: 'pending', requiresConfirmation: true },
    ],
  };
  await assert.rejects(() => runtime.dispatcher.dispatchPlan(plan), /expected an ISO date-time/);
});

test('multi-tool plan uses a returned event time before creating the dependent alarm', async () => {
  const runtime = await environment();
  const plan = {
    schema: 'cue.execution-plan', version: 1, id: 'plan-meeting-alarm', conversationId: 'conversation-meeting-alarm',
    originalRequest: 'Find my first meeting and set an alarm 15 minutes beforehand', status: 'ready',
    operations: [
      { id: 'events', toolId: 'calendar.find_events', purpose: 'Find the first meeting', arguments: { date: '2026-11-14' }, dependsOn: [], inputBindings: [], conditions: [], status: 'pending', requiresConfirmation: false },
      {
        id: 'alarm', toolId: 'alarm.create', purpose: 'Set a meeting alarm',
        arguments: { offsetMinutes: -15, label: 'Meeting alarm' },
        inputBindings: [{ targetArgument: 'time', sourceOperation: 'events', sourcePointer: '/firstEvent/start', transform: { type: 'format_datetime' } }],
        dependsOn: ['events'], conditions: [{ type: 'json_pointer_exists', operation: 'events', pointer: '/firstEvent/start' }],
        status: 'pending', requiresConfirmation: true,
      },
    ],
  };
  const pending = await runtime.dispatcher.dispatchPlan(plan);
  assert.equal(pending.state, 'confirmation_required');
  assert.equal(pending.operations[0].toolId, 'alarm.create');
  assert.equal(pending.executionState.plan.operations[0].status, 'succeeded');
  assert.equal(pending.executionState.plan.operations[1].status, 'waiting_for_confirmation');
  const result = await runtime.dispatcher.dispatchPlan(plan, {
    confirmed: true,
    confirmedOperationId: 'alarm',
    executionState: pending.executionState,
  });
  assert.equal(result.document.id, 'alarm-success');
  assert.equal(result.plan.status, 'completed');
  assert.ok(JSON.stringify(result.document).includes('2026-11-14T07:15:00.000Z'));
});

test('execution plans fan out over validated collection items with per-item confirmation and bounded expansion', async () => {
  const runtime = await environment();
  const alarmCalls = [];
  const alarmProvider = runtime.registry.getProvider('alarm');
  const executeAlarm = alarmProvider.execute;
  alarmProvider.execute = async (toolId, args, context) => {
    if (toolId === 'alarm.create') alarmCalls.push({ ...args, operationId: context.operationId });
    return executeAlarm(toolId, args, context);
  };
  const makePlan = (id, date = '2026-11-15') => ({
    schema: 'cue.execution-plan', version: 1, id, conversationId: `conversation-${id}`,
    originalRequest: 'Create an alarm at the start time of each event',
    status: 'ready',
    operations: [
      { id: 'events', toolId: 'calendar.find_events', purpose: 'Find events', arguments: { date }, dependsOn: [], inputBindings: [], conditions: [], status: 'pending', requiresConfirmation: false },
      {
        id: 'alarms', toolId: 'alarm.create', purpose: 'Create an alarm for every event',
        arguments: {}, dependsOn: ['events'], inputBindings: [], conditions: [],
        forEach: {
          sourceOperation: 'events',
          sourcePointer: '/events',
          bindings: [
            { targetArgument: 'label', sourcePointer: '/title' },
            { targetArgument: 'time', sourcePointer: '/start' },
          ],
        },
        status: 'pending', requiresConfirmation: true,
      },
    ],
  });

  let outcome = await runtime.dispatcher.dispatchPlan(makePlan('plan-event-fanout'));
  assert.equal(outcome.state, 'confirmation_required');
  assert.equal(alarmCalls.length, 0);
  assert.deepEqual(outcome.pendingConfirmation.arguments, {
    label: 'Lunch break', time: '2026-11-15T08:00:00+02:00',
  });
  const firstOperationId = outcome.pendingConfirmation.operationId;
  outcome = await runtime.dispatcher.dispatchPlan(outcome.plan, {
    confirmed: true, confirmedOperationId: firstOperationId, executionState: outcome.executionState,
  });
  assert.equal(outcome.state, 'confirmation_required');
  assert.equal(alarmCalls.length, 1);
  const secondOperationId = outcome.pendingConfirmation.operationId;
  outcome = await runtime.dispatcher.dispatchPlan(outcome.plan, {
    confirmed: true, confirmedOperationId: secondOperationId, executionState: outcome.executionState,
  });
  assert.equal(outcome.state, 'completed');
  assert.deepEqual(alarmCalls.map(({ label, time }) => [label, time]), [
    ['Lunch break', '2026-11-15T08:00:00+02:00'],
    ['Project sync meeting', '2026-11-15T10:00:00+02:00'],
  ]);
  assert.equal(new Set(alarmCalls.map(call => call.operationId)).size, 2);
  assert.equal(outcome.results.alarms.length, 2);

  const empty = await runtime.dispatcher.dispatchPlan(makePlan('plan-empty-fanout', '2026-11-16'));
  assert.equal(empty.state, 'completed');
  assert.deepEqual(empty.results.alarms, []);
  assert.equal(alarmCalls.length, 2);

  let cancelled = await runtime.dispatcher.dispatchPlan(makePlan('plan-cancelled-fanout'));
  cancelled = await runtime.dispatcher.dispatchPlan(cancelled.plan, {
    confirmed: true,
    confirmedOperationId: cancelled.pendingConfirmation.operationId,
    executionState: cancelled.executionState,
  });
  assert.equal(cancelled.state, 'confirmation_required');
  const cancelledState = structuredClone(cancelled.executionState);
  cancelledState.plan.status = 'cancelled';
  cancelledState.plan.operations.find(operation => operation.id === cancelledState.pendingConfirmation.operationId).status = 'skipped';
  cancelledState.pendingConfirmation = undefined;
  const cancellation = await runtime.dispatcher.dispatchPlan(cancelledState.plan, { executionState: cancelledState });
  assert.equal(cancellation.state, 'cancelled');
  assert.equal(alarmCalls.length, 3);

  const calendarProvider = runtime.registry.getProvider('calendar');
  const executeCalendar = calendarProvider.execute;
  calendarProvider.execute = async (toolId, args, context) => {
    if (toolId !== 'calendar.find_events') return executeCalendar(toolId, args, context);
    const events = Array.from({ length: 8 }, (_, index) => ({
      id: `item-${index}`, title: `Event ${index}`, start: `2026-11-17T${String(index + 8).padStart(2, '0')}:00:00+02:00`,
    }));
    return { document: sampleDocument('calendar', 'Calendar events', 'Eight events'), data: { events } };
  };
  const limited = await runtime.dispatcher.dispatchPlan(makePlan('plan-limited-fanout'));
  assert.equal(limited.state, 'operation_limit');
  assert.match(limited.question, /above the 8-operation limit/);
  assert.equal(alarmCalls.length, 3);
});

test('a newly registered provider tool composes with existing tools through declared result bindings', async () => {
  const mock = await import('../src/demo/mockProviders.js');
  const tool = {
    id: 'test_catalog.lookup_record',
    providerId: 'test_catalog',
    name: 'Look up a test record',
    description: 'Return one synthetic test record with a label and start time.',
    examples: ['Look up a test record'],
    keywords: ['test record lookup'],
    parameters: { type: 'object', properties: { query: { type: 'string', minLength: 1 } }, required: ['query'], additionalProperties: false },
    resultSchema: { type: 'object', properties: { record: { type: 'object', properties: { title: { type: 'string' }, start: { type: 'string' } } } } },
    confirmation: 'none',
  };
  let lookupCount = 0;
  const provider = {
    id: 'test_catalog',
    execute: async () => {
      lookupCount++;
      return {
        document: sampleDocument('test_catalog', 'Synthetic record', 'Ready'),
        data: { record: { title: 'Test appointment', start: '2026-11-17T10:00:00+02:00' } },
      };
    },
  };
  const runtime = await mock.createMockEnvironment({
    manifests: [...manifests, tool],
    providers: [...testProviders(), provider],
    embed: async text => fakeEmbed(text),
  });
  const plan = {
    schema: 'cue.execution-plan', version: 1, id: 'plan-unfamiliar-tool', conversationId: 'conversation-unfamiliar-tool',
    originalRequest: 'Look up the appointment and set an alarm',
    status: 'ready',
    operations: [
      { id: 'lookup', toolId: tool.id, purpose: 'Look up the appointment', arguments: { query: 'appointment' }, dependsOn: [], inputBindings: [], conditions: [], status: 'pending', requiresConfirmation: false },
      {
        id: 'alarm', toolId: 'alarm.create', purpose: 'Set an alarm',
        arguments: {}, dependsOn: ['lookup'],
        inputBindings: [
          { targetArgument: 'label', sourceOperation: 'lookup', sourcePointer: '/record/title' },
          { targetArgument: 'time', sourceOperation: 'lookup', sourcePointer: '/record/start' },
        ],
        conditions: [], status: 'pending', requiresConfirmation: true,
      },
    ],
  };
  const pending = await runtime.dispatcher.dispatchPlan(plan);
  assert.equal(lookupCount, 1);
  assert.equal(pending.pendingConfirmation.toolId, 'alarm.create');
  assert.deepEqual(pending.pendingConfirmation.arguments, {
    label: 'Test appointment', time: '2026-11-17T10:00:00+02:00',
  });
});

test('all static plan arguments validate before the dispatcher can begin side effects', async () => {
  const runtime = await environment();
  let sideEffects = 0;
  const alarmProvider = runtime.registry.getProvider('alarm');
  alarmProvider.execute = async () => { sideEffects++; return sampleDocument('alarm', 'Alarm', 'Created', 'success'); };
  const plan = {
    schema: 'cue.execution-plan', version: 1, id: 'plan-invalid-later-arguments', conversationId: 'conversation-invalid-later-arguments',
    originalRequest: 'Create an alarm and a card', status: 'ready',
    operations: [
      {
        id: 'alarm', toolId: 'alarm.create', purpose: 'Create an alarm',
        arguments: { time: '2026-11-17T09:00:00+02:00', label: 'Meeting' },
        dependsOn: [], inputBindings: [], conditions: [], status: 'pending', requiresConfirmation: true,
      },
      {
        id: 'card', toolId: 'anki.create_card', purpose: 'Create a card',
        arguments: { front: 5, back: 'A synthetic answer' },
        dependsOn: [], inputBindings: [], conditions: [], status: 'pending', requiresConfirmation: true,
      },
    ],
  };
  await assert.rejects(runtime.dispatcher.dispatchPlan(plan), /Invalid execution plan/);
  assert.equal(sideEffects, 0);
});

test('execution plans validate bindings, deterministic transforms, conditions, and operation limits', async () => {
  const planModule = await import('../src/intelligence/executionPlan.js');
  const runtime = await environment();
  const valid = {
    schema: 'cue.execution-plan', version: 1, id: 'plan-valid', conversationId: 'conversation-valid',
    originalRequest: 'Find a meeting and set an alarm', status: 'ready',
    operations: [
      { id: 'search', toolId: 'calendar.find_events', purpose: 'Search meetings', arguments: {}, dependsOn: [], inputBindings: [], conditions: [], status: 'pending', requiresConfirmation: false },
      { id: 'alarm', toolId: 'alarm.create', purpose: 'Create alarm', arguments: { offsetMinutes: -15, label: 'Reminder' }, dependsOn: ['search'], inputBindings: [{ targetArgument: 'time', sourceOperation: 'search', sourcePointer: '/firstEvent/start', transform: { type: 'subtract_duration', duration: 'PT15M' } }], conditions: [], status: 'pending', requiresConfirmation: true },
    ],
  };
  assert.equal(planModule.validateExecutionPlan(valid, runtime.registry).valid, true);
  const invalid = structuredClone(valid);
  invalid.operations[1].inputBindings[0].sourceOperation = 'missing';
  assert.match(planModule.validateExecutionPlan(invalid, runtime.registry).errors.join(' '), /unknown operation/);
  const missingCollectionPointer = structuredClone(valid);
  missingCollectionPointer.operations[1].forEach = { sourceOperation: 'search', bindings: [] };
  assert.match(planModule.validateExecutionPlan(missingCollectionPointer, runtime.registry).errors.join(' '), /requires a source operation, array JSON Pointer/);
  const missingItemPointer = structuredClone(valid);
  missingItemPointer.operations[1].forEach = { sourceOperation: 'search', sourcePointer: '/events', bindings: [{ targetArgument: 'time' }] };
  assert.match(planModule.validateExecutionPlan(missingItemPointer, runtime.registry).errors.join(' '), /requires targetArgument and an item JSON Pointer/);
  assert.equal(planModule.applyBindingTransform('2026-11-14T10:00:00+02:00', { type: 'subtract_duration', duration: 'PT15M' }), '2026-11-14T07:45:00.000Z');
  assert.equal(planModule.applyBindingTransform('2026-11-14T10:00:00+02:00', { type: 'add_duration', duration: 'PT15M' }), '2026-11-14T08:15:00.000Z');
  assert.equal(planModule.applyBindingTransform([{ id: 'first' }], { type: 'select_first' }).id, 'first');
});

test('execution controller skips a dependent operation when its source value is absent', async () => {
  const runtime = await environment();
  const plan = {
    schema: 'cue.execution-plan', version: 1, id: 'plan-empty-meeting', conversationId: 'conversation-empty-meeting',
    originalRequest: 'Find a meeting and set an alarm', status: 'ready',
    operations: [
      { id: 'search', toolId: 'calendar.find_events', purpose: 'Find meeting', arguments: { date: '2026-11-14', event_type: 'meeting', query: 'not-a-meeting' }, dependsOn: [], inputBindings: [], conditions: [], status: 'pending', requiresConfirmation: false },
      { id: 'alarm', toolId: 'alarm.create', purpose: 'Set alarm', arguments: { offsetMinutes: -15, label: 'Reminder' }, dependsOn: ['search'], inputBindings: [{ targetArgument: 'time', sourceOperation: 'search', sourcePointer: '/events/0/start' }], conditions: [{ type: 'json_pointer_exists', operation: 'search', pointer: '/events/0/start' }], status: 'pending', requiresConfirmation: true },
    ],
  };
  const result = await runtime.dispatcher.dispatchPlan(plan);
  assert.equal(result.state, 'completed');
  assert.equal(result.plan.operations[1].status, 'skipped');
  assert.equal(result.plan.status, 'completed');
  assert.equal(result.executionState.results.alarm, undefined);
});

test('execution controller persists failed status when bound arguments are invalid', async () => {
  const runtime = await environment();
  const calendarProvider = runtime.registry.getProvider('calendar');
  calendarProvider.execute = async () => ({
    document: sampleDocument('calendar', 'Malformed result', 'A malformed synthetic start time'),
    data: { events: [], firstEvent: { start: 42 } },
  });
  const plan = {
    schema: 'cue.execution-plan', version: 1, id: 'plan-invalid-arguments', conversationId: 'conversation-invalid-arguments',
    originalRequest: 'Find my calendar events', status: 'ready',
    operations: [
      {
        id: 'events', toolId: 'calendar.find_events', purpose: 'Find calendar events',
        arguments: { date: '2026-11-14' }, dependsOn: [], inputBindings: [], conditions: [], status: 'pending', requiresConfirmation: false,
      },
      {
        id: 'alarm', toolId: 'alarm.create', purpose: 'Create a reminder alarm',
        arguments: { label: 'Reminder' }, dependsOn: ['events'],
        inputBindings: [{ targetArgument: 'time', sourceOperation: 'events', sourcePointer: '/firstEvent/start' }],
        conditions: [], status: 'pending', requiresConfirmation: true,
      },
    ],
  };
  const savedStates = [];
  await assert.rejects(runtime.dispatcher.dispatchPlan(plan, {
    onStateChange: state => savedStates.push(state),
  }), /Invalid bound arguments/);
  assert.equal(savedStates.at(-1).plan.status, 'failed');
  assert.equal(savedStates.at(-1).plan.operations[0].status, 'succeeded');
  assert.equal(savedStates.at(-1).plan.operations[1].status, 'failed');
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
