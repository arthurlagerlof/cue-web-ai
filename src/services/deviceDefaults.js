const MAX_GPU_TIME_MS = 250;
const GPU_CHECK_TIMEOUT_MS = 5000;
const MATRIX_SIZE = 256;
const DISPATCHES = 8;

const shader = `
@group(0) @binding(0) var<storage, read> a: array<f32>;
@group(0) @binding(1) var<storage, read> b: array<f32>;
@group(0) @binding(2) var<storage, read_write> output: array<f32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let row = id.y;
  let column = id.x;
  var sum = 0.0;
  for (var k = 0u; k < 256u; k++) {
    sum += a[row * 256u + k] * b[k * 256u + column];
  }
  output[row * 256u + column] = sum;
}`;

export async function assessGpu(gpu, now = () => performance.now()) {
  if (!gpu) return { preferLocal: false, reason: 'WebGPU is unavailable.' };
  let device;
  let expired = false;
  let timer;
  const probe = async () => {
    try {
      const adapter = await gpu.requestAdapter();
      if (expired) return;
      if (!adapter) return { preferLocal: false, reason: 'No WebGPU adapter is available.' };
      if (adapter.info?.isFallbackAdapter) return { preferLocal: false, reason: 'WebGPU uses a software adapter.' };
      device = await adapter.requestDevice();
      if (expired) return;
      const pipeline = await device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module: device.createShaderModule({ code: shader }), entryPoint: 'main' },
      });
      if (expired) return;
      const bytes = MATRIX_SIZE * MATRIX_SIZE * 4;
      const a = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      const b = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      const output = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE });
      const input = new Float32Array(MATRIX_SIZE * MATRIX_SIZE).fill(0.125);
      device.queue.writeBuffer(a, 0, input);
      device.queue.writeBuffer(b, 0, input);
      const bindings = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: a } },
          { binding: 1, resource: { buffer: b } },
          { binding: 2, resource: { buffer: output } },
        ],
      });
      const submit = count => {
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindings);
        for (let i = 0; i < count; i++) pass.dispatchWorkgroups(MATRIX_SIZE / 8, MATRIX_SIZE / 8);
        pass.end();
        device.queue.submit([encoder.finish()]);
        return device.queue.onSubmittedWorkDone();
      };
      await submit(1);
      if (expired) return;
      const start = now();
      await submit(DISPATCHES);
      const elapsed = now() - start;
      if (!Number.isFinite(elapsed) || elapsed < 0) throw new Error('Invalid GPU benchmark timing.');
      return {
        preferLocal: elapsed <= MAX_GPU_TIME_MS,
        reason: `GPU benchmark: ${elapsed.toFixed(1)} ms (local threshold: ${MAX_GPU_TIME_MS} ms).`,
      };
    } finally {
      device?.destroy();
    }
  };
  try {
    return await Promise.race([
      probe(),
      new Promise(resolve => {
        timer = setTimeout(() => {
          expired = true;
          device?.destroy();
          resolve({ preferLocal: false, reason: 'GPU assessment timed out.' });
        }, GPU_CHECK_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    return { preferLocal: false, reason: `GPU assessment failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(timer);
  }
}
