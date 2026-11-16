import { useEffect, useRef, useState } from 'react';
import { RollingAudio } from './services/audio';
import { BangleConnection } from './services/bluetooth';
import { ASR_MODELS, type ASRModelSize } from './services/asrModels';
import { createGemmaService } from './services/gemmaService.js';
import { createDisplayDocument, validateDisplayDocument } from './display/document.js';
import { DisplayDocumentView } from './display/DisplayDocumentView';
import { createDatabaseEnvironment } from './demo/databaseEnvironment.js';
import watchAppSource from '../watch/bangle-app.js?raw';

type Stage = 'transcribe' | 'embed' | 'rerank';
type WorkerReply = { id: number; stage: Stage; status: string; model?: string; result?: any; error?: string; message?: string; statusOnly?: boolean };
type RerankDecision = { topScore: number; secondScore: number | null; margin: number | null; minimumScore: number; minimumMargin: number; scorePassed: boolean; marginPassed: boolean; decision: 'selected' | 'ambiguous' };
type AiMode = 'web_ai' | 'automatic' | 'dots3_always';
type PlanExecutionState = {
  plan: { conversationId: string; originalRequest: string; status: string; operations: Array<{ id: string; toolId: string; status: string }> };
  pendingConfirmation?: { operationId: string; toolId: string; arguments: Record<string, unknown> };
  results: Record<string, unknown>;
  documents: Record<string, unknown>;
};
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

function interactionIdForState(state: any) {
  return `${state.conversationId}:${state.status}:${state.currentIndex ?? 0}`;
}

function createClarificationDocument(state: any, message: string) {
  const choices = state?.status === 'awaiting_tool_choice'
    ? (state.candidateTools ?? []).map((candidate: any) => ({ optionId: candidate.toolId, label: candidate.name }))
    : state?.status === 'awaiting_entity_choice'
      ? (state.pendingEntityOptions ?? []).map((option: any) => ({ optionId: option.id, label: option.label }))
      : [];
  const interactionId = interactionIdForState(state);
  const actions = choices.length >= 2 && choices.length <= 3
    ? choices.map((choice: any, index: number) => ({
      id: `cue-choice-${index}`,
      kind: 'interaction_option',
      interactionId,
      optionId: choice.optionId,
      label: choice.label,
    }))
    : [];
  const elements: any[] = [{ type: 'text', text: message, role: 'body' }];
  for (const action of actions) {
    elements.push({ type: 'action', actionId: action.id, label: action.label });
  }
  return createDisplayDocument({
    id: 'cue-clarification',
    title: 'Clarification needed',
    source: { app: 'cue', name: 'Cue' },
    state: 'clarification_required',
    message,
    elements,
    actions,
  });
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
  const [status, setStatus] = useState<Record<Stage, string>>({ transcribe: 'Not started', embed: 'Not started', rerank: 'Not started' });
  const [aiMode, setAiMode] = useState<AiMode>(() => {
    try {
      const savedMode = window.localStorage.getItem('cue.ai.mode');
      if (savedMode === 'web_ai' || savedMode === 'automatic' || savedMode === 'dots3_always') return savedMode;
      return 'automatic';
    } catch { return 'automatic'; }
  });
  const aiModeRef = useRef(aiMode);
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
  const resolvingInteractions = useRef(new Set<string>());

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
        if (state?.status === 'awaiting_confirmation' && state.executionState?.pendingConfirmation) {
          updatePendingConfirmation({ plan: state.executionState.plan, executionState: state.executionState, externalPlan: true });
        }
        if (state && ['awaiting_tool_choice', 'awaiting_argument', 'awaiting_entity_choice'].includes(state.status)) setPendingClarification(true);
        if (state && ['awaiting_tool_choice', 'awaiting_argument', 'awaiting_entity_choice', 'awaiting_confirmation'].includes(state.status)) {
          const pending = state.executionState?.pendingConfirmation;
          const message = pending
            ? `Confirm ${pending.toolId} with these arguments: ${JSON.stringify(pending.arguments)}`
            : state.pendingQuestion ?? 'Continue the pending local operation.';
          const document = state.status === 'awaiting_confirmation'
            ? createDisplayDocument({
              id: `cue-restored-${state.status}`,
              title: 'Confirmation required',
              source: { app: 'cue', name: 'Cue' },
              state: 'confirmation_required',
              message,
              elements: [{ type: 'text', text: message, role: 'body' }],
            })
            : createClarificationDocument(state, message);
          void showDocument(document).catch(error => log(`Could not restore pending request display: ${error instanceof Error ? error.message : String(error)}`));
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
        void cancelPendingOperation().catch(error => log(`Could not cancel pending operation: ${error instanceof Error ? error.message : String(error)}`));
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

  function setAiPreference(mode: AiMode) {
    aiModeRef.current = mode;
    setAiMode(mode);
    try { window.localStorage.setItem('cue.ai.mode', mode); }
    catch (error) { log(`Could not save AI mode: ${error instanceof Error ? error.message : String(error)}`); }
  }

  function setCalendarWeekStart(value: number) {
    setWeekStartsOn(value);
    try { window.localStorage.setItem('cue.calendar.weekStartsOn', String(value)); }
    catch (error) { log(`Could not save calendar week-start preference: ${error instanceof Error ? error.message : String(error)}`); }
  }

  function runModel(stage: Stage, data: { text?: string; candidates?: Array<{ toolId: string; text: string }>; asrModel?: ASRModelSize; audio?: Float32Array; sampleRate?: number }): Promise<WorkerReply> {
    const id = ++sequence.current;
    let instance = workers.get(stage);
    if (!instance) {
        instance = createWorker(stage);
        instance.onmessage = (event: MessageEvent<WorkerReply>) => {
          const reply = event.data;
          if (reply.status === 'notice' && reply.message) {
            setStatus(old => ({ ...old, [stage]: reply.message! }));
            if (!reply.statusOnly) log(reply.message);
            return;
          }
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
    const rerankTools = async (text: string, candidates: Array<{ toolId: string; text: string }>) => {
      const reply = await runModel('rerank', { text, candidates });
      if (reply.status === 'error') throw new Error(reply.error);
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
      argumentNormalizerEnabled: () => true,
      reasoningMode: () => aiModeRef.current,
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
      rerankTools,
      onRerankDecision: (decision: RerankDecision) => log(`Cross-encoder decision: top ${decision.topScore}, second ${decision.secondScore ?? 'none'}, margin ${decision.margin ?? 'n/a'}; score >= ${decision.minimumScore}: ${decision.scorePassed ? 'pass' : 'fail'}; margin >= ${decision.minimumMargin}: ${decision.margin === null ? 'not applicable' : decision.marginPassed ? 'pass' : 'fail'}; ${decision.decision}`),
      initialState: Array.isArray(initialState?.segments) ? initialState : undefined,
    });
    if (initialState?.status === 'awaiting_confirmation' && initialState.pendingConfirmation?.call) updatePendingConfirmation({ call: initialState.pendingConfirmation.call, fromWorkflow: true });
    if (initialState?.status === 'awaiting_confirmation' && initialState.executionState?.pendingConfirmation) {
      updatePendingConfirmation({ plan: initialState.executionState.plan, executionState: initialState.executionState, externalPlan: true });
    }
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

  async function processDots3Request(request: string, runtime: any, context: any) {
    const embedded = await runtime.intelligence.embed(request);
    const vector = Array.isArray(embedded) ? embedded : embedded.vector;
    const response = await postApi('/api/demo/reason', { request, context, vector });
    if (response.kind === 'clarification') {
      updatePendingConfirmation(undefined);
      await postApi('/api/demo/conversation', { state: response.state });
      setPendingClarification(true);
      await showDocument(createDisplayDocument({
        id: 'cue-dots3-clarification',
        title: 'Clarification needed',
        source: { app: 'cue', name: 'Cue' },
        state: 'clarification_required',
        message: response.question,
        elements: [{ type: 'text', text: response.question, role: 'body' }],
      }));
      return;
    }
    if (response.kind === 'no_tool') {
      updatePendingConfirmation(undefined);
      setPendingClarification(false);
      await showDocument(createDisplayDocument({
        id: 'cue-dots3-no-tool',
        title: 'Dots 3 response',
        source: { app: 'openrouter', name: 'Dots3' },
        state: 'ready',
        message: response.text,
        elements: [{ type: 'text', text: response.text, role: 'body' }],
      }));
      return;
    }
    if (response.kind !== 'plan' || !response.plan) throw new TypeError('Dots 3 returned an unsupported reasoning outcome.');

    const saveExecutionState = async (executionState: any) => {
      const state = executionState.plan.status === 'waiting_for_confirmation' ? 'awaiting_confirmation'
        : executionState.plan.status === 'completed' ? 'completed'
          : executionState.plan.status === 'failed' ? 'failed' : 'executing';
      await postApi('/api/demo/conversation', {
        state: {
          conversationId: executionState.plan.conversationId,
          status: state,
          originalRequest: executionState.plan.originalRequest,
          pendingQuestion: executionState.pendingConfirmation ? `Confirm ${executionState.pendingConfirmation.toolId}?` : undefined,
          executionState,
        },
      });
    };
    const outcome = await runtime.dispatcher.dispatchPlan(response.plan, { onStateChange: saveExecutionState });
    if (outcome.state === 'confirmation_required') {
      updatePendingConfirmation({ plan: outcome.plan, executionState: outcome.executionState, externalPlan: true });
      setPendingClarification(false);
      const pending = outcome.pendingConfirmation;
      const tool = runtime.registry.get(pending.toolId);
      await showDocument(createDisplayDocument({
        id: 'cue-dots3-confirmation',
        title: 'Confirmation required',
        source: { app: 'cue', name: 'Cue' },
        state: 'confirmation_required',
        message: `Confirm ${tool?.name ?? pending.toolId}?`,
        elements: [{ type: 'text', text: JSON.stringify(pending.arguments), role: 'body' }],
      }));
      return;
    }
    updatePendingConfirmation(undefined);
    setPendingClarification(false);
    await postApi('/api/demo/conversation', {
      state: {
        conversationId: outcome.plan.conversationId,
        status: outcome.plan.status,
        originalRequest: outcome.plan.originalRequest,
        executionState: outcome.executionState,
      },
    });
    if (outcome.document) await showDocument(outcome.document);
    else await showDocument(createDisplayDocument({
      id: 'cue-dots3-completed',
      title: 'Plan completed',
      source: { app: 'cue', name: 'Cue' },
      state: 'success',
      message: 'All required operations completed or were safely skipped.',
    }));
    log('Dots 3 plan completed under Cue validation and execution control');
  }

  async function processTranscript(text: string, continuePendingLocally = false) {
    const clean = text.trim();
    if (!clean) throw new Error('Enter transcript text first.');
    const pendingAction = pendingConfirmationRef.current;
    if (pendingAction?.externalPlan && /^(?:yes|yeah|yep|sure|ok|okay|confirm|confirmed|do it|go ahead)$/i.test(clean)) {
      setTranscriptInput('');
      await confirmPendingAction(pendingAction, true);
      return;
    }
    if (pendingAction?.externalPlan && /^(?:cancel|stop|never mind|nevermind|no|don't|do not)$/i.test(clean)) {
      setTranscriptInput('');
      await cancelPendingOperation();
      return;
    }
    if (pendingAction?.externalPlan) {
      setTranscriptInput('');
      const pending = pendingAction.executionState?.pendingConfirmation;
      const message = `This Dots 3 plan is awaiting confirmation with exact arguments${pending ? `: ${JSON.stringify(pending.arguments)}` : ''}. Confirm it as shown, or cancel it and submit a new request to make changes.`;
      await showDocument(createDisplayDocument({
        id: 'cue-dots3-confirmation-unchanged',
        title: 'Confirmation unchanged',
        source: { app: 'cue', name: 'Cue' },
        state: 'confirmation_required',
        message,
        elements: [{ type: 'text', text: message, role: 'body' }],
      }));
      return;
    }
    setTranscription(clean); setTranscriptInput(clean); setBusy(true);
    try {
      await showDocument(createDisplayDocument({ id: 'cue-loading', title: 'Working', source: { app: 'cue', name: 'Cue' }, state: 'loading', message: 'Discovering provider tools and preparing a local response.', elements: [{ type: 'text', text: clean, role: 'body' }] }));
      const runtime = await getEnvironment();
      const context = { now: new Date(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: navigator.language, weekStartsOn };
      const savedState = await getConversationState();
      if (savedState?.executionState?.pendingConfirmation) {
        const restoredPending = pendingAction?.externalPlan ? pendingAction : {
          plan: savedState.executionState.plan,
          executionState: savedState.executionState,
          externalPlan: true,
        };
        if (/^(?:yes|yeah|yep|sure|ok|okay|confirm|confirmed|do it|go ahead)$/i.test(clean)) {
          setTranscriptInput('');
          await confirmPendingAction(restoredPending, true);
          return;
        }
        if (/^(?:cancel|stop|never mind|nevermind|no|don't|do not)$/i.test(clean)) {
          setTranscriptInput('');
          await cancelPendingOperation();
          return;
        }
        setTranscriptInput('');
        const pending = savedState.executionState.pendingConfirmation;
        const message = `This Dots 3 plan is awaiting confirmation with exact arguments: ${JSON.stringify(pending.arguments)}. Confirm it as shown, or cancel it and submit a new request to make changes.`;
        await showDocument(createDisplayDocument({
          id: 'cue-dots3-confirmation-unchanged',
          title: 'Confirmation unchanged',
          source: { app: 'cue', name: 'Cue' },
          state: 'confirmation_required',
          message,
          elements: [{ type: 'text', text: message, role: 'body' }],
        }));
        return;
      }
      if (!continuePendingLocally && (aiModeRef.current === 'dots3_always' || savedState?.pendingReasoning
        || (savedState?.executionState && ['awaiting_confirmation', 'executing'].includes(savedState.status)))) {
        await processDots3Request(clean, runtime, context);
        return;
      }
      const outcome = await runtime.intelligence.handle(clean, { context: { now: new Date(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: navigator.language, weekStartsOn } });
      if (outcome.state) await postApi('/api/demo/conversation', { state: outcome.state });
      const rerankDiagnostics = outcome.diagnostics?.rerank ?? outcome.retrieval?.rerankDiagnostics;
      if (rerankDiagnostics?.candidates) {
        log(`Cross-encoder ranking: ${rerankDiagnostics.candidates.map((item: any) => `${item.toolId} ${item.score.toFixed(3)}`).join(', ')}`);
      }
      if (!continuePendingLocally && aiModeRef.current === 'automatic' && outcome.state?.status === 'awaiting_tool_choice') {
        log(rerankDiagnostics?.error
          ? `Cross-encoder unavailable: ${rerankDiagnostics.error}; trying the configured Dots 3 fallback`
          : rerankDiagnostics?.candidates
            ? 'Cross-encoder scores or margin below routing thresholds; trying the configured Dots 3 fallback'
            : 'Tool choice remains uncertain; cross-encoder result unavailable for this outcome; trying the configured Dots 3 fallback');
        await processDots3Request(clean, runtime, context);
        return;
      }
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
        const message = 'No matching registered tool was found. Try rephrasing the request or choose a supported provider action.';
        await showDocument(createDisplayDocument({
          id: 'cue-no-tool',
          title: 'No matching tool',
          source: { app: 'cue', name: 'Cue' },
          state: 'ready',
          message,
          elements: [{ type: 'text', text: message, role: 'body' }],
        }));
        log('No local tool matched; no external request was made');
      } else {
        if (outcome.kind === 'clarification' && outcome.toolId) setTranscriptInput('');
        const message = outcome.kind === 'answer' ? outcome.text : outcome.kind === 'clarification' ? outcome.question : outcome.text;
        const state = outcome.kind === 'clarification' ? 'clarification_required' : outcome.kind === 'partial_failure' ? 'error' : 'ready';
        const title = outcome.kind === 'clarification' ? 'Clarification needed' : outcome.kind === 'no_tool' ? 'No matching tool' : outcome.kind === 'partial_failure' ? 'Operation partially failed' : 'Cue';
        const document = outcome.kind === 'clarification' && outcome.state
          ? createClarificationDocument(outcome.state, message ?? 'Please clarify your request.')
          : createDisplayDocument({ id: `cue-${outcome.kind}`, title, source: { app: 'cue', name: 'Cue' }, state, message, elements: [{ type: 'text', text: message ?? 'Please clarify your request.', role: 'body' }] });
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
    const pendingAction = pendingActionOverride ?? pendingConfirmationRef.current;
    if (!pendingAction) return;
    const runtime = environment.current ?? await getEnvironment();
    const toolNames = pendingAction.call ? [pendingAction.call.toolId] : pendingAction.plan.operations.map((operation: any) => operation.toolId);
    const labels = toolNames.map((id: string) => runtime.registry.get(id)?.name ?? id).join(', ');
    const proposedArguments = pendingAction.executionState?.pendingConfirmation?.arguments
      ?? pendingAction.call?.arguments;
    const details = proposedArguments ? ` Proposed arguments: ${JSON.stringify(proposedArguments)}` : '';
    if (!confirmedOnWatch && !window.confirm(`Run the following local mock action(s)? ${labels}.${details}`)) {
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
        const outcome = await runtime.intelligence.handle('yes', { confirmed: true, context: { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: navigator.language, weekStartsOn } });
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
      } else if (pendingAction.executionState) {
        const executionState = pendingAction.executionState;
        const outcome = await runtime.dispatcher.dispatchPlan(executionState.plan, {
          confirmed: true,
          confirmedOperationId: executionState.pendingConfirmation?.operationId,
          executionState,
          onStateChange: async (state: PlanExecutionState) => postApi('/api/demo/conversation', {
            state: {
              conversationId: state.plan.conversationId,
              status: state.plan.status === 'waiting_for_confirmation' ? 'awaiting_confirmation'
                : state.plan.status === 'completed' ? 'completed'
                  : state.plan.status === 'failed' ? 'failed' : 'executing',
              originalRequest: state.plan.originalRequest,
              pendingQuestion: state.pendingConfirmation ? `Confirm ${state.pendingConfirmation.toolId}?` : undefined,
              executionState: state,
            },
          }),
        });
        if (outcome.state === 'confirmation_required') {
          updatePendingConfirmation({ plan: outcome.plan, executionState: outcome.executionState, externalPlan: true });
          watchConfirmationRef.current = true;
          await showDocument(createDisplayDocument({
            id: 'cue-confirm-next-plan-operation',
            title: 'Confirmation required',
            source: { app: 'cue', name: 'Cue' },
            state: 'confirmation_required',
            message: `Confirm ${runtime.registry.get(outcome.pendingConfirmation.toolId)?.name ?? outcome.pendingConfirmation.toolId}?`,
            elements: [{ type: 'text', text: JSON.stringify(outcome.pendingConfirmation.arguments), role: 'body' }],
          }));
          return;
        }
        document = outcome.document ?? createDisplayDocument({
          id: 'cue-plan-completed',
          title: 'Plan completed',
          source: { app: 'cue', name: 'Cue' },
          state: 'success',
          message: 'All required operations completed or were safely skipped.',
        });
      } else {
        const result = pendingAction.call
          ? await runtime.dispatcher.dispatch(pendingAction.call, { confirmed: true })
          : await runtime.dispatcher.dispatchPlan(pendingAction.plan, { confirmed: true });
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

  async function cancelPendingOperation() {
    const savedState = await getConversationState().catch(error => {
      log(`Could not load pending state for cancellation: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    });
    const pendingExecution = pendingConfirmationRef.current?.executionState ?? savedState?.executionState;
    if (pendingExecution) {
      const cancelled = structuredClone(pendingExecution);
      cancelled.plan.status = 'cancelled';
      if (cancelled.pendingConfirmation) {
        const operation = cancelled.plan.operations.find((item: any) => item.id === cancelled.pendingConfirmation.operationId);
        if (operation) operation.status = 'skipped';
      }
      cancelled.pendingConfirmation = undefined;
      await postApi('/api/demo/conversation', {
        state: {
          conversationId: cancelled.plan.conversationId,
          status: 'cancelled',
          originalRequest: cancelled.plan.originalRequest,
          executionState: cancelled,
        },
      });
    } else if (savedState?.pendingReasoning) {
      await postApi('/api/demo/conversation', { state: { ...savedState, status: 'cancelled', pendingReasoning: false } });
    } else {
      environment.current?.intelligence.cancelPendingOperation();
      if (environment.current) await postApi('/api/demo/conversation', { state: environment.current.intelligence.getState() });
    }
    updatePendingConfirmation(undefined);
    watchConfirmationRef.current = false;
    setPendingClarification(false);
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
    try {
      if (action?.kind === 'interaction_option') {
        const key = `${action.interactionId}:${action.optionId}`;
        if (resolvingInteractions.current.has(key)) return;
        resolvingInteractions.current.add(key);
        try {
          const state = await getConversationState();
          if (!state || action.interactionId !== interactionIdForState(state)) throw new Error('This clarification choice has expired.');
          const options = state.status === 'awaiting_tool_choice'
            ? (state.candidateTools ?? []).map((candidate: any) => candidate.toolId)
            : state.status === 'awaiting_entity_choice'
              ? (state.pendingEntityOptions ?? []).map((option: any) => option.id)
              : [];
          if (!options.includes(action.optionId)) throw new Error('This clarification choice is not valid for the pending interaction.');
          await processTranscript(action.optionId, true);
          setTranscriptInput('');
        } finally {
          resolvingInteractions.current.delete(key);
        }
        return;
      }
      if (!environment.current) return;
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
    <p>Enter a request for tool discovery, argument resolution, and provider execution. Cue validates and controls every operation.</p>
    <section><h2>Devices</h2><button onClick={() => watch.connected ? watch.disconnect() : void connectWatch()}>{watch.connected ? 'Disconnect watch' : 'Connect Bangle.js'}</button> <span>{watchName}</span> <button disabled={!watch.connected || testSending} onClick={() => void sendWatchTest()}>{testSending ? 'Sending raw test…' : 'Send raw TEST to watch'}</button><p><button disabled={installing} onClick={() => void installOnWatch()}>{installing ? 'Installing…' : 'Install on watch'}</button></p>{installStatus && <p role="status">{installStatus}</p>}<details><summary>Manual downloads</summary><p>These files can also be installed with the Espruino Web IDE.</p><button onClick={() => downloadWatchFile('cue.app.js', watchAppSource)}>Download watch display app</button> <a href="https://www.espruino.com/ide/" target="_blank" rel="noreferrer">Open Espruino Web IDE</a></details><br /><button onClick={() => void toggleMicrophone()}>{recording ? 'Stop microphone' : 'Start microphone'}</button><button disabled={!recording || buffer < 0.2} onClick={freezeBuffer}>Freeze rolling buffer</button> <strong style={{ color: recording ? '#16803c' : '#777' }}>{recording ? '● Recording' : 'Microphone off'}</strong><p>Rolling buffer: {buffer.toFixed(1)} / 10.0 seconds (sample rate {audio.sampleRate || '—'} Hz)</p></section>
    <section><h2>Processing</h2>
      <label>AI mode<select value={aiMode} disabled={busy} onChange={event => {
        const value = event.target.value;
        if (value === 'web_ai' || value === 'automatic' || value === 'dots3_always') setAiPreference(value);
      }}>
        <option value="web_ai">Web AI</option>
        <option value="automatic">Automatic</option>
        <option value="dots3_always">Always Dots 3</option>
      </select></label>
      <p>Web AI uses browser-side MiniLM, deterministic logic, and local Gemma when available; it never calls OpenRouter. Automatic tries local reasoning first and uses Dots 3 through OpenRouter only when local tool selection is ambiguous. Always Dots 3 sends the current request, relevant schemas, and necessary pending context to OpenRouter for reasoning. Requests still reach Cue’s backend for registered provider operations; do not enter sensitive information in external modes.</p>
      <p role="status">Local Gemma: {gemmaState.status}{gemmaState.progress?.reason ? ` — ${gemmaState.progress.reason}` : ''}{gemmaState.progress?.message ? ` — ${gemmaState.progress.message}` : ''}{gemmaState.progress?.generatedCharacters ? ` — ${gemmaState.progress.generatedCharacters} generated characters` : ''}</p>
      <label>Calendar week starts<select value={weekStartsOn} onChange={event => setCalendarWeekStart(Number(event.target.value))}><option value={1}>Monday</option><option value={0}>Sunday</option></select></label><label>Whisper model<select value={asrModel} disabled={busy} onChange={event => { const value = event.target.value as ASRModelSize; setAsrModel(value); asrModelRef.current = value; }}>{Object.entries(ASR_MODELS).map(([size, model]) => <option key={size} value={size}>{model.label}</option>)}</select></label><button disabled={!frozenAudio} onClick={() => void playFrozenRecording()}>{playbackActive ? 'Stop playback' : 'Play frozen recording'}</button><button disabled={busy || !recording || buffer < 0.2} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); void startHoldCapture(); }} onPointerUp={() => void finishHoldCapture()} onPointerCancel={() => void finishHoldCapture()} onLostPointerCapture={() => void finishHoldCapture()}>{holding ? 'Release to transcribe…' : 'Hold to transcribe (max 5 min)'}</button>{(['transcribe', 'embed', 'rerank'] as Stage[]).map(stage => <p key={stage}>{stage === 'rerank' ? 'cross-encoder' : stage}: {status[stage]}{busy && <button onClick={() => stopStage(stage)}>Stop {stage === 'rerank' ? 'cross-encoder' : stage}</button>}</p>)}<p>Tools and provider availability are loaded dynamically from the session's SQLite registry. MiniLM retrieval and deterministic argument resolution run in your browser.</p><label>Demo scenario<select value={scenario} onChange={event => { setScenario(event.target.value); setTranscriptInput(event.target.value); }}><option value="">Choose an example request</option>{DEMO_SCENARIOS.map(request => <option key={request} value={request}>{request}</option>)}</select></label><label>{pendingClarification ? 'Clarification' : 'Transcript text'}<textarea value={transcriptInput} onChange={event => { setTranscriptInput(event.target.value); setScenario(''); }} placeholder={pendingClarification ? 'Enter the missing details or a correction' : 'Enter sample transcript text'} /></label>{pendingClarification && <p role="status">Reply here to continue the pending request. Your message will go directly to that request.</p>}<button disabled={busy || !transcriptInput.trim()} onClick={() => void submitTranscript()}>{busy ? 'Processing…' : pendingClarification ? 'Send clarification' : 'Process transcript'}</button> <button disabled={busy} onClick={() => void resetDemoData()}>Reset demo session</button><label>Transcription (audio capture only)<textarea readOnly value={transcription} /></label><p>Embedding: {embedding ? `${embedding.dimensions} dimensions (${embedding.model ?? 'MiniLM'})` : 'Prepared on first request in the browser'}</p>{displayDocument && <><DisplayDocumentView document={displayDocument} onAction={action => void dispatchDocumentAction(action)} />{pendingConfirmation && <button disabled={busy} onClick={() => void confirmPendingAction()}>Confirm local mock action</button>}{pendingClarification && <button disabled={busy} onClick={() => void cancelPendingOperation().catch(error => log(`Could not cancel pending operation: ${error instanceof Error ? error.message : String(error)}`))}>Cancel pending operation</button>}</>}</section>
    <section><h2>Status log</h2><pre>{logs.join('\n')}</pre></section>
  </main>;
}
