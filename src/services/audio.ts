export class RollingAudio {
  private context?: AudioContext;
  private stream?: MediaStream;
  private processor?: ScriptProcessorNode;
  private outputGain?: GainNode;
  private chunks: Float32Array[] = [];
  private samples = 0;
  private targetSamples = 0;
  private listeners = new Set<() => void>();
  private capture?: Float32Array[];
  private captureSamples = 0;
  private captureLimit = 0;
  constructor(public durationSeconds = 10) {}

  get active() { return !!this.stream; }
  get bufferedSeconds() { return this.context ? Math.min(this.durationSeconds, this.samples / this.context.sampleRate) : 0; }
  get sampleRate() { return this.context?.sampleRate ?? 0; }
  subscribe(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private changed() { this.listeners.forEach(fn => fn()); }

  async start() {
    if (this.active) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone capture is unavailable in this browser/context.');
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    try {
      this.context = new AudioContext();
      await this.context.resume();
      this.targetSamples = Math.round(this.durationSeconds * this.context.sampleRate);
      const source = this.context.createMediaStreamSource(this.stream);
      this.processor = this.context.createScriptProcessor(4096, 1, 1);
      this.outputGain = this.context.createGain();
      this.outputGain.gain.value = 0;
      this.processor.onaudioprocess = event => {
        const data = new Float32Array(event.inputBuffer.getChannelData(0));
        if (this.capture) {
          const remaining = this.captureLimit - this.captureSamples;
          if (remaining > 0) {
            const captured = data.length <= remaining ? data : data.slice(0, remaining);
            this.capture.push(captured); this.captureSamples += captured.length;
          }
        }
        this.chunks.push(data); this.samples += data.length;
        while (this.samples > this.targetSamples && this.chunks.length) {
          const excess = this.samples - this.targetSamples;
          if (this.chunks[0].length <= excess) { this.samples -= this.chunks.shift()!.length; }
          else { this.chunks[0] = this.chunks[0].slice(excess); this.samples -= excess; }
        }
        this.changed();
      };
      source.connect(this.processor);
      this.processor.connect(this.outputGain);
      this.outputGain.connect(this.context.destination);
      this.changed();
    } catch (error) { this.stop(); throw error; }
  }

  beginCapture(maximumSeconds: number) {
    if (!this.context || !this.chunks.length) throw new Error('The audio buffer is empty. Start recording and speak first.');
    this.capture = this.chunks.map(chunk => chunk.slice());
    this.captureSamples = this.samples;
    this.captureLimit = this.samples + Math.round(maximumSeconds * this.context.sampleRate);
  }

  endCapture() {
    if (!this.context || !this.capture) throw new Error('No recording is in progress.');
    const audio = new Float32Array(this.captureSamples);
    let offset = 0;
    for (const chunk of this.capture) { audio.set(chunk, offset); offset += chunk.length; }
    const sampleRate = this.context.sampleRate;
    this.capture = undefined; this.captureSamples = 0; this.captureLimit = 0;
    return { audio, sampleRate };
  }

  snapshot() {
    if (!this.context || !this.chunks.length) throw new Error('The audio buffer is empty. Start recording and speak first.');
    const result = new Float32Array(this.samples);
    let offset = 0;
    for (const chunk of this.chunks) { result.set(chunk, offset); offset += chunk.length; }
    return { audio: result, sampleRate: this.context.sampleRate };
  }

  stop() {
    this.processor?.disconnect(); this.processor = undefined;
    this.outputGain?.disconnect(); this.outputGain = undefined;
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = undefined;
    void this.context?.close(); this.context = undefined;
    this.chunks = []; this.samples = 0; this.changed();
  }
}
