export const ASR_MODELS = {
  tiny: { label: 'Tiny — fastest, lowest accuracy', modelId: 'onnx-community/whisper-tiny' },
  base: { label: 'Base — balanced', modelId: 'onnx-community/whisper-base' },
  small: { label: 'Small — slower, higher accuracy', modelId: 'onnx-community/whisper-small' },
} as const;

export type ASRModelSize = keyof typeof ASR_MODELS;
