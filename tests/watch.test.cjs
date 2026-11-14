const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function loadWatch() {
  const listeners = {};
  const uartListeners = {};
  const writes = [];
  const stored = {};
  const drawings = [];
  let now = 10000;
  const context = {
    Date: { now: () => now },
    setTimeout: () => 1,
    clearTimeout: () => {},
    require: () => ({ read: key => stored[key], write: (key, value) => { stored[key] = value; } }),
    LoopbackA: { setConsole: () => {} },
    Bangle: {
      on: (name, fn) => { (listeners[name] ||= []).push(fn); },
      setUI: ui => { context.ui = ui; },
      getWidth: () => 176,
      getHeight: () => 176,
      buzz: () => {},
    },
    Bluetooth: {
      on: (name, fn) => { (uartListeners[name] ||= []).push(fn); },
      println: value => writes.push(value),
      write: value => writes.push(value),
    },
    g: {
      getWidth: () => 176, getHeight: () => 176, clear: () => {},
      setFont: () => {}, setFontAlign: () => {}, setColor: () => {}, fillRect: () => {}, drawString: value => drawings.push(value),
    },
    load: () => {},
  };
  vm.createContext(context);
  for (const file of ['bangle-app.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'watch', file), 'utf8'), context, { filename: file });
  }
  writes.length = 0;
  return {
    context, listeners, uartListeners, writes, stored, drawings,
    advance: ms => { now += ms; },
  };
}

function frame(type, id, index, count, payload) {
  return String.fromCharCode(0x42, 0x4d, 1, type, id & 255, id >> 8, index, count, payload.length, ...payload);
}

test('watch hold-to-trigger sends one cooldown-protected request', () => {
  const watch = loadWatch();
  watch.listeners.drag[0]({ b: true, y: 140 });
  watch.listeners.drag[0]({ b: false, y: 140 });
  assert.equal(watch.writes.length, 1);
  assert.equal(watch.writes[0].charCodeAt(3), 1);
  assert.equal(watch.writes[0].charCodeAt(9), 1);
  watch.advance(2501);
  watch.listeners.drag[0]({ b: true, y: 140 });
  watch.listeners.drag[0]({ b: false, y: 140 });
  assert.equal(watch.writes.length, 2);
});

test('display protocol reassembles UTF-8 chunks, acknowledges and persists latest text', () => {
  const watch = loadWatch();
  const bytes = Array.from(new TextEncoder().encode('A memória é importante e muito longa.'));
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 10) chunks.push(bytes.slice(i, i + 10));
  const emit = data => watch.uartListeners.data[0](data);
  for (let i = chunks.length - 1; i >= 0; i--) emit(frame(2, 42, i, chunks.length, chunks[i]));
  assert.equal(watch.stored['cue-memory.txt'], 'A memória é importante e muito longa.');
  assert.equal(watch.writes.length, 1);
  assert.equal(watch.writes[0].charCodeAt(3), 3);
  assert.ok(watch.drawings.some(line => line.includes('memória')));
  emit(frame(2, 42, 0, chunks.length, chunks[0]));
  assert.equal(watch.writes.length, 2, 'duplicate delivery is acknowledged without reprocessing');
  assert.equal(watch.writes[1].charCodeAt(3), 3);
});

test('watch renders Cue Display Document content, image fallbacks, pagination, and action references', () => {
  const watch = loadWatch();
  const document = {
    schema: 'cue.display', version: 1, id: 'watch-test', title: 'Demo results',
    source: { app: 'web', name: 'Mock web' }, state: 'ready',
    pages: [{ id: 'page-one', title: 'Research', elements: [
      { type: 'text', text: 'Readable result text '.repeat(35), role: 'body' },
      { type: 'image', assetId: 'image-one', fit: 'contain' },
      { type: 'action', actionId: 'open-one', label: 'Open result' },
    ] }],
    actions: [{ id: 'open-one', toolId: 'web.get_article', arguments: { articleId: 'web-1' }, label: 'Open result' }],
    assets: [{ id: 'image-one', mimeType: 'image/svg+xml', alt: 'Research diagram' }],
  };
  const bytes = Array.from(new TextEncoder().encode(JSON.stringify(document)));
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 10) chunks.push(bytes.slice(i, i + 10));
  assert.ok(chunks.length <= 245);
  const emit = data => watch.uartListeners.data[0](data);
  chunks.forEach((chunk, index) => emit(frame(2, 55, index, chunks.length, chunk)));
  assert.equal(watch.stored['cue-memory.txt'], JSON.stringify(document));
  assert.ok(watch.drawings.some(line => line.includes('Demo results')));
  assert.ok(watch.drawings.some(line => line.includes('Tap to: Open result')));
  watch.context.ui.swipe(1);
  assert.ok(watch.drawings.some(line => line.startsWith('Page 2/')));
  for (let page = 0; page < 20; page++) watch.context.ui.swipe(1);
  assert.ok(watch.drawings.some(line => line.includes('Research')));
  assert.ok(watch.drawings.some(line => line.includes('diagram')));
  watch.listeners.touch[0](1, { x: 12, y: 40 });
  const actionFrame = watch.writes.find(value => value.charCodeAt(3) === 4);
  assert.ok(actionFrame);
  assert.equal(new TextDecoder().decode(Uint8Array.from(actionFrame.slice(9), character => character.charCodeAt(0))), 'open-one');
});
