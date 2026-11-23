const test = require('node:test');
const assert = require('node:assert/strict');

function fakeGpu() {
  const dispatches = [];
  let destroyed = 0;
  const pass = {
    setPipeline() {},
    setBindGroup() {},
    dispatchWorkgroups(x, y) { dispatches.push([x, y]); },
    end() {},
  };
  const device = {
    createShaderModule: () => ({}),
    createComputePipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }),
    createBuffer: () => ({}),
    createBindGroup: () => ({}),
    createCommandEncoder: () => ({ beginComputePass: () => pass, finish: () => ({}) }),
    queue: { writeBuffer() {}, submit() {}, onSubmittedWorkDone: async () => {} },
    destroy() { destroyed++; },
  };
  return { gpu: { requestAdapter: async () => ({ requestDevice: async () => device }) }, device, dispatches, destroyed: () => destroyed };
}

test('GPU benchmark uses the measured threshold and cleans up the device', async t => {
  const { assessGpu } = await import('../src/services/deviceDefaults.js');
  const original = Object.getOwnPropertyDescriptor(global, 'GPUBufferUsage');
  Object.defineProperty(global, 'GPUBufferUsage', { value: { STORAGE: 1, COPY_DST: 2 }, configurable: true });
  t.after(() => {
    if (original) Object.defineProperty(global, 'GPUBufferUsage', original);
    else delete global.GPUBufferUsage;
  });
  for (const [milliseconds, preferLocal] of [[250, true], [251, false]]) {
    const fake = fakeGpu();
    const times = [1000, 1000 + milliseconds];
    const result = await assessGpu(fake.gpu, () => times.shift());
    assert.equal(result.preferLocal, preferLocal);
    assert.match(result.reason, new RegExp(`${milliseconds}\\.0 ms`));
    assert.equal(fake.dispatches.length, 9);
    assert.ok(fake.dispatches.every(([x, y]) => x === 32 && y === 32));
    assert.equal(fake.destroyed(), 1);
  }
});

test('missing, software, and failing WebGPU select cloud with a reason', async () => {
  const { assessGpu } = await import('../src/services/deviceDefaults.js');
  assert.match((await assessGpu(undefined)).reason, /unavailable/);
  const noAdapter = await assessGpu({ requestAdapter: async () => null });
  assert.equal(noAdapter.preferLocal, false);
  assert.match(noAdapter.reason, /No WebGPU adapter/);
  const software = await assessGpu({ requestAdapter: async () => ({ info: { isFallbackAdapter: true } }) });
  assert.equal(software.preferLocal, false);
  assert.match(software.reason, /software/);
  const failure = await assessGpu({ requestAdapter: async () => { throw new Error('device lost'); } });
  assert.equal(failure.preferLocal, false);
  assert.match(failure.reason, /device lost/);
});

test('a stalled GPU assessment times out and releases the device', async t => {
  const { assessGpu } = await import('../src/services/deviceDefaults.js');
  const fake = fakeGpu();
  fake.device.createComputePipelineAsync = () => new Promise(() => {});
  const schedule = global.setTimeout;
  t.mock.method(global, 'setTimeout', callback => schedule(callback, 0));
  const result = await assessGpu(fake.gpu);
  assert.equal(result.preferLocal, false);
  assert.match(result.reason, /timed out/);
  assert.equal(fake.destroyed(), 1);
});
