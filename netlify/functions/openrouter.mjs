const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'dots-studio/dots-3-note-preview:free';
const MAX_BODY_BYTES = 102400;
const MAX_PROMPT_BYTES = 100000;
const MAX_RESPONSE_BYTES = 262144;
const MAX_TOKENS = 3000;
const UPSTREAM_TIMEOUT_MS = 55000;
const RATE_WINDOW_MS = 60000;
const MAX_REQUESTS_PER_WINDOW = 30;
const requestsByClient = new Map();

function jsonResponse(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

function isSameOrigin(origin, headers) {
  if (!origin) return true;
  let originHost;
  try { originHost = new URL(origin).host; }
  catch { return false; }
  const allowedHosts = [headers.host, headers['x-forwarded-host']]
    .filter(value => typeof value === 'string' && value.length > 0);
  return allowedHosts.includes(originHost);
}

function checkRateLimit(clientIp, now) {
  const recent = (requestsByClient.get(clientIp) ?? []).filter(timestamp => now - timestamp < RATE_WINDOW_MS);
  if (recent.length >= MAX_REQUESTS_PER_WINDOW) {
    requestsByClient.set(clientIp, recent);
    return false;
  }
  recent.push(now);
  requestsByClient.set(clientIp, recent);
  if (requestsByClient.size > 1000) {
    for (const [ip, timestamps] of requestsByClient) {
      if (!timestamps.some(timestamp => now - timestamp < RATE_WINDOW_MS)) requestsByClient.delete(ip);
    }
  }
  return true;
}

async function readBounded(response) {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new RangeError('OpenRouter response exceeded the size limit.');
  }
  if (!response.body) throw new Error('OpenRouter returned an empty response.');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new RangeError('OpenRouter response exceeded the size limit.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

export async function handleOpenRouterRequest({
  method,
  body,
  headers = {},
  clientIp = 'unknown',
  apiKey,
  model = DEFAULT_MODEL,
  fetchImpl = fetch,
  now = Date.now(),
}) {
  if (method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' });
  if (!isSameOrigin(headers.origin, headers)) return jsonResponse(403, { error: 'Cross-origin requests are not allowed.' });
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    return jsonResponse(503, { error: 'OpenRouter is not configured on the server.' });
  }
  if (typeof body !== 'string' || new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
    return jsonResponse(400, { error: 'Request body is invalid or too large.' });
  }
  let request;
  try { request = JSON.parse(body); }
  catch { return jsonResponse(400, { error: 'Request body must be valid JSON.' }); }
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some(key => !['prompt', 'maxTokens'].includes(key))
    || typeof request.prompt !== 'string' || !request.prompt.trim()
    || new TextEncoder().encode(request.prompt).byteLength > MAX_PROMPT_BYTES
    || !Number.isSafeInteger(request.maxTokens) || request.maxTokens < 1 || request.maxTokens > MAX_TOKENS) {
    return jsonResponse(400, { error: 'The OpenRouter request is invalid.' });
  }
  if (typeof model !== 'string' || !model.trim() || model.length > 200 || /[\r\n]/.test(model)) {
    return jsonResponse(503, { error: 'OpenRouter model configuration is invalid.' });
  }
  if (!checkRateLimit(String(clientIp).slice(0, 128), now)) {
    return jsonResponse(429, { error: 'OpenRouter request limit reached. Try again shortly.' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  const telemetryHeaders = {
    'X-Cue-External-Call': 'true',
    'X-Cue-Model': model.trim(),
  };
  try {
    const upstream = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model.trim(),
        messages: [{ role: 'user', content: request.prompt }],
        ...(['dots-studio/dots-3-note-preview', 'dots-studio/dots-3-note-preview:free'].includes(model.trim())
          ? { reasoning: { enabled: false } }
          : {}),
        max_tokens: request.maxTokens,
        temperature: 0.1,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
      redirect: 'error',
    });
    if (!upstream.ok) {
      return jsonResponse(502, { error: `OpenRouter request failed (HTTP ${upstream.status}).` }, telemetryHeaders);
    }
    const text = await readBounded(upstream);
    let response;
    try { response = JSON.parse(text); }
    catch { return jsonResponse(502, { error: 'OpenRouter returned an invalid response.' }, telemetryHeaders); }
    const choice = response?.choices?.[0];
    if (!choice || typeof choice.message?.content !== 'string' || !choice.message.content.trim()) {
      return jsonResponse(502, { error: 'OpenRouter returned an empty response.' }, telemetryHeaders);
    }
    const actualModel = typeof response.model === 'string' && response.model.trim()
      && response.model.length <= 200 && !/[\r\n]/.test(response.model)
      ? response.model.trim()
      : model.trim();
    const usage = response.usage && typeof response.usage === 'object' ? {
      prompt_tokens: Number.isSafeInteger(response.usage.prompt_tokens) && response.usage.prompt_tokens >= 0 ? response.usage.prompt_tokens : null,
      completion_tokens: Number.isSafeInteger(response.usage.completion_tokens) && response.usage.completion_tokens >= 0 ? response.usage.completion_tokens : null,
    } : null;
    return jsonResponse(200, {
      model: actualModel,
      usage,
      choices: [{
        finish_reason: choice.finish_reason,
        message: { content: choice.message.content },
      }],
    }, { ...telemetryHeaders, 'X-Cue-Model': actualModel });
  } catch (error) {
    const message = error instanceof Error && error.name === 'AbortError'
      ? 'OpenRouter did not respond within 55 seconds. Try again or use Web AI mode.'
      : 'OpenRouter request failed.';
    return jsonResponse(502, { error: message }, telemetryHeaders);
  } finally {
    clearTimeout(timeout);
  }
}

export const handler = async event => {
  const result = await handleOpenRouterRequest({
    method: event.httpMethod,
    body: event.body ?? '',
    headers: event.headers ?? {},
    clientIp: event.headers?.['x-nf-client-connection-ip'] ?? event.headers?.['x-forwarded-for'] ?? 'unknown',
    apiKey: process.env.OPENROUTER_API_KEY,
    model: process.env.OPENROUTER_MODEL || DEFAULT_MODEL,
  });
  return result;
};
