export const GEMMA_MODEL_ASSET = 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/refs%2Fpr%2F59/gemma-4-E2B-it-web.task';
export const GEMMA_WASM_ROOT = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-genai@0.10.30/wasm';
export const GEMMA_HARDWARE_POLICY = Object.freeze({ minimumDeviceMemoryGiB: 8, minimumHardwareConcurrency: 8 });

/** @typedef {{ status: string, progress?: { reason?: string, message?: string, generatedCharacters?: number, done?: boolean } }} GemmaState */

function mobileStatus(navigatorLike) {
  if (typeof navigatorLike.userAgentData?.mobile === 'boolean') return navigatorLike.userAgentData.mobile;
  const userAgent = navigatorLike.userAgent;
  if (typeof userAgent !== 'string' || !userAgent) return undefined;
  return /android|iphone|ipad|ipod|mobile/i.test(userAgent);
}

export async function detectGemmaEligibility(navigatorLike = globalThis.navigator, policy = GEMMA_HARDWARE_POLICY) {
  if (!navigatorLike?.gpu || typeof navigatorLike.gpu.requestAdapter !== 'function') {
    return { status: 'unsupported', reason: 'WebGPU is unavailable.' };
  }
  const memory = navigatorLike.deviceMemory;
  const threads = navigatorLike.hardwareConcurrency;
  if (!Number.isFinite(memory) || !Number.isFinite(threads)) {
    return { status: 'ineligible', reason: 'Browser hardware capability estimates are unavailable.' };
  }
  if (memory < policy.minimumDeviceMemoryGiB || threads < policy.minimumHardwareConcurrency) {
    return { status: 'ineligible', reason: 'This device is below the optional model memory or CPU-thread threshold.' };
  }
  const mobile = mobileStatus(navigatorLike);
  if (mobile !== false) {
    return { status: 'ineligible', reason: 'A desktop-class browser could not be established.' };
  }
  let adapter;
  try {
    adapter = await navigatorLike.gpu.requestAdapter();
  } catch {
    return { status: 'ineligible', reason: 'WebGPU adapter initialization failed.' };
  }
  if (!adapter) return { status: 'ineligible', reason: 'No usable WebGPU adapter is available.' };
  const limits = adapter.limits;
  if (!limits || !Number.isFinite(limits.maxBufferSize) || limits.maxBufferSize <= 0
    || !Number.isFinite(limits.maxStorageBufferBindingSize) || limits.maxStorageBufferBindingSize <= 0) {
    return { status: 'ineligible', reason: 'The WebGPU adapter does not expose the limits required for runtime compatibility checks.' };
  }
  if (typeof adapter.requestDevice !== 'function') {
    return { status: 'ineligible', reason: 'The WebGPU adapter cannot create a device for local inference.' };
  }
  let device;
  try {
    device = await adapter.requestDevice();
  } catch {
    return { status: 'ineligible', reason: 'The WebGPU adapter could not create a usable device.' };
  }
  if (!device?.limits || typeof device.destroy !== 'function') {
    device?.destroy?.();
    return { status: 'ineligible', reason: 'The created WebGPU device does not expose compatible limits.' };
  }
  device.destroy();
  return { status: 'eligible', reason: 'The device meets the configured local capability gate.' };
}

function createWorkerRuntime(onStatus) {
  const worker = new Worker(new URL('./gemma.worker.ts', import.meta.url), { type: 'module' });
  let nextId = 0;
  let activeRequestId;
  const pending = new Map();
  worker.onmessage = event => {
    const message = event.data;
    if (message.type === 'status') {
      onStatus(message.status, message.progress);
      return;
    }
    const task = pending.get(message.id);
    if (!task) return;
    if (message.type === 'progress') {
      task.onProgress?.(message.progress);
      return;
    }
    pending.delete(message.id);
    if (message.type === 'error') task.reject(new Error(message.error));
    else task.resolve(message.text);
  };
  worker.onerror = event => {
    const error = new Error(event.message || 'Gemma inference worker failed.');
    for (const task of pending.values()) task.reject(error);
    pending.clear();
    onStatus('error', { message: error.message });
  };
  return {
    initialize: () => new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      worker.postMessage({ type: 'initialize', id });
    }),
    generate: (prompt, onProgress) => new Promise((resolve, reject) => {
      const id = ++nextId;
      activeRequestId = id;
      pending.set(id, { resolve, reject, onProgress });
      worker.postMessage({ type: 'generate', id, prompt });
    }),
    cancel() {
      worker.terminate();
      const task = pending.get(activeRequestId);
      if (task) task.reject(new DOMException('Gemma generation was cancelled.', 'AbortError'));
      pending.clear();
    },
    dispose() {
      worker.postMessage({ type: 'dispose' });
      worker.terminate();
      for (const task of pending.values()) task.reject(new Error('Gemma worker was disposed.'));
      pending.clear();
    },
  };
}

/**
 * @param {{
 *   detectEligibility?: (navigatorLike?: Navigator, policy?: typeof GEMMA_HARDWARE_POLICY) => Promise<{ status: string, reason?: string }>,
 *   runtimeFactory?: (onStatus: (status: string, progress?: GemmaState['progress']) => void) => {
 *     initialize: () => Promise<void>,
 *     generate: (prompt: string, onProgress?: (progress: GemmaState['progress']) => void) => Promise<string>,
 *     cancel: () => void,
 *     dispose: () => void
 *   },
 *   onState?: (state: GemmaState) => void,
 *   policy?: typeof GEMMA_HARDWARE_POLICY
 * }} [options]
 */
export function createGemmaService({
  detectEligibility = detectGemmaEligibility,
  runtimeFactory = createWorkerRuntime,
  onState = () => {},
  policy = GEMMA_HARDWARE_POLICY,
} = {}) {
  let state = { status: 'not_checked' };
  let runtime;
  let preloadPromise;
  let generation = 0;
  const update = (status, progress) => {
    state = { status, ...(progress === undefined ? {} : { progress }) };
    onState(state);
  };
  return {
    getState: () => ({ ...state }),
    async preload({ enabled = true } = {}) {
      if (!enabled) {
        generation++;
        runtime?.dispose();
        runtime = undefined;
        preloadPromise = undefined;
        update('disabled');
        return this.getState();
      }
      if (state.status === 'ready') return this.getState();
      if (state.status === 'unsupported' || state.status === 'ineligible' || state.status === 'error') return this.getState();
      if (preloadPromise) return preloadPromise;
      const currentGeneration = ++generation;
      preloadPromise = (async () => {
        const eligibility = await detectEligibility(globalThis.navigator, policy);
        if (currentGeneration !== generation) return this.getState();
        update(eligibility.status, { reason: eligibility.reason });
        if (eligibility.status !== 'eligible') return this.getState();
        runtime = runtimeFactory((status, progress) => {
          if (currentGeneration === generation) update(status, progress);
        });
        update('downloading');
        try {
          await runtime.initialize();
          if (currentGeneration !== generation) {
            runtime?.dispose();
            runtime = undefined;
            return this.getState();
          }
          update('ready');
        } catch (error) {
          runtime?.dispose();
          runtime = undefined;
          if (currentGeneration !== generation) return this.getState();
          update('error', { message: error instanceof Error ? error.message : String(error) });
        }
        return this.getState();
      })().finally(() => { preloadPromise = undefined; });
      return preloadPromise;
    },
    async generate(prompt, { onProgress, signal, timeoutMs = 120_000 } = {}) {
      if (state.status !== 'ready' || !runtime) throw new Error(`Gemma is not ready (${state.status}).`);
      if (signal?.aborted) throw new DOMException('Gemma generation was cancelled.', 'AbortError');
      let timeout;
      let abortHandler;
      const generation = runtime.generate(prompt, progress => {
        update('ready', progress);
        onProgress?.(progress);
      });
      const cancellation = new Promise((_, reject) => {
        abortHandler = () => {
          runtime?.cancel();
          runtime?.dispose();
          runtime = undefined;
          update('error', { message: 'Gemma generation was cancelled.' });
          reject(new DOMException('Gemma generation was cancelled.', 'AbortError'));
        };
        if (signal) signal.addEventListener('abort', abortHandler, { once: true });
        timeout = setTimeout(() => {
          runtime?.cancel();
          runtime?.dispose();
          runtime = undefined;
          update('error', { message: 'Gemma generation timed out.' });
          reject(new Error('Gemma generation timed out.'));
        }, timeoutMs);
      });
      try {
        return await Promise.race([generation, cancellation]);
      } finally {
        clearTimeout(timeout);
        if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
      }
    },
    dispose() {
      generation++;
      runtime?.dispose();
      runtime = undefined;
      preloadPromise = undefined;
      update('disabled');
    },
  };
}
