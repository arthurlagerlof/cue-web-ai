import { pipeline, env } from '@huggingface/transformers';
import { ASR_MODELS, type ASRModelSize } from './asrModels';
env.allowLocalModels = false;
env.useBrowserCache = true;

type Candidate = { toolId: string; score: number; name: string; description: string; parameters: object };
type RequestMessage = { id: number; stage: 'transcribe' | 'embed' | 'resolve'; text?: string; instruction?: string; candidates?: Candidate[]; asrModel?: ASRModelSize; audio?: Float32Array; sampleRate?: number };
const models = {
  resolve: 'onnx-community/gemma-3-1b-it-ONNX',
  embed: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
};
const pipelines: Partial<Record<RequestMessage['stage'], { modelId: string; instance: any }>> = {};

self.onmessage = async (event: MessageEvent<RequestMessage>) => {
  const { id, stage } = event.data;
  try {
    const modelId = stage === 'transcribe'
      ? ASR_MODELS[event.data.asrModel ?? 'tiny'].modelId
      : models[stage];
    postMessage({ id, stage, status: 'loading', model: modelId });
    if (!pipelines[stage] || pipelines[stage].modelId !== modelId) {
      const task = stage === 'transcribe' ? 'automatic-speech-recognition' : stage === 'resolve' ? 'text-generation' : 'feature-extraction';
      const instance = await pipeline(task as never, modelId, { device: 'webgpu', dtype: stage === 'embed' ? 'fp32' : 'q4' } as never);
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
    } else if (stage === 'resolve') {
      if (!event.data.text?.trim()) throw new Error('Transcription is empty.');
      const candidateList = event.data.candidates ?? [];
      const userInput = `Resolve the request using ONLY the registered tool candidates below. Never invent a tool id, parameter, provider, or execution destination. Return one JSON object and no markdown, using exactly one shape: {"kind":"answer","text":"..."}, {"kind":"clarification","question":"..."}, {"kind":"tool","toolId":"...","arguments":{}}, or {"kind":"multi_tool","operations":[{"id":"op1","toolId":"...","arguments":{},"dependsOn":[]}]}. Use kind answer for an ordinary request that needs no tool. Use clarification when intent or required parameters are ambiguous. Resolve relative dates and times from the supplied local time context. For dependent operations, reference prior result values as {"$from":{"operationId":"op1","path":"..."}}. Time context: ${event.data.instruction ?? 'not supplied'}\nCandidates: ${JSON.stringify(candidateList)}\nRequest: ${event.data.text.trim()}`;
      const generated = await modelPipeline([{ role: 'user', content: userInput }], { max_new_tokens: 240, do_sample: false });
      const raw = Array.isArray(generated) ? generated[0]?.generated_text : generated;
      const response = Array.isArray(raw) ? raw.at(-1)?.content : typeof raw === 'string' ? raw : '';
      if (typeof response !== 'string' || !response.trim()) throw new Error('Local model returned no tool resolution.');
      const json = response.trim().replace(/^```(?:json)?\\s*/i, '').replace(/\\s*```$/, '');
      try { result = JSON.parse(json); } catch { throw new Error('Local model returned invalid structured tool resolution.'); }
    } else {
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
    postMessage({ id, stage, status: 'error', error: message });
  }
};
