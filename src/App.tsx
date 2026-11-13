import { useEffect, useRef, useState } from 'react';
import { RollingAudio } from './services/audio';
import { BangleConnection } from './services/bluetooth';
import { ASR_MODELS, type ASRModelSize } from './services/asrModels';
import watchAppSource from '../watch/bangle-app.js?raw';

type Stage = 'transcribe' | 'interpret' | 'embed';
type WorkerReply = { id: number; stage: Stage; status: string; model?: string; result?: any; error?: string };
const workers = new Map<Stage, Worker>();
function createWorker(stage: Stage) {
  const instance = new Worker(new URL('./services/model.worker.ts', import.meta.url), { type: 'module' });
  workers.set(stage, instance);
  return instance;
}
const recordingLimitSeconds = 5 * 60;
const audio = new RollingAudio(10);
const watch = new BangleConnection();

function fitWatchText(text: string) {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= 512) return text;
  let result = '';
  for (const character of Array.from(text)) {
    if (encoder.encode(result + character + '…').length > 512) break;
    result += character;
  }
  return result + '…';
}

function downloadWatchFile(filename: string, source: string) {
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type Session = { csrfToken: string };
let sessionPromise: Promise<Session> | undefined;

function getSession(forceRenew = false): Promise<Session> {
  if (forceRenew || !sessionPromise) {
    sessionPromise = fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' })
      .then(async response => {
        if (!response.ok) throw new Error(`Session initialization failed (${response.status})`);
        const result = await response.json();
        if (typeof result.csrfToken !== 'string' || !result.csrfToken) throw new Error('Session initialization returned no token');
        return { csrfToken: result.csrfToken };
      })
      .catch(error => { sessionPromise = undefined; throw error; });
  }
  return sessionPromise;
}

async function postApi(path: string, data: unknown) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const session = await getSession(attempt === 1);
    const response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken }, body: JSON.stringify(data) });
    const result = await response.json();
    if (response.ok) return result;
    if (response.status === 403 && /session\/csrf/i.test(String(result.error)) && attempt === 0) {
      sessionPromise = undefined;
      continue;
    }
    throw new Error(result.error ?? `Backend request failed (${response.status})`);
  }
  throw new Error('Session validation failed after renewal');
}

export default function App() {
  const [watchName, setWatchName] = useState('Not connected');
  const [installing, setInstalling] = useState(false);
  const [testSending, setTestSending] = useState(false);
  const [installStatus, setInstallStatus] = useState('');
  const [recording, setRecording] = useState(false);
  const [buffer, setBuffer] = useState(0);
  const [asrModel, setAsrModel] = useState<ASRModelSize>('tiny');
  const asrModelRef = useRef<ASRModelSize>('tiny');
  const [status, setStatus] = useState<Record<Stage, string>>({ transcribe: 'Not started', interpret: 'Not started', embed: 'Not started' });
  const [transcription, setTranscription] = useState('');
  const [embedding, setEmbedding] = useState<any>();
  const [logs, setLogs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'anki' | 'api'>('anki');
  const modeRef = useRef<'anki' | 'api'>('anki');
  const [transcriptInput, setTranscriptInput] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [displayText, setDisplayText] = useState('');
  const [endpoint, setEndpoint] = useState('https://api.openai.com/v1');
  const [apiModel, setApiModel] = useState('gpt-4o-mini');
  const [apiPrompt, setApiPrompt] = useState('Summarize the transcript as a concise memory aid.');
  const [holding, setHolding] = useState(false);
  const [frozenAudio, setFrozenAudio] = useState<Float32Array>();
  const [playbackActive, setPlaybackActive] = useState(false);
  const playbackRef = useRef<AudioBufferSourceNode>();
  const holdingRef = useRef(false);
  const holdTimer = useRef<number>();
  const sequence = useRef(0);
  const running = useRef(false);
  const pending = useRef(new Map<number, { stage: Stage; resolve: (reply: WorkerReply) => void }>());

  const log = (message: string) => setLogs(old => [`${new Date().toLocaleTimeString()} ${message}`, ...old].slice(0, 30));
  useEffect(() => {
    const unsubscribe = audio.subscribe(() => { setRecording(audio.active); setBuffer(audio.bufferedSeconds); });
    void getSession().catch(error => log(`Backend session unavailable: ${error instanceof Error ? error.message : 'initialization failed'}`));
    watch.onTrigger = () => {
      log('Watch tap trigger received');
      try {
        const snapshot = audio.snapshot();
        setFrozenAudio(snapshot.audio.slice());
        void runPipeline(snapshot);
      } catch (error) { log(error instanceof Error ? error.message : String(error)); }
    };
    watch.onStatus = message => { setWatchName('Not connected'); log(message); };
    watch.onDiagnostic = message => log(`BLE: ${message}`);
    return () => { unsubscribe(); playbackRef.current?.stop(); workers.forEach(instance => instance.terminate()); workers.clear(); watch.disconnect(); audio.stop(); };
  }, []);

  function runModel(stage: Stage, data: { text?: string; instruction?: string; asrModel?: ASRModelSize; audio?: Float32Array; sampleRate?: number }): Promise<WorkerReply> {
    const id = ++sequence.current;
    let instance = workers.get(stage);
    if (!instance) {
        instance = createWorker(stage);
        instance.onmessage = (event: MessageEvent<WorkerReply>) => {
          const reply = event.data;
          if (reply.status !== 'complete' && reply.status !== 'error') {
            setStatus(old => ({ ...old, [stage]: `${reply.status}${reply.model ? ` — ${reply.model}` : ''}` })); return;
          }
          setStatus(old => ({ ...old, [stage]: reply.status === 'error' ? `Error — ${reply.error}` : `Complete — ${reply.model ?? 'done'}` }));
          const task = pending.current.get(reply.id);
          if (task) { pending.current.delete(reply.id); task.resolve(reply); }
        };
        instance.onerror = event => {
          const message = event.message || 'Model worker failed.';
          setStatus(old => ({ ...old, [stage]: `Error — ${message}` }));
          pending.current.forEach((task, pendingId) => { if (task.stage === stage) { task.resolve({ id: pendingId, stage, status: 'error', error: message }); pending.current.delete(pendingId); } });
          log(message);
        };
    }
    return new Promise(resolve => { pending.current.set(id, { stage, resolve }); instance!.postMessage({ id, stage, ...data }, data.audio ? [data.audio.buffer] : []); });
  }

  function stopStage(stage: Stage) {
    const instance = workers.get(stage);
    if (!instance) return;
    instance.terminate(); workers.delete(stage);
    pending.current.forEach((task, id) => { if (task.stage === stage) { task.resolve({ id, stage, status: 'error', error: 'Stopped by user.' }); pending.current.delete(id); } });
    setStatus(old => ({ ...old, [stage]: 'Stopped by user' }));
    log(`${stage} stopped`);
  }

  function freezeBuffer() {
    try { const snapshot = audio.snapshot(); setFrozenAudio(snapshot.audio.slice()); log(`Frozen ${snapshot.audio.length} samples at ${snapshot.sampleRate} Hz; transcription is not started automatically`); }
    catch (error) { log(error instanceof Error ? error.message : String(error)); }
  }

  async function processTranscript(text: string) {
    const clean = text.trim();
    if (!clean) throw new Error('Enter transcript text first.');
    setTranscription(clean); setTranscriptInput(clean); setBusy(true);
    try {
      if (modeRef.current === 'anki') {
        const embedded = await runModel('embed', { text: clean });
        if (embedded.status === 'error') throw new Error(embedded.error);
        setEmbedding({ ...embedded.result, model: embedded.model });
        const search = await postApi('/api/search', { vector: embedded.result.vector, limit: 8 });
        setSearchResults(search.results);
        if (!search.results.length) throw new Error('No embedded Anki notes were found.');
        const bestText = search.results[0].text;
        setDisplayText(bestText);
        await watch.sendDisplayText(fitWatchText(bestText));
        log(`Anki search complete (${search.results.length} results); best note sent to watch`);
      } else {
        const result = await postApi('/api/interpret', { transcript: clean, endpoint, model: apiModel, prompt: apiPrompt });
        setDisplayText(result.display_text); setSearchResults([]);
        await watch.sendDisplayText(result.display_text);
        log('API response validated and sent to watch');
      }
    } catch (error) { const message = error instanceof Error ? error.message : String(error); log(`Processing error: ${message}`); throw error; }
    finally { setBusy(false); }
  }

  async function submitTranscript() {
    try { await processTranscript(transcriptInput); }
    catch { /* Error is already reported in the status log. */ }
  }

  async function runPipeline(snapshot = audio.snapshot()) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      log(`Frozen ${snapshot.audio.length} samples at ${snapshot.sampleRate} Hz`);
      const asr = await runModel('transcribe', { ...snapshot, asrModel: asrModelRef.current });
      if (asr.status === 'error') throw new Error(asr.error);
      const text = String(asr.result ?? '').trim(); setTranscription(text);
      setStatus(old => ({ ...old, transcribe: `Complete — ${asr.model}` }));
      if (!text) throw new Error('No speech was detected.');
      await processTranscript(text);
      await watch.send('STATUS:DONE'); log('Transcript processing complete');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Pipeline error: ${message}`); void watch.send('STATUS:ERROR');
    } finally { running.current = false; setBusy(false); }
  }

  async function connectWatch() {
    try { setWatchName('Connecting…'); const name = await watch.connect(); setWatchName(name); log(`Connected: ${name}`); }
    catch (error) { setWatchName('Not connected'); log(error instanceof Error ? error.message : String(error)); }
  }

  async function sendWatchTest() {
    setTestSending(true);
    try {
      await watch.sendRawTest();
      log('Raw TEST sent to watch and acknowledged');
    } catch (error) {
      log(`Watch test failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally { setTestSending(false); }
  }

  async function installOnWatch() {
    setInstalling(true); setInstallStatus('Preparing installation…');
    try {
      if (!watch.connected) {
        setWatchName('Connecting…');
        const name = await watch.connect();
        setWatchName(name); log(`Connected: ${name}`);
      }
      await watch.installWatchApp(watchAppSource, setInstallStatus);
      log('Watch app and metadata installed and verified');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setInstallStatus(`Installation failed: ${message}`); log(`Watch installation failed: ${message}`);
    } finally { setInstalling(false); }
  }

  async function startHoldCapture() {
    if (holdingRef.current || !recording || buffer < 0.2 || busy) return;
    try {
      audio.beginCapture(recordingLimitSeconds);
      holdingRef.current = true; setHolding(true);
      holdTimer.current = window.setTimeout(() => { void finishHoldCapture(); log('Maximum 5-minute recording reached'); }, recordingLimitSeconds * 1000);
    } catch (error) { log(error instanceof Error ? error.message : String(error)); }
  }

  async function finishHoldCapture() {
    if (!holdingRef.current) return;
    holdingRef.current = false; setHolding(false);
    if (holdTimer.current !== undefined) window.clearTimeout(holdTimer.current);
    try {
      const snapshot = audio.endCapture();
      setFrozenAudio(snapshot.audio.slice());
      await runPipeline(snapshot);
    } catch (error) { log(error instanceof Error ? error.message : String(error)); }
  }

  async function playFrozenRecording() {
    if (!frozenAudio) return;
    if (playbackRef.current) {
      playbackRef.current.onended = null;
      playbackRef.current.stop();
      playbackRef.current = undefined;
      setPlaybackActive(false);
      return;
    }
    const context = new AudioContext();
    await context.resume();
    const buffer = context.createBuffer(1, frozenAudio.length, audio.sampleRate || context.sampleRate);
    buffer.copyToChannel(frozenAudio, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.onended = () => { setPlaybackActive(false); playbackRef.current = undefined; void context.close(); };
    playbackRef.current = source;
    setPlaybackActive(true);
    source.start();
  }

  async function toggleMicrophone() {
    try { if (audio.active) { if (holdingRef.current) await finishHoldCapture(); audio.stop(); } else await audio.start(); }
    catch (error) { log(error instanceof Error ? error.message : String(error)); }
  }

  return <main>
    <h1>Bangle.js AI memory demo</h1>
    <p>Enter transcript text for Anki semantic search or server-side API processing. Audio transcription remains an optional separate control.</p>
    <section><h2>Devices</h2><button onClick={() => watch.connected ? watch.disconnect() : void connectWatch()}>{watch.connected ? 'Disconnect watch' : 'Connect Bangle.js'}</button> <span>{watchName}</span> <button disabled={!watch.connected || testSending} onClick={() => void sendWatchTest()}>{testSending ? 'Sending raw test…' : 'Send raw TEST to watch'}</button><p><button disabled={installing} onClick={() => void installOnWatch()}>{installing ? 'Installing…' : 'Install on watch'}</button></p>{installStatus && <p role="status">{installStatus}</p>}<details><summary>Manual downloads</summary><p>These files can also be installed with the Espruino Web IDE.</p><button onClick={() => downloadWatchFile('bangle-memory.app.js', watchAppSource)}>Download watch display app</button> <a href="https://www.espruino.com/ide/" target="_blank" rel="noreferrer">Open Espruino Web IDE</a></details><br /><button onClick={() => void toggleMicrophone()}>{recording ? 'Stop microphone' : 'Start microphone'}</button><button disabled={!recording || buffer < 0.2} onClick={freezeBuffer}>Freeze rolling buffer</button> <strong style={{ color: recording ? '#16803c' : '#777' }}>{recording ? '● Recording' : 'Microphone off'}</strong><p>Rolling buffer: {buffer.toFixed(1)} / 10.0 seconds (sample rate {audio.sampleRate || '—'} Hz)</p></section>
    <section><h2>Processing</h2><label>Whisper model<select value={asrModel} disabled={busy} onChange={event => { const value = event.target.value as ASRModelSize; setAsrModel(value); asrModelRef.current = value; }}>{Object.entries(ASR_MODELS).map(([size, model]) => <option key={size} value={size}>{model.label}</option>)}</select></label><button disabled={!frozenAudio} onClick={() => void playFrozenRecording()}>{playbackActive ? 'Stop playback' : 'Play frozen recording'}</button><button disabled={busy || !recording || buffer < 0.2} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); void startHoldCapture(); }} onPointerUp={() => void finishHoldCapture()} onPointerCancel={() => void finishHoldCapture()} onLostPointerCapture={() => void finishHoldCapture()}>{holding ? 'Release to transcribe…' : 'Hold to transcribe (max 5 min)'}</button>{(['transcribe', 'embed'] as Stage[]).map(stage => <p key={stage}>{stage}: {status[stage]}{busy && <button onClick={() => stopStage(stage)}>Stop {stage}</button>}</p>)}<label>Mode<select value={mode} disabled={busy} onChange={event => { const value = event.target.value as 'anki' | 'api'; setMode(value); modeRef.current = value; }}><option value="anki">Anki semantic search</option><option value="api">OpenAI-compatible API</option></select></label><label>Transcript text<textarea value={transcriptInput} onChange={event => setTranscriptInput(event.target.value)} placeholder="Enter sample transcript text" /></label><button disabled={busy || !transcriptInput.trim()} onClick={() => void submitTranscript()}>{busy ? 'Processing…' : 'Process transcript'}</button><label>Transcription (audio capture only)<textarea readOnly value={transcription} /></label>{mode === 'api' && <><label>Chat Completions endpoint URL<input value={endpoint} onChange={event => setEndpoint(event.target.value)} /></label><label>Model<input value={apiModel} onChange={event => setApiModel(event.target.value)} /></label><label>Prompt<textarea value={apiPrompt} onChange={event => setApiPrompt(event.target.value)} /></label><p>The API key is read only by the local backend from LLM_API_KEY.</p></>}<p>Embedding: {embedding ? `${embedding.dimensions} dimensions (${embedding.model ?? 'normalized'})` : 'Generated only in Anki mode'}</p><h3>Result</h3><pre>{displayText || 'No result yet'}</pre>{searchResults.length > 0 && <><h3>Anki matches</h3>{searchResults.map((result, index) => <article key={result.note_id}><h4>#{index + 1} — note {result.note_id} / card {result.card_id} — {result.deck ?? 'Unknown deck'} (similarity {result.score.toFixed(3)})</h4><pre>{result.text}</pre></article>)}</>}</section>
    <section><h2>Status log</h2><pre>{logs.join('\n')}</pre></section>
  </main>;
}
