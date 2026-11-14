import { FilesetResolver, LlmInference } from '@mediapipe/tasks-genai';
import { GEMMA_MODEL_ASSET, GEMMA_WASM_ROOT } from './gemmaService.js';

type Request = { type: 'initialize' | 'generate' | 'cancel' | 'dispose'; id?: number; prompt?: string };
const cancelled = new Set<number>();
let inference: LlmInference | undefined;

self.onmessage = async (event: MessageEvent<Request>) => {
  const { type, id } = event.data;
  try {
    if (type === 'initialize') {
      if (inference) {
        self.postMessage({ type: 'ready', id });
        return;
      }
      self.postMessage({ type: 'status', status: 'downloading' });
      const fileset = await FilesetResolver.forGenAiTasks(GEMMA_WASM_ROOT, true);
      self.postMessage({ type: 'status', status: 'loading' });
      inference = await LlmInference.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: GEMMA_MODEL_ASSET, delegate: 'GPU' },
        maxTokens: 512,
        topK: 1,
        temperature: 0.1,
        randomSeed: 17,
        numResponses: 1,
      });
      self.postMessage({ type: 'ready', id });
      return;
    }
    if (type === 'dispose') {
      inference?.close();
      inference = undefined;
      return;
    }
    if (type === 'cancel') {
      if (id !== undefined) cancelled.add(id);
      return;
    }
    if (!inference) throw new Error('Gemma inference is not initialized.');
    if (typeof event.data.prompt !== 'string' || !event.data.prompt) throw new TypeError('Gemma prompt is empty.');
    if (id === undefined) throw new TypeError('Gemma request ID is missing.');
    const response = await inference.generateResponse(event.data.prompt, (partial, done) => {
      if (!cancelled.has(id)) self.postMessage({ type: 'progress', id, progress: { generatedCharacters: partial.length, done } });
    });
    if (!cancelled.has(id)) self.postMessage({ type: 'result', id, text: response });
    cancelled.delete(id);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (id !== undefined && !cancelled.has(id)) self.postMessage({ type: 'error', id, error: detail });
    else if (type === 'initialize') self.postMessage({ type: 'error', id, error: detail });
    cancelled.delete(id ?? -1);
  }
};
