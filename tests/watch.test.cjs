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
  const timers = new Map();
  let now = 10000;
  let nextTimer = 1;
  let fontSize = 12;
  const context = {
    Date: { now: () => now },
    setTimeout: (callback, delay) => {
      const id = nextTimer++;
      timers.set(id, { callback, due: now + delay });
      return id;
    },
    clearTimeout: id => timers.delete(id),
    escape: undefined,
    unescape: undefined,
    encodeURIComponent: undefined,
    decodeURIComponent: undefined,
    encodeURI: undefined,
    decodeURI: undefined,
    require: () => ({ read: key => stored[key], write: (key, value) => { stored[key] = value; } }),
    LoopbackA: { setConsole: () => {} },
    Bangle: {
      on: (name, fn) => { (listeners[name] ||= []).push(fn); },
      removeListener: (name, fn) => { listeners[name] = (listeners[name] || []).filter(listener => listener !== fn); },
      setUI: ui => { context.ui = ui; },
      showClock: () => {},
      getWidth: () => 176,
      getHeight: () => 176,
      buzz: () => {},
    },
    Bluetooth: {
      on: (name, fn) => { (uartListeners[name] ||= []).push(fn); },
      removeListener: (name, fn) => { uartListeners[name] = (uartListeners[name] || []).filter(listener => listener !== fn); },
      println: value => writes.push(value),
      write: value => writes.push(value),
    },
    g: {
      getWidth: () => 176,
      getHeight: () => 176,
      getFontHeight: () => fontSize,
      stringWidth: value => String(value).length * fontSize * 0.55,
      clear: () => {},
      setFont: (name, size) => { fontSize = size || 12; },
      setFontAlign: () => {},
      setColor: () => {},
      fillRect: () => {},
      fillCircle: () => {},
      drawCircle: () => {},
      drawRect: () => {},
      drawLine: () => {},
      drawString: value => drawings.push(String(value)),
    },
    load: () => {},
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'watch', 'bangle-app.js'), 'utf8'), context, { filename: 'bangle-app.js' });
  writes.length = 0;
  return {
    context, listeners, uartListeners, writes, stored, drawings,
    advance: ms => {
      const target = now + ms;
      while (true) {
        const due = [...timers.entries()].filter(([, timer]) => timer.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
        if (!due) break;
        const [id, timer] = due;
        timers.delete(id);
        now = timer.due;
        timer.callback();
      }
      now = target;
    },
  };
}

function frame(type, id, index, count, payload) {
  return String.fromCharCode(0x42, 0x4d, 1, type, id & 255, id >> 8, index, count, payload.length, ...payload);
}

function sendDocument(watch, document, id = 42) {
  const bytes = Array.from(new TextEncoder().encode(JSON.stringify(document)));
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 10) chunks.push(bytes.slice(i, i + 10));
  assert.ok(chunks.length <= 245, 'synthetic document fits the watch protocol limit');
  chunks.forEach((chunk, index) => watch.uartListeners.data[0](frame(2, id, index, chunks.length, chunk)));
}

test('ready screen shows tap and hold instructions', () => {
  const watch = loadWatch();
  assert.ok(watch.drawings.includes('Cue.'));
  assert.ok(watch.drawings.includes('cue_logo.png'));
  assert.ok(watch.drawings.includes('Tap for last 10 seconds'));
  assert.ok(watch.drawings.includes('Hold for a longer'));
  assert.ok(watch.drawings.includes('recording'));
});

test('short tap sends exactly one existing trigger and never becomes a long press', () => {
  const watch = loadWatch();
  watch.listeners.drag[0]({ b: true, x: 88, y: 73 });
  watch.advance(449);
  watch.listeners.drag[0]({ b: false, x: 88, y: 73 });
  watch.listeners.touch[0](1, { x: 88, y: 73 });
  assert.equal(watch.writes.length, 1);
  assert.equal(watch.writes[0].charCodeAt(3), 1);
  assert.equal(watch.writes[0].charCodeAt(9), 1);
  assert.ok(watch.drawings.includes('THINKING...'));
});

test('long press shows recording state and sends one trigger on release', () => {
  const watch = loadWatch();
  watch.listeners.drag[0]({ b: true, x: 88, y: 73 });
  watch.advance(450);
  assert.ok(watch.drawings.includes('RECORDING'));
  assert.ok(watch.drawings.includes('Release to finish'));
  watch.listeners.drag[0]({ b: false, x: 88, y: 73 });
  watch.listeners.touch[0](1, { x: 88, y: 73 });
  assert.equal(watch.writes.length, 1);
  assert.equal(watch.writes[0].charCodeAt(3), 1);
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

test('slow transfers remain available while chunks are still arriving', () => {
  const watch = loadWatch();
  const emit = data => watch.uartListeners.data[0](data);
  emit(frame(2, 44, 0, 3, [65]));
  watch.advance(9000);
  emit(frame(2, 44, 1, 3, [66]));
  watch.advance(9000);
  emit(frame(2, 44, 2, 3, [67]));
  assert.equal(watch.stored['cue-memory.txt'], 'ABC');
  assert.equal(watch.writes[0].charCodeAt(9), 0);
});

test('invalid UTF-8 is rejected on repeated delivery', () => {
  const watch = loadWatch();
  const invalid = frame(2, 45, 0, 1, [255]);
  watch.uartListeners.data[0](invalid);
  watch.uartListeners.data[0](invalid);
  assert.equal(watch.writes.length, 2);
  assert.equal(watch.writes[0].charCodeAt(9), 1);
  assert.equal(watch.writes[1].charCodeAt(9), 1);
});

test('UTF-8 documents larger than the emulator apply argument limit decode without browser globals', () => {
  const watch = loadWatch();
  const text = '🦊'.repeat(600);
  const bytes = Array.from(new TextEncoder().encode(text));
  assert.ok(bytes.length > 256 && bytes.length <= 2450);
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 10) chunks.push(bytes.slice(i, i + 10));
  chunks.forEach((chunk, index) => watch.uartListeners.data[0](frame(2, 43, index, chunks.length, chunk)));
  assert.equal(watch.stored['cue-memory.txt'], text);
  assert.ok(watch.writes.some(value => value.charCodeAt(3) === 3 && value.charCodeAt(9) === 0));
});

test('display documents preserve pages and image placeholders while scrolling', () => {
  const watch = loadWatch();
  const document = {
    schema: 'cue.display', version: 1, id: 'watch-test', title: 'Demo results',
    source: { app: 'web', name: 'Mock web' }, state: 'ready',
    pages: [
      { id: 'page-one', title: 'Research', elements: [
        ...Array.from({ length: 20 }, (_, index) => ({ type: 'text', text: `Paragraph ${index + 1}: readable result text.` })),
        { type: 'image', assetId: 'image-one', fit: 'contain' },
        { type: 'action', actionId: 'open-one', label: 'Open result' },
      ] },
      { id: 'page-two', title: 'Page two', elements: [{ type: 'text', text: 'Second page content.' }] },
      { id: 'page-three', title: 'Page three', elements: [{ type: 'text', text: 'Third page content.' }] },
    ],
    actions: [{ id: 'open-one', toolId: 'web.get_article', arguments: { articleId: 'web-1' }, label: 'Open result' }],
    assets: [{ id: 'image-one', mimeType: 'image/svg+xml', alt: 'Research diagram' }],
  };
  sendDocument(watch, document, 55);
  assert.equal(watch.stored['cue-memory.txt'], JSON.stringify(document));
  assert.ok(watch.drawings.includes('Demo results'));
  assert.ok(watch.drawings.includes('Research'));
  assert.ok(watch.drawings.some(line => line.includes('Paragraph 1')));

  watch.drawings.length = 0;
  watch.listeners.drag[0]({ b: true, x: 88, y: 100 });
  watch.listeners.drag[0]({ b: true, x: 88, y: 40 });
  watch.listeners.drag[0]({ b: false, x: 88, y: 40 });
  assert.ok(watch.drawings.some(line => line.includes('Paragraph 2')), JSON.stringify(watch.drawings));
  assert.ok(!watch.drawings.some(line => line.includes('Paragraph 1')));

  watch.context.ui.swipe(1);
  assert.ok(watch.drawings.includes('Page two'));
  assert.ok(watch.drawings.includes('2 / 3'));
  watch.context.ui.swipe(1);
  assert.ok(watch.drawings.includes('Page three'));
  watch.context.ui.swipe(-1);
  assert.ok(watch.drawings.includes('Page two'));
});

test('new display documents replace old results and actions', () => {
  const watch = loadWatch();
  sendDocument(watch, {
    schema: 'cue.display', version: 1, id: 'old-results', title: 'Old results',
    source: { app: 'web', name: 'Mock web' }, state: 'ready',
    pages: [{ id: 'old-page', title: 'Old page', elements: [
      { type: 'text', text: 'Stale result content.' },
      { type: 'action', actionId: 'old-action', label: 'Open stale result' },
    ] }],
    actions: [{ id: 'old-action', toolId: 'web.get_article', arguments: {} }],
    assets: [],
  }, 56);

  watch.drawings.length = 0;
  watch.writes.length = 0;
  sendDocument(watch, {
    schema: 'cue.display', version: 1, id: 'new-results', title: 'Newest results',
    source: { app: 'web', name: 'Mock web' }, state: 'ready',
    pages: [{ id: 'new-page', title: 'New page', elements: [{ type: 'text', text: 'Current result content.' }] }],
    actions: [], assets: [],
  }, 57);

  assert.ok(watch.drawings.includes('Newest results'));
  assert.ok(watch.drawings.some(line => line.includes('Current result')));
  assert.ok(!watch.drawings.some(line => /Old results|Old page|Stale result|Open stale/.test(line)));
  assert.ok(!watch.drawings.includes('2 / 2'));
  watch.writes.length = 0;
  watch.listeners.touch[0](1, { x: 40, y: 70 });
  assert.equal(watch.writes.length, 0, 'actions from the previous result are no longer active');
});

test('result actions, confirmation buttons, and logo navigation remain explicit', () => {
  const watch = loadWatch();
  sendDocument(watch, {
    schema: 'cue.display', version: 1, id: 'action-test', title: 'Action',
    source: { app: 'web', name: 'Mock web' }, state: 'ready',
    pages: [{ id: 'one', title: 'Result', elements: [{ type: 'action', actionId: 'open_🦊', label: 'Open result' }] }],
    actions: [{ id: 'open_🦊', toolId: 'web.get_article', arguments: {} }],
    assets: [],
  }, 61);
  watch.listeners.touch[0](1, { x: 40, y: 70 });
  const actionFrame = watch.writes.find(value => value.charCodeAt(3) === 4);
  assert.ok(actionFrame);
  assert.equal(new TextDecoder().decode(Uint8Array.from(actionFrame.slice(9), character => character.charCodeAt(0))), 'open_🦊');

  watch.writes.length = 0;
  sendDocument(watch, {
    schema: 'cue.display', version: 1, id: 'confirm-test', title: 'Confirmation required',
    source: { app: 'cue', name: 'Cue' }, state: 'confirmation_required',
    pages: [{ id: 'confirm', elements: [{ type: 'text', text: 'Create a calendar event?' }] }],
    actions: [], assets: [],
  }, 62);
  watch.writes.length = 0;
  watch.context.ui.swipe(1);
  assert.equal(watch.writes.length, 0, 'page navigation never confirms an action');
  watch.listeners.touch[0](1, { x: 12, y: 12 });
  assert.ok(watch.drawings.includes('Hold for a longer'));
  assert.equal(watch.writes.length, 0, 'the top-left logo only returns home');

  sendDocument(watch, {
    schema: 'cue.display', version: 1, id: 'confirm-test-2', title: 'Confirmation required',
    source: { app: 'cue', name: 'Cue' }, state: 'confirmation_required',
    pages: [{ id: 'confirm', elements: [] }], actions: [], assets: [],
  }, 63);
  watch.listeners.touch[0](1, { x: 20, y: 143 });
  const cancelFrame = watch.writes.find(value => value.charCodeAt(3) === 4);
  assert.equal(new TextDecoder().decode(Uint8Array.from(cancelFrame.slice(9), character => character.charCodeAt(0))), '__cue_cancel');
  watch.writes.length = 0;

  sendDocument(watch, {
    schema: 'cue.display', version: 1, id: 'confirm-test-3', title: 'Confirmation required',
    source: { app: 'cue', name: 'Cue' }, state: 'confirmation_required',
    pages: [{ id: 'confirm', elements: [] }], actions: [], assets: [],
  }, 64);
  watch.listeners.touch[0](1, { x: 150, y: 143 });
  const confirmFrame = watch.writes.find(value => value.charCodeAt(3) === 4);
  assert.equal(new TextDecoder().decode(Uint8Array.from(confirmFrame.slice(9), character => character.charCodeAt(0))), '__cue_confirm');
});

test('empty, error, and success Display Document states have consistent screens', () => {
  const watch = loadWatch();
  let id = 100;
  for (const [state, label] of [['empty', 'NO RESULTS'], ['error', 'ERROR'], ['success', 'SUCCESS'], ['loading', 'THINKING...']]) {
    sendDocument(watch, {
      schema: 'cue.display', version: 1, id: `state-${state}`, title: label,
      source: { app: 'cue', name: 'Cue' }, state,
      pages: [{ id: state, elements: [{ type: 'text', text: `${label} detail.` }] }],
      actions: [], assets: [],
    }, id++);
    assert.ok(watch.drawings.includes(label));
  }
});

test('clarification screen offers tap-to-answer using the recording trigger', () => {
  const watch = loadWatch();
  sendDocument(watch, {
    schema: 'cue.display', version: 1, id: 'clarification-test', title: 'Clarification needed',
    source: { app: 'cue', name: 'Cue' }, state: 'clarification_required',
    pages: [{ id: 'clarification', elements: [{ type: 'text', text: 'Which card should I use?' }] }],
    actions: [], assets: [],
  }, 110);
  assert.ok(watch.drawings.includes('Tap to answer'));
  watch.writes.length = 0;
  watch.listeners.touch[0](1, { x: 88, y: 80 });
  assert.equal(watch.writes.length, 1);
  assert.equal(watch.writes[0].charCodeAt(3), 1);
  assert.equal(watch.writes[0].charCodeAt(9), 1);
});
