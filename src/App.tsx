import { useEffect, useRef, useState } from 'react';
import { RollingAudio } from './services/audio';
import { BangleConnection } from './services/bluetooth';
import { ASR_MODELS, type ASRModelSize } from './services/asrModels';
import { createGemmaService } from './services/gemmaService.js';
import { createDisplayDocument, validateDisplayDocument } from './display/document.js';
import { DisplayDocumentView } from './display/DisplayDocumentView';
import { createDatabaseEnvironment } from './demo/databaseEnvironment.js';
import watchAppSource from '../watch/bangle-app.js?raw';

type Stage = 'transcribe' | 'embed';
type WorkerReply = { id: number; stage: Stage; status: string; model?: string; result?: any; error?: string };
const workers = new Map<Stage, Worker>();
function createWorker(stage: Stage) {
  const instance = new Worker(new URL('./services/model.worker.ts', import.meta.url), { type: 'module' });
  workers.set(stage, instance);
  return instance;
}
const recordingLimitSeconds = 5 * 60;
const DEMO_SCENARIOS = [
  'Search my Anki cards about chloroplasts',
  'Create a flashcard about photosynthesis',
  'Search my knowledge base for local-first AI',
  'Search the web for recent research on multimodal AI',
  'What events do I have tomorrow?',
  'Find the message I received from Alex',
  'Find my morning alarm',
  'Find my first meeting tomorrow and set an alarm 15 minutes beforehand',
  'Etsi Anki-kortti fotosynteesistä',
  'Etsi huomisen kalenteritapahtumat',
];
const audio = new RollingAudio(10);
const watch = new BangleConnection();

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

async function getConversationState() {
  const response = await fetch('/api/demo/conversation', { credentials: 'same-origin', cache: 'no-store' });
  const result = await response.json();
  if (response.status === 404) throw new Error('The backend does not support conversation state. Restart the Cue backend to load the current code.');
  if (!response.ok) throw new Error(result.error ?? `Conversation state request failed (${response.status})`);
  return result.state;
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
  const [status, setStatus] = useState<Record<Stage, string>>({ transcribe: 'Not started', embed: 'Not started' });
  const [gemmaMode, setGemmaMode] = useState<'automatic' | 'enabled' | 'disabled'>(() => {
    try {
      const savedMode = window.localStorage.getItem('cue.gemma.mode');
      if (savedMode === 'automatic' || savedMode === 'enabled' || savedMode === 'disabled') return savedMode;
      const legacyPreference = window.localStorage.getItem('cue.gemma.enabled');
      return legacyPreference === null ? 'automatic' : legacyPreference === 'true' ? 'enabled' : 'disabled';
    } catch { return 'automatic'; }
  });
  const gemmaModeRef = useRef(gemmaMode);
  const [weekStartsOn, setWeekStartsOn] = useState(() => {
    try { return window.localStorage.getItem('cue.calendar.weekStartsOn') === '0' ? 0 : 1; }
    catch { return 1; }
  });
  const [gemmaState, setGemmaState] = useState<{ status: string; progress?: { reason?: string; message?: string; generatedCharacters?: number } }>({ status: 'not_checked' });
  const [gemmaService] = useState(() => createGemmaService({ onState: state => setGemmaState(state) }));
  const [transcription, setTranscription] = useState('');
  const [embedding, setEmbedding] = useState<any>();
  const [logs, setLogs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [transcriptInput, setTranscriptInput] = useState('');
  const [scenario, setScenario] = useState('');
  const [displayDocument, setDisplayDocument] = useState<any>();
  const [pendingConfirmation, setPendingConfirmation] = useState<any>();
  const [pendingClarification, setPendingClarification] = useState(false);
  const [holding, setHolding] = useState(false);
  const [frozenAudio, setFrozenAudio] = useState<Float32Array>();
  const [playbackActive, setPlaybackActive] = useState(false);
  const playbackRef = useRef<AudioBufferSourceNode>();
  const holdingRef = useRef(false);
  const holdTimer = useRef<number>();
  const sequence = useRef(0);
  const running = useRef(false);
  const environment = useRef<any>();
  const displayDocumentRef = useRef<any>();
  const pendingConfirmationRef = useRef<any>();
  const watchConfirmationRef = useRef(false);
  const pending = useRef(new Map<number, { stage: Stage; resolve: (reply: WorkerReply) => void }>());

  const log = (message: string) => setLogs(old => [`${new Date().toLocaleTimeString()} ${message}`, ...old].slice(0, 30));
  const updatePendingConfirmation = (pending: any) => {
    pendingConfirmationRef.current = pending;
    setPendingConfirmation(pending);
  };
  useEffect(() => {
    const unsubscribe = audio.subscribe(() => { setRecording(audio.active); setBuffer(audio.bufferedSeconds); });
    void getSession()
      .then(() => getConversationState())
      .then(state => {
        if (state?.status === 'awaiting_confirmation' && state.pendingConfirmation?.call) updatePendingConfirmation({ call: state.pendingConfirmation.call, fromWorkflow: true });
        if (state && ['awaiting_tool_choice', 'awaiting_argument', 'awaiting_entity_choice'].includes(state.status)) setPendingClarification(true);
        if (state && ['awaiting_tool_choice', 'awaiting_argument', 'awaiting_entity_choice', 'awaiting_confirmation'].includes(state.status)) {
          const message = state.pendingQuestion ?? 'Continue the pending local operation.';
          void showDocument(createDisplayDocument({
            id: `cue-restored-${state.status}`,
            title: state.status === 'awaiting_confirmation' ? 'Confirmation required' : 'Clarification needed',
            source: { app: 'cue', name: 'Cue' },
            state: state.status === 'awaiting_confirmation' ? 'confirmation_required' : 'clarification_required',
            message,
            elements: [{ type: 'text', text: message, role: 'body' }],
          })).catch(error => log(`Could not restore pending request display: ${error instanceof Error ? error.message : String(error)}`));
        }
      })
      .catch(error => log(`Backend session unavailable: ${error instanceof Error ? error.message : 'initialization failed'}`));
    watch.onTrigger = () => {
      log('Watch hold-to-trigger received');
      try {
        const snapshot = audio.snapshot();
        setFrozenAudio(snapshot.audio.slice());
        void runPipeline(snapshot);
      } catch (error) { log(error instanceof Error ? error.message : String(error)); }
    };
    watch.onAction = actionId => {
      if (actionId === '__cue_confirm' && watchConfirmationRef.current) {
        watchConfirmationRef.current = false;
        if (pendingConfirmationRef.current) void confirmPendingAction(pendingConfirmationRef.current, true);
        else log('Ignored watch confirmation without a pending action');
        return;
      }
      if (actionId === '__cue_cancel' && watchConfirmationRef.current) {
        watchConfirmationRef.current = false;
        if (!pendingConfirmationRef.current) {
          log('Ignored watch cancellation without a pending action');
          return;
        }
        cancelPendingOperation();
        void watch.sendDisplayDocument(createDisplayDocument({
          id: 'cue-watch-cancelled',
          title: 'Cancelled',
          source: { app: 'cue', name: 'Cue' },
          state: 'success',
          message: 'The pending action was cancelled.',
        })).catch(error => log(`Could not update watch after cancellation: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      const action = displayDocumentRef.current?.actions?.find((item: any) => item.id === actionId);
      if (action) void dispatchDocumentAction(action);
      else log(`Ignored unknown watch action: ${actionId}`);
    };
    watch.onStatus = message => { setWatchName('Not connected'); log(message); };
    watch.onDiagnostic = message => log(`BLE: ${message}`);
    return () => { unsubscribe(); playbackRef.current?.stop(); workers.forEach(instance => instance.terminate()); workers.clear(); gemmaService.dispose(); watch.disconnect(); audio.stop(); };
  }, []);

  function setGemmaPreference(mode: 'automatic' | 'enabled' | 'disabled') {
    gemmaModeRef.current = mode;
    setGemmaMode(mode);
    try { window.localStorage.setItem('cue.gemma.mode', mode); }
    catch (error) { log(`Could not save local normalizer preference: ${error instanceof Error ? error.message : String(error)}`); }
    if (mode === 'disabled') {
      gemmaService.dispose();
    }
  }

  function setCalendarWeekStart(value: number) {
    setWeekStartsOn(value);
    try { window.localStorage.setItem('cue.calendar.weekStartsOn', String(value)); }
    catch (error) { log(`Could not save calendar week-start preference: ${error instanceof Error ? error.message : String(error)}`); }
  }

  function runModel(stage: Stage, data: { text?: string; asrModel?: ASRModelSize; audio?: Float32Array; sampleRate?: number }): Promise<WorkerReply> {
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

  async function getEnvironment() {
    if (environment.current) return environment.current;
    await getSession();
    const embed = async (text: string) => {
      const reply = await runModel('embed', { text });
      if (reply.status === 'error') throw new Error(reply.error);
      setEmbedding({ ...reply.result, model: reply.model });
      return reply.result;
    };
    const response = await fetch('/api/demo/registry', { credentials: 'same-origin', cache: 'no-store' });
    const registryData = await response.json();
    if (!response.ok) throw new Error(registryData.error ?? `Demo registry request failed (${response.status})`);
    const initialState = await getConversationState();
    environment.current = await createDatabaseEnvironment({
      registryData,
      embed,
      postApi,
      argumentNormalizerEnabled: () => gemmaModeRef.current !== 'disabled',
      normalizeArguments: async (prompt: string) => {
        const result = await postApi('/api/demo/normalize', { prompt });
        if (typeof result.text !== 'string' || !result.text.trim()) throw new Error('OpenRouter returned an empty response.');
        return result.text;
      },
      onNormalizerFallback: (reason: string) => log(`OpenRouter normalizer unavailable or invalid: ${reason}. Trying local Gemma fallback.`),
      fallbackNormalizeArguments: async (prompt: string) => {
        const state = await gemmaService.preload();
        if (state.status !== 'ready') {
          throw new Error(state.progress?.message ?? state.progress?.reason ?? `Gemma is unavailable (${state.status}).`);
        }
        return gemmaService.generate(prompt);
      },
      initialState: initialState?.status === 'idle' ? undefined : initialState,
    });
    if (initialState?.status === 'awaiting_confirmation' && initialState.pendingConfirmation?.call) updatePendingConfirmation({ call: initialState.pendingConfirmation.call, fromWorkflow: true });
    if (initialState && ['awaiting_tool_choice', 'awaiting_argument', 'awaiting_entity_choice'].includes(initialState.status)) setPendingClarification(true);
    log(`Loaded ${registryData.tools.length} provider-owned tools from the SQLite demo registry`);
    return environment.current;
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

  async function showDocument(document: any) {
    const validation = validateDisplayDocument(document, { registry: environment.current?.registry });
    if (!validation.valid) throw new TypeError(`Invalid display document: ${validation.errors.join('; ')}`);
    displayDocumentRef.current = document;
    setDisplayDocument(document);
    if (watch.connected) {
      watchConfirmationRef.current = document.state === 'confirmation_required';
      await watch.sendDisplayDocument(document);
    }
  }

  async function processTranscript(text: string) {
    const clean = text.trim();
    if (!clean) throw new Error('Enter transcript text first.');
    setTranscription(clean); setTranscriptInput(clean); setBusy(true);
    try {
      await showDocument(createDisplayDocument({ id: 'cue-loading', title: 'Working', source: { app: 'cue', name: 'Cue' }, state: 'loading', message: 'Discovering provider tools and preparing a local response.', elements: [{ type: 'text', text: clean, role: 'body' }] }));
      const runtime = await getEnvironment();
      const outcome = await runtime.intelligence.handle(clean, { context: { now: new Date(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: navigator.language, weekStartsOn } });
      if (outcome.state) await postApi('/api/demo/conversation', { state: outcome.state });
      if (outcome.normalizationError) log(`Argument normalization failed: ${outcome.normalizationError}`);
      if (outcome.kind !== 'confirmation_required') updatePendingConfirmation(undefined);
      setPendingClarification(outcome.kind === 'clarification' || ['awaiting_tool_choice', 'awaiting_argument', 'awaiting_entity_choice'].includes(outcome.state?.status));
      if (outcome.retrieval) {
        log(`Retrieval ${outcome.retrieval.toolId}: ${outcome.retrieval.score.toFixed(3)} (description ${outcome.retrieval.bestDescriptionSimilarity?.toFixed(3) ?? '—'}, keyword ${outcome.retrieval.bestKeywordSimilarity?.toFixed(3) ?? '—'}, example ${outcome.retrieval.bestExampleSimilarity?.toFixed(3) ?? '—'}, margin ${outcome.retrieval.margin?.toFixed(3) ?? '—'})`);
        if (outcome.retrieval.providerEvidence) {
          log(`Provider data ${outcome.retrieval.providerEvidence.hits.length ? `matched ${outcome.retrieval.providerEvidence.hits.length} record(s)` : 'had no matching records'}; indexed ${outcome.retrieval.providerEvidence.indexedAt ?? 'not available'}`);
        }
      }
      if (outcome.kind === 'confirmation_required') {
        updatePendingConfirmation(outcome.pendingCall ? { call: outcome.pendingCall, fromWorkflow: true } : { plan: outcome.pendingPlan, fromWorkflow: true });
        const targetIds = outcome.operations?.map((operation: any) => operation.toolId) ?? [outcome.toolId];
        const targets = targetIds.map((id: string) => runtime.registry.get(id)?.name ?? id).join(', ');
        const proposed = outcome.pendingCall?.arguments ? `\nProposed arguments: ${JSON.stringify(outcome.pendingCall.arguments)}` : '';
        const confirmation = createDisplayDocument({ id: 'cue-confirmation-required', title: 'Confirmation required', source: { app: 'cue', name: 'Cue' }, state: 'confirmation_required', message: 'This mock action will not run until you confirm.', elements: [{ type: 'text', text: `${targets}${proposed}`, role: 'body' }] });
        await showDocument(confirmation);
        log(`Confirmation required: ${targets}`);
      } else if (outcome.kind === 'document') {
        await showDocument(outcome.document);
        log('Local tool completed and returned a validated Cue Display Document');
      } else if (outcome.kind === 'no_tool') {
        const response = await postApi('/api/demo/respond', { prompt: clean });
        if (typeof response.text !== 'string' || !response.text.trim()) throw new Error('OpenRouter returned an empty response.');
        await showDocument(createDisplayDocument({
          id: 'cue-openrouter-response',
          title: 'Dots3 response',
          source: { app: 'openrouter', name: 'Dots3' },
          state: 'ready',
          elements: [{ type: 'text', text: response.text, role: 'body' }],
        }));
        log('No local tool matched; displayed the direct OpenRouter Dots3 response');
      } else {
        if (outcome.kind === 'clarification' && outcome.toolId) setTranscriptInput('');
        const message = outcome.kind === 'answer' ? outcome.text : outcome.kind === 'clarification' ? outcome.question : outcome.text;
        const state = outcome.kind === 'clarification' ? 'clarification_required' : outcome.kind === 'partial_failure' ? 'error' : 'ready';
        const title = outcome.kind === 'clarification' ? 'Clarification needed' : outcome.kind === 'no_tool' ? 'No matching tool' : outcome.kind === 'partial_failure' ? 'Operation partially failed' : 'Cue';
        const document = createDisplayDocument({ id: `cue-${outcome.kind}`, title, source: { app: 'cue', name: 'Cue' }, state, message, elements: [{ type: 'text', text: message ?? 'Please clarify your request.', role: 'body' }] });
        await showDocument(document);
        log(`Tool intelligence outcome: ${outcome.kind}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Processing error: ${message}`);
      try {
        await showDocument(createDisplayDocument({
          id: 'cue-processing-error',
          title: 'Processing failed',
          source: { app: 'cue', name: 'Cue' },
          state: 'error',
          message,
          elements: [{ type: 'text', text: message, role: 'body' }],
        }));
      } catch (displayError) {
        log(`Could not display processing error: ${displayError instanceof Error ? displayError.message : String(displayError)}`);
      }
      throw error;
    }
    finally { setBusy(false); }
  }

  async function confirmPendingAction(pendingActionOverride?: any, confirmedOnWatch = false) {
    const pendingAction = pendingActionOverride ?? pendingConfirmation;
    if (!pendingAction || !environment.current) return;
    const toolNames = pendingAction.call ? [pendingAction.call.toolId] : pendingAction.plan.operations.map((operation: any) => operation.toolId);
    const labels = toolNames.map((id: string) => environment.current.registry.get(id)?.name ?? id).join(', ');
    if (!confirmedOnWatch && !window.confirm(`Run the following local mock action(s)? ${labels}`)) {
      if (watch.connected) watchConfirmationRef.current = true;
      return;
    }
    setBusy(true);
    if (watch.connected) {
      try {
        await watch.sendDisplayDocument(createDisplayDocument({
          id: 'cue-confirming-action',
          title: 'Working',
          source: { app: 'cue', name: 'Cue' },
          state: 'loading',
          message: 'Running the confirmed action.',
        }));
      } catch (error) { log(`Could not update watch while confirming action: ${error instanceof Error ? error.message : String(error)}`); }
    }
    try {
      let document;
      if (pendingAction.fromWorkflow) {
        const outcome = await environment.current.intelligence.handle('yes', { confirmed: true, context: { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: navigator.language, weekStartsOn } });
        if (outcome.state) await postApi('/api/demo/conversation', { state: outcome.state });
        if (outcome.kind === 'confirmation_required') {
          updatePendingConfirmation({ call: outcome.pendingCall, fromWorkflow: true });
          watchConfirmationRef.current = true;
          if (watch.connected) {
            await watch.sendDisplayDocument(createDisplayDocument({
              id: 'cue-confirm-next-action',
              title: 'Confirmation required',
              source: { app: 'cue', name: 'Cue' },
              state: 'confirmation_required',
              message: 'A later step also needs your confirmation.',
              elements: [{ type: 'text', text: 'Review the next step, then choose Confirm or Cancel.', role: 'body' }],
            }));
          }
          return;
        }
        if (outcome.kind !== 'document') throw new Error(outcome.text ?? outcome.question ?? 'The confirmed workflow did not complete.');
        document = outcome.document;
      } else {
        const result = pendingAction.call
          ? await environment.current.dispatcher.dispatch(pendingAction.call, { confirmed: true })
          : await environment.current.dispatcher.dispatchPlan(pendingAction.plan, { confirmed: true });
        document = result.document;
      }
      updatePendingConfirmation(undefined);
      setPendingClarification(false);
      await showDocument(document);
      log(`Confirmed mock action completed: ${labels}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Confirmed action failed: ${message}`);
      if (watch.connected) {
        void watch.sendDisplayDocument(createDisplayDocument({
          id: 'cue-confirmed-action-error',
          title: 'Action failed',
          source: { app: 'cue', name: 'Cue' },
          state: 'error',
          message,
        })).catch(displayError => log(`Could not display action failure on watch: ${displayError instanceof Error ? displayError.message : String(displayError)}`));
      }
    }
    finally { setBusy(false); }
  }

  function cancelPendingOperation() {
    environment.current?.intelligence.cancelPendingOperation();
    updatePendingConfirmation(undefined);
    watchConfirmationRef.current = false;
    setPendingClarification(false);
    if (environment.current) void postApi('/api/demo/conversation', { state: environment.current.intelligence.getState() }).catch(error => log(`Could not persist cancellation: ${error instanceof Error ? error.message : String(error)}`));
    log('Pending operation cancelled');
  }

  async function resetDemoData() {
    if (!window.confirm('Reset this demo session to the committed synthetic baseline?')) return;
    setBusy(true);
    try {
      await postApi('/api/demo/reset', {});
      await postApi('/api/demo/conversation', { state: null });
      environment.current = undefined;
      displayDocumentRef.current = undefined;
      setDisplayDocument(undefined);
      updatePendingConfirmation(undefined);
      watchConfirmationRef.current = false;
      setPendingClarification(false);
      log('Demo session reset to the committed synthetic baseline');
    } catch (error) { log(`Demo reset failed: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setBusy(false); }
  }

  async function dispatchDocumentAction(action: any) {
    if (!environment.current) return;
    try {
      if (watch.connected) {
        await watch.sendDisplayDocument(createDisplayDocument({
          id: 'cue-action-working',
          title: 'Working',
          source: { app: 'cue', name: 'Cue' },
          state: 'loading',
          message: 'Running the selected action.',
        }));
      }
      const result = await environment.current.dispatcher.dispatch({ toolId: action.toolId, arguments: action.arguments });
      if (result.state === 'confirmation_required') {
        const pending = { call: { toolId: result.toolId, arguments: result.arguments }, fromWorkflow: false };
        updatePendingConfirmation(pending);
        if (watch.connected) {
          watchConfirmationRef.current = true;
          await watch.sendDisplayDocument(createDisplayDocument({
            id: 'cue-action-confirmation-required',
            title: 'Confirmation required',
            source: { app: 'cue', name: 'Cue' },
            state: 'confirmation_required',
            message: 'This mock action will not run until you confirm.',
            elements: [{ type: 'text', text: 'Review the pending action, then choose Confirm or Cancel.', role: 'body' }],
          }));
        }
        return;
      }
      await showDocument(result.document);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Display action rejected: ${message}`);
      if (watch.connected) {
        void watch.sendDisplayDocument(createDisplayDocument({
          id: 'cue-display-action-error',
          title: 'Action failed',
          source: { app: 'cue', name: 'Cue' },
          state: 'error',
          message,
        })).catch(displayError => log(`Could not display action failure on watch: ${displayError instanceof Error ? displayError.message : String(displayError)}`));
      }
    }
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
      if (watch.connected) {
        void watch.sendDisplayDocument(createDisplayDocument({
          id: 'cue-audio-pipeline-error',
          title: 'Recording failed',
          source: { app: 'cue', name: 'Cue' },
          state: 'error',
          message,
        })).catch(displayError => log(`Could not display recording failure on watch: ${displayError instanceof Error ? displayError.message : String(displayError)}`));
      }
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
    <h1>Cue</h1>
    <p>Enter a request for local tool discovery, argument resolution, and mock-provider execution. AI inference runs in your browser.</p>
    <section><h2>Devices</h2><button onClick={() => watch.connected ? watch.disconnect() : void connectWatch()}>{watch.connected ? 'Disconnect watch' : 'Connect Bangle.js'}</button> <span>{watchName}</span> <button disabled={!watch.connected || testSending} onClick={() => void sendWatchTest()}>{testSending ? 'Sending raw test…' : 'Send raw TEST to watch'}</button><p><button disabled={installing} onClick={() => void installOnWatch()}>{installing ? 'Installing…' : 'Install on watch'}</button></p>{installStatus && <p role="status">{installStatus}</p>}<details><summary>Manual downloads</summary><p>These files can also be installed with the Espruino Web IDE.</p><button onClick={() => downloadWatchFile('cue.app.js', watchAppSource)}>Download watch display app</button> <a href="https://www.espruino.com/ide/" target="_blank" rel="noreferrer">Open Espruino Web IDE</a></details><br /><button onClick={() => void toggleMicrophone()}>{recording ? 'Stop microphone' : 'Start microphone'}</button><button disabled={!recording || buffer < 0.2} onClick={freezeBuffer}>Freeze rolling buffer</button> <strong style={{ color: recording ? '#16803c' : '#777' }}>{recording ? '● Recording' : 'Microphone off'}</strong><p>Rolling buffer: {buffer.toFixed(1)} / 10.0 seconds (sample rate {audio.sampleRate || '—'} Hz)</p></section>
    <section><h2>Processing</h2>
      <fieldset disabled={busy}><legend>Argument normalizer</legend><div role="group" aria-label="Normalizer mode">
        <button type="button" aria-pressed={gemmaMode === 'automatic'} onClick={() => setGemmaPreference('automatic')}>Automatic</button>
        <button type="button" aria-pressed={gemmaMode === 'enabled'} onClick={() => setGemmaPreference('enabled')}>Enabled</button>
        <button type="button" aria-pressed={gemmaMode === 'disabled'} onClick={() => setGemmaPreference('disabled')}>Disabled</button>
      </div></fieldset>
      <p>Automatic and Enabled use OpenRouter for suitable requests, falling back to local Gemma if needed. Disabled skips model normalization. Requests, conversation context and matching provider records may be sent to OpenRouter; do not enter sensitive information.</p>
      <p role="status">Gemma fallback: {gemmaState.status}{gemmaState.progress?.reason ? ` — ${gemmaState.progress.reason}` : ''}{gemmaState.progress?.message ? ` — ${gemmaState.progress.message}` : ''}{gemmaState.progress?.generatedCharacters ? ` — ${gemmaState.progress.generatedCharacters} generated characters` : ''}</p>
      <label>Calendar week starts<select value={weekStartsOn} onChange={event => setCalendarWeekStart(Number(event.target.value))}><option value={1}>Monday</option><option value={0}>Sunday</option></select></label><label>Whisper model<select value={asrModel} disabled={busy} onChange={event => { const value = event.target.value as ASRModelSize; setAsrModel(value); asrModelRef.current = value; }}>{Object.entries(ASR_MODELS).map(([size, model]) => <option key={size} value={size}>{model.label}</option>)}</select></label><button disabled={!frozenAudio} onClick={() => void playFrozenRecording()}>{playbackActive ? 'Stop playback' : 'Play frozen recording'}</button><button disabled={busy || !recording || buffer < 0.2} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); void startHoldCapture(); }} onPointerUp={() => void finishHoldCapture()} onPointerCancel={() => void finishHoldCapture()} onLostPointerCapture={() => void finishHoldCapture()}>{holding ? 'Release to transcribe…' : 'Hold to transcribe (max 5 min)'}</button>{(['transcribe', 'embed'] as Stage[]).map(stage => <p key={stage}>{stage}: {status[stage]}{busy && <button onClick={() => stopStage(stage)}>Stop {stage}</button>}</p>)}<p>Tools and provider availability are loaded dynamically from the session's SQLite registry. MiniLM retrieval and deterministic argument resolution run in your browser.</p><label>Demo scenario<select value={scenario} onChange={event => { setScenario(event.target.value); setTranscriptInput(event.target.value); }}><option value="">Choose an example request</option>{DEMO_SCENARIOS.map(request => <option key={request} value={request}>{request}</option>)}</select></label><label>{pendingClarification ? 'Clarification' : 'Transcript text'}<textarea value={transcriptInput} onChange={event => { setTranscriptInput(event.target.value); setScenario(''); }} placeholder={pendingClarification ? 'Enter the missing details or a correction' : 'Enter sample transcript text'} /></label>{pendingClarification && <p role="status">Reply here to continue the pending request. Your message will go directly to that request.</p>}<button disabled={busy || !transcriptInput.trim()} onClick={() => void submitTranscript()}>{busy ? 'Processing…' : pendingClarification ? 'Send clarification' : 'Process transcript'}</button> <button disabled={busy} onClick={() => void resetDemoData()}>Reset demo session</button><label>Transcription (audio capture only)<textarea readOnly value={transcription} /></label><p>Embedding: {embedding ? `${embedding.dimensions} dimensions (${embedding.model ?? 'MiniLM'})` : 'Prepared on first request in the browser'}</p>{displayDocument && <><DisplayDocumentView document={displayDocument} onAction={action => void dispatchDocumentAction(action)} />{pendingConfirmation && <button disabled={busy} onClick={() => void confirmPendingAction()}>Confirm local mock action</button>}{pendingClarification && <button disabled={busy} onClick={cancelPendingOperation}>Cancel pending operation</button>}</>}</section>
    <section><h2>Status log</h2><pre>{logs.join('\n')}</pre></section>
  </main>;
}
