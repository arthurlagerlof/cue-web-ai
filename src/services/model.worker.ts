import { pipeline, env } from '@huggingface/transformers';
import { ASR_MODELS, type ASRModelSize } from './asrModels';
import { crossEncoderScoreFromLogit } from '../intelligence/retrieval/crossEncoderScore.js';
import { EMBEDDING_REVISION, EMBEDDING_TOKENIZER } from '../intelligence/embeddingModel.js';
env.allowLocalModels = false;
env.useBrowserCache = true;

type RequestMessage = { id: number; stage: 'transcribe' | 'embed' | 'rerank'; text?: string; candidates?: Array<{ toolId: string; text: string }>; asrModel?: ASRModelSize; audio?: Float32Array; sampleRate?: number };
const models = {
  embed: EMBEDDING_TOKENIZER,
  rerank: 'SugoLabs/mmarco-mMiniLMv2-L12-H384-v1',
};
const pipelines: Partial<Record<RequestMessage['stage'], { modelId: string; instance: any; device?: 'webgpu' | 'wasm' }>> = {};

function errorDetail(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  return /^\d+$/.test(detail) ? `Model runtime error ${detail}` : detail;
}

function loadFailure(error: unknown) {
  const detail = errorDetail(error);
  if (/timed?\s*out|timeout/i.test(detail)) return `loading timeout: ${detail}`;
  if (/fetch|network|download|HTTP|status code|not found|unauthorized|forbidden/i.test(detail)) return `download failure: ${detail}`;
  return `loading error: ${detail}`;
}

async function rerank(id: number, modelId: string, text: string, candidates: Array<{ toolId: string; text: string }>) {
  const started = Date.now();
  const notice = (message: string, statusOnly = false) => postMessage({ id, stage: 'rerank', status: 'notice', model: modelId, message, statusOnly });
  const load = async (device: 'webgpu' | 'wasm') => {
    notice(`Cross-encoder loading started (${device}, q8; onnx/model_quantized.onnx)`, true);
    const progressByFile = new Map<string, number>();
    let active = true;
    try {
      const instance = await pipeline('text-classification', modelId, {
        device, dtype: 'q8',
        progress_callback: (progress: { status: string; file?: string; progress?: number; loaded?: number }) => {
          if (!active || progress.status !== 'progress' || !progress.file) return;
          const bucket = Number.isFinite(progress.progress) ? Math.min(100, Math.floor(progress.progress! / 25) * 25) : -1;
          if (progressByFile.get(progress.file) === bucket) return;
          progressByFile.set(progress.file, bucket);
          notice(`Cross-encoder download progress (${device}): ${progress.file} ${bucket >= 0 ? `${bucket}%` : 'size unknown'}${progress.loaded !== undefined ? ` (${progress.loaded} bytes)` : ''}`, true);
        },
      });
      pipelines.rerank = { modelId, instance, device };
      notice(`Cross-encoder loading completed (${device})`, true);
      return pipelines.rerank;
    } catch (error) {
      throw new Error(`${device} ${loadFailure(error)}`);
    } finally {
      active = false;
    }
  };
  let entry = pipelines.rerank;
  if (!entry || entry.modelId !== modelId) {
    let webgpuAvailable = false;
    try {
      const gpu = (navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
      webgpuAvailable = Boolean(gpu && await gpu.requestAdapter());
      if (!webgpuAvailable) notice('Cross-encoder WebGPU unavailable; using WASM');
    } catch (error) {
      notice(`Cross-encoder WebGPU availability check failed: ${errorDetail(error)}; using WASM`);
    }
    if (webgpuAvailable) {
      try {
        entry = await load('webgpu');
      } catch (error) {
        notice(`Cross-encoder ${errorDetail(error)}; retrying with WASM`);
        entry = await load('wasm');
      }
    } else {
      entry = await load('wasm');
    }
  }
  const run = async (current: NonNullable<typeof entry>) => {
    notice(`Cross-encoder reranking started (${current.device}, ${candidates.length} candidates)`);
    const scores = [];
    for (const candidate of candidates) {
      const inputs = current.instance.tokenizer(text, { text_pair: candidate.text, truncation: true });
      const output = await current.instance.model(inputs);
      const logit = Number(output.logits.data[0]);
      scores.push({ toolId: candidate.toolId, score: crossEncoderScoreFromLogit(logit) });
    }
    return scores;
  };
  let scores;
  try {
    postMessage({ id, stage: 'rerank', status: 'running', model: modelId });
    scores = await run(entry);
  } catch (error) {
    const detail = errorDetail(error);
    const failure = /timed?\s*out|timeout/i.test(detail) ? `inference timeout: ${detail}` : `inference error: ${detail}`;
    if (entry.device !== 'webgpu') throw new Error(`${entry.device} ${failure}`);
    notice(`Cross-encoder WebGPU ${failure}; retrying with WASM`);
    delete pipelines.rerank;
    try {
      await entry.instance.model.dispose();
    } catch (disposeError) {
      notice(`Cross-encoder WebGPU cleanup failed: ${errorDetail(disposeError)}`);
    }
    entry = await load('wasm');
    try {
      scores = await run(entry);
    } catch (wasmError) {
      const wasmDetail = errorDetail(wasmError);
      throw new Error(`wasm ${/timed?\s*out|timeout/i.test(wasmDetail) ? 'inference timeout' : 'inference error'}: ${wasmDetail}`);
    }
  }
  notice(`Cross-encoder reranking succeeded (${entry.device}, ${((Date.now() - started) / 1000).toFixed(1)}s)`);
  return scores;
}

self.onmessage = async (event: MessageEvent<RequestMessage>) => {
  const { id, stage } = event.data;
  let modelId: string | undefined;
  try {
    modelId = stage === 'transcribe' ? ASR_MODELS[event.data.asrModel ?? 'tiny'].modelId : models[stage];
    if (stage === 'rerank') {
      if (!event.data.text?.trim() || !Array.isArray(event.data.candidates) || !event.data.candidates.length) {
        throw new Error('A reranking request requires a query and candidates.');
      }
      if (event.data.candidates.some(candidate => !candidate.toolId || !candidate.text?.trim())) {
        throw new Error('A reranking candidate is incomplete.');
      }
      const result = await rerank(id, modelId, event.data.text, event.data.candidates);
      postMessage({ id, stage, status: 'complete', model: modelId, result });
      return;
    }
    postMessage({ id, stage, status: 'loading', model: modelId });
    if (!pipelines[stage] || pipelines[stage].modelId !== modelId) {
      const task = stage === 'transcribe' ? 'automatic-speech-recognition' : 'feature-extraction';
      const device = 'webgpu';
      const dtype = stage === 'embed' ? 'q8' : 'q4';
      const instance = await pipeline(task as never, modelId, { device, dtype, ...(stage === 'embed' ? { revision: EMBEDDING_REVISION } : {}) } as never);
      pipelines[stage] = { modelId, instance };
    }
    const modelPipeline = pipelines[stage]!.instance;
    postMessage({ id, stage, status: 'running', model: modelId });
    let result: unknown;
    if (stage === 'transcribe') {
      if (!event.data.audio || !event.data.sampleRate) throw new Error('Audio data is missing.');
      const source = event.data.audio;
      const sourceRate = event.data.sampleRate;
      const targetRate = 16000;
      let audio = source;
      if (sourceRate !== targetRate) {
        const length = Math.floor(source.length * targetRate / sourceRate);
        audio = new Float32Array(length);
        for (let i = 0; i < length; i++) {
          const position = i * sourceRate / targetRate;
          const left = Math.floor(position);
          const fraction = position - left;
          audio[i] = (source[left] ?? 0) * (1 - fraction) + (source[left + 1] ?? source[left] ?? 0) * fraction;
        }
      }
      result = await modelPipeline(audio, { sampling_rate: targetRate, return_timestamps: false });
      result = (result as { text?: string }).text ?? '';
    } else if (stage === 'embed') {
      if (!event.data.text?.trim()) throw new Error('Text to embed is empty.');
      const output = await modelPipeline(event.data.text, { pooling: 'mean', normalize: true });
      const vector = Array.from(output.data as Float32Array);
      result = { vector, dimensions: output.dims?.at(-1) ?? vector.length };
    }
    postMessage({ id, stage, status: 'complete', model: modelId, result });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const message = /^\d+$/.test(detail)
      ? `Model runtime error ${detail}; check model download completion, available memory, and WebGPU/ONNX support.`
      : detail;
    if (stage === 'rerank') postMessage({ id, stage, status: 'notice', message: `Cross-encoder failed: ${message}` });
    postMessage({ id, stage, status: 'error', model: modelId, error: message });
  }
};
