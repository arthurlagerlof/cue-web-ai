const CLOUD_MODEL = '@cf/openai/whisper-large-v3-turbo';
const TARGET_SAMPLE_RATE = 16000;

export { CLOUD_MODEL };

export function encodeWav(samples, sampleRate) {
  const length = Math.floor(samples.length * TARGET_SAMPLE_RATE / sampleRate);
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const writeText = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeText(0, 'RIFF');
  view.setUint32(4, buffer.byteLength - 8, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, TARGET_SAMPLE_RATE, true);
  view.setUint32(28, TARGET_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, length * 2, true);
  for (let i = 0; i < length; i++) {
    const position = i * sampleRate / TARGET_SAMPLE_RATE;
    const left = Math.floor(position);
    const fraction = position - left;
    const value = Math.max(-1, Math.min(1, samples[left] * (1 - fraction) + (samples[left + 1] ?? samples[left]) * fraction));
    view.setInt16(44 + i * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export async function transcribeInCloud(samples, sampleRate, signal) {
  const form = new FormData();
  form.append('file', encodeWav(samples, sampleRate), 'recording.wav');
  let response;
  try {
    response = await fetch('/api/transcribe', { method: 'POST', body: form, signal });
  } catch (error) {
    if (signal.aborted) throw new Error('Stopped by user.');
    throw new Error('Cloud transcription is unavailable. Check your connection and try again.', { cause: error });
  }
  if (response.status === 413) throw new Error('Audio file exceeds the 10 MB cloud transcription limit.');
  if (response.status === 429) throw new Error('Cloud transcription rate limit exceeded. Wait before trying again.');
  if (response.status === 500) throw new Error('Cloud transcription failed. Please try again later.');
  if (!response.ok) throw new Error(`Cloud transcription is unavailable (HTTP ${response.status}).`);
  let result;
  try {
    result = await response.json();
  } catch (error) {
    throw new Error('Cloud transcription returned an invalid response.', { cause: error });
  }
  if (!result || typeof result.text !== 'string') throw new Error('Cloud transcription returned an invalid response.');
  return result.text;
}
