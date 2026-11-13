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
    },
    g: {
      getWidth: () => 176, getHeight: () => 176, clear: () => {},
      setFont: () => {}, setFontAlign: () => {}, drawString: value => drawings.push(value),
    },
    load: () => {},
  };
  vm.createContext(context);
  for (const file of ['boot.js', 'bangle-app.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'watch', file), 'utf8'), context, { filename: file });
  }
  return {
    context, listeners, uartListeners, writes, stored, drawings,
    advance: ms => { now += ms; },
  };
}

function frame(type, id, index, count, payload) {
  return String.fromCharCode(0x42, 0x4d, 1, type, id & 255, id >> 8, index, count, payload.length, ...payload);
}

test('boot twist and app tap share cooldown-protected trigger function', () => {
  const watch = loadWatch();
  watch.listeners.twist[0]();
  watch.listeners.touch[0]();
  assert.equal(watch.writes.length, 1);
  assert.equal(watch.writes[0].charCodeAt(3), 1);
  assert.equal(watch.writes[0].charCodeAt(9), 0);
  watch.advance(2501);
  watch.listeners.touch[0]();
  assert.equal(watch.writes.length, 2);
  assert.equal(watch.writes[1].charCodeAt(9), 1);
});

test('display protocol reassembles UTF-8 chunks, acknowledges and persists latest text', () => {
  const watch = loadWatch();
  const bytes = Array.from(new TextEncoder().encode('A memória é importante e muito longa.'));
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 10) chunks.push(bytes.slice(i, i + 10));
  const emit = data => watch.uartListeners.data[0](data);
  for (let i = chunks.length - 1; i >= 0; i--) emit(frame(2, 42, i, chunks.length, chunks[i]));
  assert.equal(watch.stored['bangle-memory.txt'], 'A memória é importante e muito longa.');
  assert.equal(watch.writes.length, 1);
  assert.equal(watch.writes[0].charCodeAt(3), 3);
  assert.ok(watch.drawings.some(line => line.includes('memória')));
  emit(frame(2, 42, 0, chunks.length, chunks[0]));
  assert.equal(watch.writes.length, 1, 'duplicate should not be acknowledged twice');
});
