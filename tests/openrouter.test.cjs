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

function mockTimeouts(t) {
  let now = 0;
  const timers = new Map();
  t.mock.method(global, 'setTimeout', (callback, delay) => {
    const timer = {};
    timers.set(timer, { callback, at: now + delay });
    return timer;
  });
  t.mock.method(global, 'clearTimeout', timer => timers.delete(timer));
  return {
    tick(delay) {
      const end = now + delay;
      while (true) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].callback();
      }
      now = end;
    },
  };
}

test('OpenRouter plan request contains the tool catalog but no local provider records', async () => {
  const { planWithOpenRouter } = await import('../src/intelligence/openRouter.js');
  const browserClient = fs.readFileSync(path.join(__dirname, '..', 'src', 'intelligence', 'openRouter.js'), 'utf8');
  assert.doesNotMatch(browserClient, /OPENROUTER_API_KEY|Authorization|apiKey/);
  const runtime = testRuntime();
  const tool = runtime.registry.get('anki.search_cards');
  const { ToolDispatcher } = await import('../src/intelligence/dispatcher.js');
  const executions = [];
  runtime.registry.getProvider('anki').execute = async (toolId, args) => {
    executions.push({ toolId, args });
    return {
      schema: 'cue.display', version: 1, id: 'anki-results', title: 'Results',
      source: { app: 'anki', name: 'Anki' }, state: 'ready',
      pages: [{ id: 'results', elements: [{ type: 'text', text: 'Found a card.' }] }],
      actions: [], assets: [],
    };
  };
  const output = {
    kind: 'tool',
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
    assert.equal(result.kind, 'tool');
    assert.equal(result.plan.operations[0].toolId, tool.id);
    assert.equal(result.plan.operations[0].requiresConfirmation, false);
    const execution = await new ToolDispatcher(runtime.registry).dispatchPlan(result.plan);
    assert.equal(execution.state, 'completed');
    assert.deepEqual(executions, [{ toolId: tool.id, args: { query: 'photosynthesis' } }]);
    assert.equal(endpoint, '/api/openrouter');
    assert.equal(headers.Authorization, undefined);
    assert.equal(requestBody.maxTokens, 3000);
    assert.equal(Object.hasOwn(requestBody, 'apiKey'), false);
    assert.equal(usageCalls, 1);
    const prompt = requestBody.prompt;
    assert.match(prompt, /Minimize internal reasoning/);
    assert.match(prompt, /Return the required JSON directly/);
    assert.match(prompt, /anki\.search_cards/);
    assert.match(prompt, /web\.search/);
    assert.match(prompt, /Web search is an ordinary listed tool/);
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

test('direct answers send the original request as conversational text even with no registered tools', async t => {
  const { planWithOpenRouter } = await import('../src/intelligence/openRouter.js');
  const { handleOpenRouterRequest } = await import('../netlify/functions/openrouter.mjs');
  const { ToolRegistry } = await import('../src/intelligence/toolRegistry.js');
  const request = 'Why is the Mona Lisa special?';
  const upstreamRequests = [];
  t.mock.method(global, 'fetch', async (_url, options) => {
    const response = await handleOpenRouterRequest({
      method: 'POST', body: options.body, apiKey: 'test-key', clientIp: 'direct-answer-test',
      fetchImpl: async (_upstreamUrl, upstreamOptions) => {
        const body = JSON.parse(upstreamOptions.body);
        upstreamRequests.push(body);
        const content = body.response_format
          ? JSON.stringify({ kind: 'direct_answer', question: null, text: null, operations: [] })
          : 'Its technique and mysterious expression make it distinctive.';
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }), { status: 200 });
      },
    });
    return new Response(response.body, { status: response.statusCode, headers: response.headers });
  });
  for (const runtime of [testRuntime(), { registry: new ToolRegistry() }]) {
    const result = await planWithOpenRouter({
      request, context: {}, runtime,
      priorState: { status: 'completed', originalRequest: 'An older request' },
    });
    assert.equal(result.kind, 'direct_answer');
    assert.match(result.text, /technique and mysterious expression/);
    assert.equal(result.state.originalRequest, request);
    assert.equal(result.state.status, 'completed');
  }
  assert.equal(upstreamRequests.length, 4);
  for (const index of [0, 2]) {
    assert.deepEqual(upstreamRequests[index].response_format, { type: 'json_object' });
    assert.match(upstreamRequests[index].messages[0].content, /direct_answer/);
    assert.equal(upstreamRequests[index + 1].messages[0].content, `Answer naturally and concisely. Do not use tools.\n\n${request}`);
    assert.equal(Object.hasOwn(upstreamRequests[index + 1], 'response_format'), false);
  }
  assert.match(upstreamRequests[2].messages[0].content, /"registeredTools":\[\]/);
});

test('planner direct answers with text are returned without another model call', async t => {
  const { planWithOpenRouter } = await import('../src/intelligence/openRouter.js');
  let calls = 0;
  t.mock.method(global, 'fetch', async () => {
    calls++;
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
        kind: 'direct_answer', question: null, text: "That's wonderful to hear!", operations: [],
      }) } }],
    }), { status: 200 });
  });
  const result = await planWithOpenRouter({ request: 'I feel great', context: {}, runtime: testRuntime() });
  assert.equal(result.text, "That's wonderful to hear!");
  assert.equal(result.state.status, 'completed');
  assert.equal(calls, 1);
});

test('planner rejects direct answers with empty text or operations', async t => {
  const { planWithOpenRouter } = await import('../src/intelligence/openRouter.js');
  for (const response of [
    { kind: 'direct_answer', question: null, text: ' ', operations: [] },
    { kind: 'direct_answer', question: null, text: 'Answer', operations: [{}] },
  ]) {
    const fetch = t.mock.method(global, 'fetch', async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(response) } }],
    }), { status: 200 }));
    await assert.rejects(planWithOpenRouter({ request: 'Hello', context: {}, runtime: testRuntime() }), /invalid direct-answer response/);
    fetch.mock.restore();
  }
});

test('direct text answers succeed without parsing or validating model JSON', async t => {
  const { answerWithOpenRouter } = await import('../src/intelligence/openRouter.js');
  const { handleOpenRouterRequest } = await import('../netlify/functions/openrouter.mjs');
  const request = 'Why is the Mona Lisa special?';
  const upstreamRequests = [];
  t.mock.method(global, 'fetch', async (_url, options) => {
    const response = await handleOpenRouterRequest({
      method: 'POST', body: options.body, apiKey: 'test-key', clientIp: 'plain-text-answer-test',
      fetchImpl: async (_upstreamUrl, upstreamOptions) => {
        const body = JSON.parse(upstreamOptions.body);
        upstreamRequests.push(body);
        return new Response(JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: 'Its technique and mysterious expression make it distinctive.' } }],
        }), { status: 200 });
      },
    });
    return new Response(response.body, { status: response.statusCode, headers: response.headers });
  });

  const answer = await answerWithOpenRouter({ request });

  assert.equal(answer, 'Its technique and mysterious expression make it distinctive.');
  assert.equal(upstreamRequests.length, 1);
  assert.equal(Object.hasOwn(upstreamRequests[0], 'response_format'), false);
  assert.equal(upstreamRequests[0].messages[0].content, `Answer naturally and concisely. Do not use tools.\n\n${request}`);
});

test('clarification waits for a user response and retains context for a direct answer', async t => {
  const { planWithOpenRouter } = await import('../src/intelligence/openRouter.js');
  const requests = [];
  t.mock.method(global, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    const content = requests.length === 1
      ? JSON.stringify({ kind: 'clarification', question: 'Which painting?', text: null, operations: [] })
      : requests.length === 2
        ? JSON.stringify({ kind: 'direct_answer', question: null, text: null, operations: [] })
        : 'It is famous for its technique.';
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }), { status: 200 });
  });
  const runtime = testRuntime();
  const clarification = await planWithOpenRouter({ request: 'Why is that painting special?', context: {}, runtime });
  assert.equal(clarification.kind, 'clarification');
  assert.equal(clarification.question, 'Which painting?');
  assert.equal(clarification.state.pendingReasoning, true);
  assert.equal(requests.length, 1);
  const answer = await planWithOpenRouter({ request: 'The Mona Lisa', context: {}, runtime, priorState: clarification.state });
  assert.equal(answer.kind, 'direct_answer');
  assert.equal(answer.state.pendingReasoning, false);
  assert.equal(requests[2].prompt, 'Answer naturally and concisely. Do not use tools.\n\nWhy is that painting special?\n\nWhich painting?\nThe Mona Lisa');
});

test('web search is selected and dispatched as a registered tool', async t => {
  const { planWithOpenRouter } = await import('../src/intelligence/openRouter.js');
  const { ToolDispatcher } = await import('../src/intelligence/dispatcher.js');
  const runtime = testRuntime();
  let executed;
  runtime.registry.getProvider('web').execute = async (toolId, args) => {
    executed = { toolId, args };
    return {
      schema: 'cue.display', version: 1, id: 'web-results', title: 'Results',
      source: { app: 'web', name: 'Web' }, state: 'ready',
      pages: [{ id: 'results', elements: [{ type: 'text', text: 'Found a result.' }] }],
      actions: [], assets: [],
    };
  };
  t.mock.method(global, 'fetch', async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({
      kind: 'tool', question: null, text: null,
      operations: [{ id: 'search', toolId: 'web.search', purpose: 'Search the web', arguments: { query: 'recent art news' }, dependsOn: [], inputBindings: [], conditions: [], forEach: null }],
    }) } }],
  }), { status: 200 }));
  const result = await planWithOpenRouter({ request: 'Search the web for recent art news', context: {}, runtime });
  assert.equal(result.kind, 'tool');
  assert.equal((await new ToolDispatcher(runtime.registry).dispatchPlan(result.plan)).state, 'completed');
  assert.deepEqual(executed, { toolId: 'web.search', args: { query: 'recent art news' } });
});

test('direct-answer failures surface without retrying the planner', async t => {
  const { planWithOpenRouter } = await import('../src/intelligence/openRouter.js');
  let calls = 0;
  t.mock.method(global, 'fetch', async () => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ kind: 'direct_answer', question: null, text: null, operations: [] }) } }],
    }), { status: 200 });
    return new Response(JSON.stringify({ error: 'Conversational answer failed.' }), { status: 503 });
  });
  await assert.rejects(planWithOpenRouter({ request: 'Explain art', context: {}, runtime: testRuntime() }), /Conversational answer failed/);
  assert.equal(calls, 2);
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
        kind: 'tool', question: null, text: null,
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

test('planner binding instructions provide a valid example and preserve strict validation on retry', async () => {
  const { planWithOpenRouter } = await import('../src/intelligence/openRouter.js');
  const runtime = testRuntime();
  const prompts = [];
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => {
    const prompt = JSON.parse(options.body).prompt;
    prompts.push(prompt);
    const example = prompt.match(/Each inputBindings entry must be (\{[^}]+\})/);
    assert.ok(example, 'planner must receive an explicit binding example');
    const binding = JSON.parse(example[1]);
    if (prompts.length === 1) {
      binding.sourcePath = binding.sourcePointer;
      delete binding.sourcePointer;
    }
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
        kind: 'tool', question: null, text: null,
        operations: [
          { id: 'events', toolId: 'calendar.find_events', purpose: 'Find events', arguments: { date: '2026-11-18' }, dependsOn: [], inputBindings: [], conditions: [], forEach: null },
          { id: 'alarm', toolId: 'alarm.create', purpose: 'Set an alarm', arguments: { label: 'Meeting' }, dependsOn: ['events'], inputBindings: [binding], conditions: [], forEach: null },
        ],
      }) } }],
    }), { status: 200 });
  };
  try {
    const result = await planWithOpenRouter({ request: 'Find an event and set an alarm', context: {}, runtime });
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /inputBindings\[0\].*requires targetArgument, sourceOperation, and a JSON Pointer/);
    assert.deepEqual(result.plan.operations[1].inputBindings, [{
      targetArgument: 'time', sourceOperation: 'events', sourcePointer: '/firstEvent/start',
    }]);
    assert.equal(result.plan.operations[1].requiresConfirmation, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('OpenRouter reports only safe model, latency, and token metadata for real upstream calls', async () => {
  const { planWithOpenRouter } = await import('../src/intelligence/openRouter.js');
  const runtime = testRuntime();
  const tool = runtime.registry.get('anki.search_cards');
  const resultBody = {
    kind: 'tool',
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
  assert.deepEqual(upstream.body.reasoning, { enabled: false });
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

test('non-Dots model overrides retain their own reasoning settings', async () => {
  const { handleOpenRouterRequest } = await import('../netlify/functions/openrouter.mjs');
  let upstreamBody;
  const result = await handleOpenRouterRequest({
    method: 'POST',
    body: JSON.stringify({ prompt: 'Test request', maxTokens: 10 }),
    apiKey: 'test-key',
    clientIp: 'model-override-test',
    model: 'example/other-model',
    fetchImpl: async (_url, options) => {
      upstreamBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), { status: 200 });
    },
  });
  assert.equal(result.statusCode, 200);
  assert.equal(Object.hasOwn(upstreamBody, 'reasoning'), false);
});

test('local proxy accepts a response after 30 seconds and reports an upstream timeout', async t => {
  const { normalizeWithOpenRouter } = await import('../src/intelligence/openRouter.js');
  const { handleOpenRouterRequest } = await import('../netlify/functions/openrouter.mjs');
  const clock = mockTimeouts(t);
  let upstreamDelay = 35000;
  t.mock.method(global, 'fetch', async (_url, options) => {
    const result = await handleOpenRouterRequest({
      method: 'POST',
      body: options.body,
      apiKey: 'test-key',
      clientIp: 'local-timeout-test',
      fetchImpl: (_upstreamUrl, upstreamOptions) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response(JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: '{"status":"resolved"}' } }],
        }), { status: 200 })), upstreamDelay);
        upstreamOptions.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      }),
    });
    return new Response(result.body, { status: result.statusCode, headers: result.headers });
  });

  const slowRequest = normalizeWithOpenRouter({ prompt: 'Test request' });
  await Promise.resolve();
  clock.tick(35000);
  assert.equal(await slowRequest, '{"status":"resolved"}');

  upstreamDelay = 56000;
  const timedOutRequest = normalizeWithOpenRouter({ prompt: 'Test request' });
  await Promise.resolve();
  clock.tick(55000);
  await assert.rejects(timedOutRequest, /OpenRouter did not respond within 55 seconds/);
});

test('client times out when the local proxy does not respond', async t => {
  const { normalizeWithOpenRouter } = await import('../src/intelligence/openRouter.js');
  const clock = mockTimeouts(t);
  t.mock.method(global, 'fetch', (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }));
  const request = normalizeWithOpenRouter({ prompt: 'Test request' });
  await Promise.resolve();
  clock.tick(60000);
  await assert.rejects(request, /proxy did not respond within 60 seconds/);
});
