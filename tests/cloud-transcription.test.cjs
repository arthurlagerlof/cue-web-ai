const test = require('node:test');
const assert = require('node:assert/strict');

test('cloud transcription sends resampled WAV as multipart and returns the transcript', async t => {
  const { transcribeInCloud } = await import('../src/services/cloudTranscription.js');
  let calls = 0;
  t.mock.method(global, 'fetch', async (url, options) => {
    calls++;
    assert.equal(url, '/api/transcribe');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers, undefined);
    const file = options.body.get('file');
    assert.equal(file.type, 'audio/wav');
    const wav = new DataView(await file.arrayBuffer());
    assert.equal(wav.getUint32(24, true), 16000);
    assert.equal(wav.getUint32(40, true), 8);
    assert.equal(wav.getInt16(44, true), 0);
    assert.equal(wav.getInt16(46, true), 16383);
    assert.equal(wav.getInt16(48, true), 32767);
    assert.equal(wav.getInt16(50, true), -32768);
    return Response.json({ text: 'recognized speech' });
  });
  const text = await transcribeInCloud(Float32Array.of(0, 0.5, 1, -1), 16000, new AbortController().signal);
  assert.equal(text, 'recognized speech');
  assert.equal(calls, 1);
});

test('cloud transcription surfaces HTTP, network, and invalid-response errors without retries', async t => {
  const { transcribeInCloud } = await import('../src/services/cloudTranscription.js');
  let response = new Response('', { status: 413 });
  let calls = 0;
  t.mock.method(global, 'fetch', async () => {
    calls++;
    if (response instanceof Error) throw response;
    return response;
  });
  const transcribe = () => transcribeInCloud(Float32Array.of(0), 16000, new AbortController().signal);
  await assert.rejects(transcribe(), /exceeds the 10 MB/);
  response = new Response('', { status: 429 });
  await assert.rejects(transcribe(), /rate limit.*Wait/);
  response = new Response('', { status: 500 });
  await assert.rejects(transcribe(), /Cloud transcription failed/);
  response = new Error('network');
  await assert.rejects(transcribe(), /Cloud transcription is unavailable/);
  response = Response.json({ unexpected: true });
  await assert.rejects(transcribe(), /invalid response/);
  assert.equal(calls, 5);
});

test('relay forwards the multipart body and preserves upstream status', async t => {
  const { default: relay } = await import('../netlify/edge-functions/transcribe.js');
  const form = new FormData();
  form.append('file', new Blob(['sample audio'], { type: 'audio/wav' }), 'recording.wav');
  const request = new Request('https://cue.example/api/transcribe', { method: 'POST', body: form });
  t.mock.method(global, 'fetch', async (url, options) => {
    assert.equal(url, 'https://free-whisper-transcription.lagerlof-arthur.workers.dev/');
    assert.equal(options.headers['Content-Type'], request.headers.get('content-type'));
    const forwarded = new Request(url, options);
    const forwardedForm = await forwarded.formData();
    assert.equal(await forwardedForm.get('file').text(), 'sample audio');
    return new Response('limited', { status: 429 });
  });
  const response = await relay(request);
  assert.equal(response.status, 429);
  assert.equal(await response.text(), 'limited');
});
