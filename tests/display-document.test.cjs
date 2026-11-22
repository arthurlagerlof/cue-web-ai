const test = require('node:test');
const assert = require('node:assert/strict');

test('parseDisplayDocument recognizes valid display documents', async () => {
  const { parseDisplayDocument } = await import('../src/display/document.js');
  const document = {
    schema: 'cue.display',
    version: 1,
    id: 'dots3-answer',
    title: 'Answer',
    source: { app: 'openrouter', name: 'Dots3' },
    state: 'ready',
    pages: [{ id: 'answer-page', elements: [{ type: 'text', text: 'Formatted answer.' }] }],
    actions: [],
    assets: [],
  };

  assert.deepEqual(parseDisplayDocument(JSON.stringify(document)), document);
});

test('parseDisplayDocument leaves ordinary direct answers as text', async () => {
  const { parseDisplayDocument } = await import('../src/display/document.js');

  assert.equal(parseDisplayDocument('A concise answer.'), null);
  assert.equal(parseDisplayDocument(JSON.stringify({ kind: 'answer', text: 'Not a display document.' })), null);
});

test('parseDisplayDocument rejects malformed cue.display documents', async () => {
  const { parseDisplayDocument } = await import('../src/display/document.js');

  assert.throws(() => parseDisplayDocument(JSON.stringify({ schema: 'cue.display' })), /Invalid Cue Display Document/);
});
