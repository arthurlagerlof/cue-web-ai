const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function testRuntime() {
  const { ToolRegistry } = require('../src/intelligence/toolRegistry.js');
  const manifests = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'seed', 'tool-manifests.json'), 'utf8'));
  const providers = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'seed', 'provider-manifests.json'), 'utf8'));
  const registry = new ToolRegistry();
  for (const provider of providers) registry.registerProvider({ id: provider.id, execute: async () => ({}) });
  for (const tool of manifests) registry.registerTool(tool);
  return {
    registry,
    providers,
    registryData: {
      toolRetrievalConfig: { maxOperations: 8 },
      data: { anki: { cards: [{ id: 'secret', front: 'PRIVATE RECORD CONTENT' }] } },
    },
  };
}

test('OpenRouter plan request contains the tool catalog but no local provider records', async () => {
  const { planWithOpenRouter } = await import('../src/intelligence/openRouter.js');
  const browserClient = fs.readFileSync(path.join(__dirname, '..', 'src', 'intelligence', 'openRouter.js'), 'utf8');
  assert.doesNotMatch(browserClient, /OPENROUTER_API_KEY|Authorization|apiKey/);
  const runtime = testRuntime();
  const tool = runtime.registry.get('anki.search_cards');
  const output = {
    kind: 'plan',
    question: null,
    text: null,
    operations: [{
      id: 'search',
      toolId: tool.id,
      purpose: 'Search the cards',
      arguments: { query: 'photosynthesis' },
      dependsOn: [],
      inputBindings: [],
      conditions: [],
      forEach: null,
    }],
  };
  let requestBody;
  let endpoint;
  let headers;
  let usageCalls = 0;
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    endpoint = url;
    requestBody = JSON.parse(options.body);
    headers = options.headers;
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const result = await planWithOpenRouter({
      request: 'Search my cards about photosynthesis',
      context: { timeZone: 'UTC' },
      runtime,
      onRequest: async () => { usageCalls++; },
    });
    assert.equal(result.kind, 'plan');
    assert.equal(result.plan.operations[0].toolId, tool.id);
    assert.equal(result.plan.operations[0].requiresConfirmation, false);
    assert.equal(endpoint, '/api/openrouter');
    assert.equal(headers.Authorization, undefined);
    assert.equal(requestBody.maxTokens, 3000);
    assert.equal(Object.hasOwn(requestBody, 'apiKey'), false);
    assert.equal(usageCalls, 1);
    const prompt = requestBody.prompt;
    assert.match(prompt, /anki\.search_cards/);
    assert.match(prompt, /Search my Anki cards about photosynthesis/);
    assert.match(prompt, /Etsi Anki-kortti fotosynteesistä/);
    assert.doesNotMatch(prompt, /Find the card about chloroplasts/);
    assert.doesNotMatch(prompt, /acceptedSources|providerPermissions|requiredPermissions|keywords/);
    assert.match(prompt, /additionalProperties/);
    assert.doesNotMatch(prompt, /PRIVATE RECORD CONTENT/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('OpenRouter response validation retries malformed plans and surfaces backend configuration errors', async () => {
  const { planWithOpenRouter } = await import('../src/intelligence/openRouter.js');
  const runtime = testRuntime();
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
        kind: 'plan', question: null, text: null,
        operations: [{ id: 'bad', toolId: 'unknown.tool', purpose: 'invalid', arguments: {}, dependsOn: [], inputBindings: [], conditions: [], forEach: null }],
      }) } }],
    }), { status: 200 });
  };
  try {
    await assert.rejects(planWithOpenRouter({
      request: 'Do something',
      context: {},
      runtime,
    }), /could not validate the OpenRouter plan/);
    assert.equal(calls, 2);
    calls = 0;
    global.fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ error: 'OpenRouter is not configured on the server.' }), { status: 503 });
    };
    await assert.rejects(planWithOpenRouter({
      request: 'Do something',
      context: {},
      runtime,
    }), /OpenRouter is not configured on the server/);
    assert.equal(calls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('OpenRouter reports only safe model, latency, and token metadata for real upstream calls', async () => {
  const { planWithOpenRouter } = await import('../src/intelligence/openRouter.js');
  const runtime = testRuntime();
  const tool = runtime.registry.get('anki.search_cards');
  const resultBody = {
    kind: 'plan',
    question: null,
    text: null,
    operations: [{
      id: 'search',
      toolId: tool.id,
      purpose: 'Search cards',
      arguments: { query: 'plants' },
      dependsOn: [],
      inputBindings: [],
      conditions: [],
      forEach: null,
    }],
  };
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async () => new Response(JSON.stringify({
    model: 'provider/model',
    usage: { prompt_tokens: 17, completion_tokens: 9 },
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(resultBody) } }],
  }), {
    status: 200,
    headers: {
      'x-cue-external-call': 'true',
      'x-cue-model': 'provider/model',
    },
  });
  try {
    await planWithOpenRouter({
      request: 'Search my cards',
      context: {},
      runtime,
      onCall: call => calls.push(call),
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].provider, 'openrouter');
    assert.equal(calls[0].model, 'provider/model');
    assert.equal(calls[0].inputTokens, 17);
    assert.equal(calls[0].outputTokens, 9);
    assert.equal(calls[0].made, true);
    assert.equal(calls[0].success, true);
    assert.ok(calls[0].latencyMs >= 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('server OpenRouter proxy uses its configured key and rejects client-supplied keys', async () => {
  const { handleOpenRouterRequest } = await import('../netlify/functions/openrouter.mjs');
  let upstream;
  const result = await handleOpenRouterRequest({
    method: 'POST',
    body: JSON.stringify({ prompt: 'A private user request', maxTokens: 1200 }),
    headers: { origin: 'https://cue.example', host: 'cue.example' },
    clientIp: 'proxy-test',
    apiKey: 'server-only-key',
    fetchImpl: async (url, options) => {
      upstream = { url, options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: '{"kind":"no_tool"}' } }],
        usage: { prompt_tokens: 99 },
      }), { status: 200 });
    },
  });
  assert.equal(result.statusCode, 200);
  assert.equal(upstream.options.headers.Authorization, 'Bearer server-only-key');
  assert.equal(upstream.body.model, 'dots-studio/dots-3-note-preview:free');
  assert.equal(upstream.body.messages[0].content, 'A private user request');
  assert.equal(result.headers['X-Cue-External-Call'], 'true');
  assert.equal(result.headers['X-Cue-Model'], 'dots-studio/dots-3-note-preview:free');
  assert.match(result.body, /"prompt_tokens":99/);
  assert.doesNotMatch(result.body, /server-only-key|A private user request/);

  const rejected = await handleOpenRouterRequest({
    method: 'POST',
    body: JSON.stringify({ prompt: 'request', maxTokens: 10, apiKey: 'client-key' }),
    headers: { origin: 'https://cue.example', host: 'cue.example' },
    clientIp: 'proxy-test-2',
    apiKey: 'server-only-key',
    fetchImpl: async () => { throw new Error('Rejected input must not reach OpenRouter.'); },
  });
  assert.equal(rejected.statusCode, 400);
});
