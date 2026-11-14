const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function createConnection(onWrite) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'bluetooth.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const timers = new Map();
  const frames = [];
  let time = 0;
  let nextTimer = 1;
  let listener;
  const clock = {
    setTimeout(callback, delay) {
      const id = nextTimer++;
      timers.set(id, { callback, due: time + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  const notifyAck = (frame, status = 0) => {
    const bytes = Uint8Array.from([0x42, 0x4d, 1, 3, frame[4], frame[5], 0, 1, 1, status]);
    listener({ target: { value: new DataView(bytes.buffer) } });
  };
  const tx = {
    startNotifications: async () => tx,
    addEventListener: (type, callback) => { listener = callback; },
  };
  const rx = {
    writeValueWithoutResponse: async data => {
      const frame = Uint8Array.from(data);
      frames.push(frame);
      await onWrite(frame, { frames, notifyAck, clock });
    },
    writeValue: async () => {},
  };
  const service = { getCharacteristic: async uuid => uuid.includes('0002-') ? rx : tx };
  const server = { getPrimaryService: async () => service };
  const device = { name: 'Bangle.js test', gatt: { connected: true, connect: async () => server }, addEventListener: () => {} };
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, TextEncoder, TextDecoder, Uint8Array, DataView, Map, Set,
    navigator: { bluetooth: { requestDevice: async () => device } },
    window: clock,
  });
  async function run(promise) {
    let done = false;
    promise.then(() => { done = true; }, () => { done = true; });
    for (let steps = 0; steps < 2000 && !done; steps++) {
      await new Promise(resolve => setImmediate(resolve));
      if (done) break;
      const next = [...timers.entries()].sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) throw new Error('Delivery stalled without a timer');
      timers.delete(next[0]);
      time = next[1].due;
      next[1].callback();
    }
    if (!done) throw new Error('Delivery did not settle');
    return promise;
  }
  return { connection: new exports.BangleConnection(), frames, timers, run, now: () => time };
}

test('long transfers can be acknowledged after the original timeout', async () => {
  const harness = createConnection(async (frame, { notifyAck }) => {
    if (frame[6] === frame[7] - 1) notifyAck(frame);
  });
  await harness.connection.connect();
  await harness.run(harness.connection.sendDisplayText('x'.repeat(1500)));
  assert.equal(harness.frames.length, 150);
  assert.ok(harness.now() > 2500);
  assert.equal(harness.timers.size, 0);
});

test('late acknowledgement during a retry stops retransmission', async () => {
  const harness = createConnection(async (frame, { frames, notifyAck }) => {
    if (frames.length === 4) notifyAck(frame);
  });
  await harness.connection.connect();
  await harness.run(harness.connection.sendDisplayText('x'.repeat(30)));
  assert.equal(harness.frames.length, 4);
  assert.equal(harness.timers.size, 0);
});

test('a delayed acknowledgement after the last chunk is accepted', async () => {
  const harness = createConnection(async (frame, { notifyAck, clock }) => {
    if (frame[6] === frame[7] - 1) clock.setTimeout(() => notifyAck(frame), 9000);
  });
  await harness.connection.connect();
  await harness.run(harness.connection.sendDisplayText('hello'));
  assert.equal(harness.frames.length, 1);
  assert.equal(harness.timers.size, 0);
});

test('missing acknowledgement fails after three attempts and cleans up', async () => {
  const harness = createConnection(async () => {});
  await harness.connection.connect();
  await assert.rejects(harness.run(harness.connection.sendDisplayText('hello')), /after 3 delivery attempts/);
  assert.equal(harness.frames.length, 3);
  assert.equal(harness.connection.pendingAcks.size, 0);
  assert.equal(harness.timers.size, 0);
});

test('watch rejection and write failures are reported without leaving acknowledgement waiters', async () => {
  const rejected = createConnection(async (frame, { notifyAck }) => notifyAck(frame, 1));
  await rejected.connection.connect();
  await assert.rejects(rejected.run(rejected.connection.sendDisplayText('hello')), /Watch rejected the result/);
  assert.equal(rejected.connection.pendingAcks.size, 0);
  const failed = createConnection(async () => { throw new Error('write failed'); });
  await failed.connection.connect();
  await assert.rejects(failed.run(failed.connection.sendDisplayText('hello')), /write failed/);
  assert.equal(failed.connection.pendingAcks.size, 0);
  assert.equal(failed.timers.size, 0);
});
