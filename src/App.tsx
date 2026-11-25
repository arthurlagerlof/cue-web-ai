import { useEffect, useRef, useState } from 'react';
import { Bluetooth, Mic, RotateCcw, Settings } from 'lucide-react';
import { RollingAudio } from './services/audio';
import { CLOUD_MODEL, transcribeInCloud } from './services/cloudTranscription.js';
import { assessGpu } from './services/deviceDefaults.js';
import { watch } from './services/watch';
import { ASR_MODELS, type ASRModelSize } from './services/asrModels';
import { createDisplayDocument, parseDisplayDocument, validateDisplayDocument } from './display/document.js';
import { DisplayDocumentView } from './display/DisplayDocumentView';
import { createDatabaseEnvironment } from './demo/databaseEnvironment.js';
import { DEMO_SCENARIOS } from './demo/demoScenarios.js';
import { openBrowserDatabase } from './storage/userDatabase';
import { answerWithOpenRouter, normalizeWithOpenRouter, planWithOpenRouter } from './intelligence/openRouter.js';
import { isLocalWorkflowContinuation, shouldUseCloudWhileLoading } from './intelligence/localModelRouting.js';
import { clarificationHasCompletedSideEffects, clarificationRestart } from './intelligence/toolIntelligence.js';
import { navigateTo } from './navigation';
import watchAppSource from '../watch/bangle-app.js?raw';
import type { StorageValue } from './storage/storage';
import {
  beginRequestMeasurement,
  completeRequestMeasurement,
  flushTelemetryQueue,
  markMultiStep,
  recordClarification,
  recordExternalCall,
  recordIndexInitialization,
  recordLocalInference,
  recordLocalProcessing,
  recordToolExecution,
  restoreRequestMeasurement,
  serializeRequestMeasurement,
  type CompletionStatus,
  type RequestMeasurement,
} from './statistics';

type Stage = 'transcribe' | 'embed' | 'rerank';
type TranscriptionModel = ASRModelSize | 'cloud';
type WorkerReply = { id: number; stage: Stage; status: string; model?: string; result?: any; error?: string; message?: string; statusOnly?: boolean };
type ChatMessage = { id: string; role: 'user'; text: string } | { id: string; role: 'assistant'; document: any };
type RerankDecision = { topScore: number; secondScore: number | null; margin: number | null; minimumScore: number; minimumMargin: number; scorePassed: boolean; marginPassed: boolean; decision: 'selected' | 'ambiguous' };
type AiMode = 'web_ai' | 'automatic' | 'dots3_always';
type PlanExecutionState = {
  plan: { conversationId: string; originalRequest: string; status: string; operations: Array<{ id: string; toolId: string; status: string }> };
  pendingConfirmation?: { operationId: string; toolId: string; arguments: Record<string, unknown> };
  results: Record<string, unknown>;
  documents: Record<string, unknown>;
  reasoningHistory?: Array<{ question: string; answer: string }>;
};
const workers = new Map<Stage, Worker>();
function createWorker(stage: Stage) {
  const instance = new Worker(new URL('./services/model.worker.ts', import.meta.url), { type: 'module' });
  workers.set(stage, instance);
  return instance;
}
const recordingLimitSeconds = 5 * 60;
const audio = new RollingAudio(10);

function downloadWatchFile(filename: string, source: string) {
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function getConversationState(): Promise<any> {
  return (await openBrowserDatabase()).getConversationState();
}

async function saveConversationState(state: any) {
  return (await openBrowserDatabase()).saveConversationState(state);
}

function interactionIdForState(state: any) {
  return `${state.conversationId}:${state.status}:${state.currentIndex ?? 0}`;
}

function clockForRuntime(runtime: any) {
  const now = runtime.demoClock ? new Date(runtime.demoClock) : new Date();
  if (Number.isNaN(now.getTime())) throw new TypeError('The configured demo clock is invalid.');
  return now;
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

export default function App() {
  const [watchName, setWatchName] = useState(watch.status);
  const [installing, setInstalling] = useState(false);
  const [testSending, setTestSending] = useState(false);
  const [installStatus, setInstallStatus] = useState('');
  const [recording, setRecording] = useState(false);
  const [buffer, setBuffer] = useState(0);
  const [asrModel, setAsrModel] = useState<TranscriptionModel>('cloud');
  const asrModelRef = useRef(asrModel);
  const [status, setStatus] = useState<Record<Stage, string>>({ transcribe: 'Not started', embed: 'Not started', rerank: 'Not started' });
  const [savedAiMode] = useState<AiMode | undefined>(() => {
    try {
      const savedMode = window.localStorage.getItem('cue.ai.mode');
      if (savedMode === 'web_ai' || savedMode === 'automatic' || savedMode === 'dots3_always') return savedMode;
    } catch (error) {
      console.error('Could not read the saved AI mode:', error);
    }
    return undefined;
  });
  const [aiMode, setAiMode] = useState<AiMode>(savedAiMode ?? 'dots3_always');
  const aiModeRef = useRef(aiMode);
  const aiModeChosen = useRef(savedAiMode !== undefined);
  const asrModelChosen = useRef(false);
  const [checkingGpu, setCheckingGpu] = useState(true);
  const checkingGpuRef = useRef(true);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
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
  const transcriptionAbort = useRef<AbortController>();
  const environment = useRef<any>();
  const displayDocumentRef = useRef<any>();
  const pendingConfirmationRef = useRef<any>();
  const watchConfirmationRef = useRef(false);
  const connectionDialogRef = useRef<HTMLDialogElement>(null);
  const settingsDialogRef = useRef<HTMLDialogElement>(null);
  const microphoneDialogRef = useRef<HTMLDialogElement>(null);
  const pending = useRef(new Map<number, { stage: Stage; resolve: (reply: WorkerReply) => void; measurement?: RequestMeasurement; inferenceStartedAt?: number; inferenceModel?: string }>());
  const readyModels = useRef(new Set<Stage>());
  const modelWarmups = useRef<Partial<Record<'embed' | 'rerank', Promise<WorkerReply>>>>({});
  const localContinuation = useRef(false);
  const resolvingInteractions = useRef(new Set<string>());
  const activeRequest = useRef<RequestMeasurement>();
  const chatLogRef = useRef<HTMLDivElement>(null);
  const chatStickToBottom = useRef(true);

  useEffect(() => {
    let active = true;
    const gpu = (navigator as Navigator & { gpu?: Parameters<typeof assessGpu>[0] }).gpu;
    void assessGpu(gpu).then(result => {
      if (!active) return;
      log(result.reason);
      if (!aiModeChosen.current) {
        const mode = result.preferLocal ? 'automatic' : 'dots3_always';
        aiModeRef.current = mode;
        setAiMode(mode);
      }
      if (!asrModelChosen.current) {
        const model = result.preferLocal ? 'tiny' : 'cloud';
        asrModelRef.current = model;
        setAsrModel(model);
      }
      checkingGpuRef.current = false;
      setCheckingGpu(false);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const dialog = microphoneDialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  useEffect(() => {
    const element = chatLogRef.current;
    if (element && chatStickToBottom.current) element.scrollTop = element.scrollHeight;
  }, [chatMessages, displayDocument, busy]);

  const log = (message: string) => setLogs(old => [`${new Date().toLocaleTimeString()} ${message}`, ...old].slice(0, 30));
  const appendUserMessage = (text: string) => {
    chatStickToBottom.current = true;
    setChatMessages(old => [...old, { id: crypto.randomUUID(), role: 'user', text }]);
  };
  const recordUsage = async (counter: string) => {
    try { await (await openBrowserDatabase()).recordUsage(counter); }
    catch (error) { log(`Could not save local usage statistics: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const onExternalCall = (call: { provider: string; model: string; latencyMs: number; inputTokens?: number; outputTokens?: number; success: boolean; made: boolean }) => {
    recordExternalCall(activeRequest.current, call);
    if (call.made) {
      void recordUsage('externalCalls');
      if (activeRequest.current?.selectedMode === 'dots3_always') void recordUsage('dots3Calls');
    }
  };
  const addClarification = async () => {
    recordClarification(activeRequest.current);
    await recordUsage('clarifications');
  };
  async function persistRequestMeasurement(measurement: RequestMeasurement, status: CompletionStatus) {
    const statistic = completeRequestMeasurement(measurement, status);
    if (activeRequest.current === measurement) activeRequest.current = undefined;
    try {
      const database = await openBrowserDatabase();
      await database.recordRequestStatistic(statistic);
      await database.setPreference('activeRequestMeasurement', null);
      if (await database.getPreference<boolean>('sharePublicTelemetryWithRequestText') === true) {
        if (statistic.requestText && new TextEncoder().encode(statistic.requestText).length > 100000) {
          log('Request statistics were saved locally but not shared: request text exceeds the 100 KB telemetry limit.');
          return;
        }
        await database.queueRequestStatistic(statistic);
        void flushTelemetryQueue(database).then(result => {
          if (result.failed) log('Telemetry upload is queued and will retry when available.');
        }).catch(error => log(`Telemetry retry could not be scheduled: ${error instanceof Error ? error.message : String(error)}`));
      }
    } catch (error) {
      log(`Could not save local request statistics: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async function retainRequestMeasurement(measurement: RequestMeasurement) {
    try {
      await (await openBrowserDatabase()).setPreference('activeRequestMeasurement', serializeRequestMeasurement(measurement));
    } catch (error) {
      log(`Could not save a pending request measurement: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const updatePendingConfirmation = (pending: any) => {
    pendingConfirmationRef.current = pending;
    setPendingConfirmation(pending);
  };
  useEffect(() => {
    const syncMicrophone = () => {
      setRecording(audio.active);
      setBuffer(audio.bufferedSeconds);
      void watch.setMicrophoneActive(audio.active).catch(error => log(`Could not sync microphone status to watch: ${error instanceof Error ? error.message : String(error)}`));
    };
    const unsubscribe = audio.subscribe(syncMicrophone);
    syncMicrophone();
    let telemetryDatabase: Awaited<ReturnType<typeof openBrowserDatabase>> | undefined;
    const retryTelemetry = () => {
      if (telemetryDatabase) void flushTelemetryQueue(telemetryDatabase)
        .catch(error => log(`Telemetry retry failed: ${error instanceof Error ? error.message : String(error)}`));
    };
    window.addEventListener('online', retryTelemetry);
    void openBrowserDatabase()
      .then(async database => {
        telemetryDatabase = database;
        retryTelemetry();
        const [state, storedMeasurement] = await Promise.all([
          database.getConversationState(),
          database.getPreference<StorageValue>('activeRequestMeasurement'),
        ]);
        if (typeof state?.status === 'string'
          && ['awaiting_confirmation', 'awaiting_tool_choice', 'awaiting_argument', 'awaiting_entity_choice'].includes(state.status)
          && storedMeasurement) {
          try { activeRequest.current = restoreRequestMeasurement(storedMeasurement); }
          catch (error) { log(`Could not restore the pending request measurement: ${error instanceof Error ? error.message : String(error)}`); }
        } else if (storedMeasurement) {
          await database.setPreference('activeRequestMeasurement', null);
        }
        return state;
      })
      .then((state: any) => {
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
      .catch(error => log(`Local browser database unavailable: ${error instanceof Error ? error.message : 'initialization failed'}`));
    watch.onTrigger = () => {
      log('Watch tap-to-trigger received');
      transcribeBuffer();
    };
    watch.onAction = actionId => {
      if (actionId === '__cue_restart' && displayDocumentRef.current?.state === 'clarification_required') {
        void restartClarification().catch(error => {
          const message = `Could not restart pending request: ${error instanceof Error ? error.message : String(error)}`;
          log(message);
          void watch.sendDisplayDocument(createDisplayDocument({
            id: 'cue-restart-error', title: 'Restart failed', source: { app: 'cue', name: 'Cue' }, state: 'error', message,
          })).catch(displayError => log(`Could not display restart error: ${displayError instanceof Error ? displayError.message : String(displayError)}`));
        });
        return;
      }
      if (actionId === '__cue_confirm' && watchConfirmationRef.current) {
        watchConfirmationRef.current = false;
        if (pendingConfirmationRef.current) {
          appendUserMessage('Confirm');
          void confirmPendingAction(pendingConfirmationRef.current, true);
        }
        else log('Ignored watch confirmation without a pending action');
        return;
      }
      if (actionId === '__cue_cancel' && watchConfirmationRef.current) {
        watchConfirmationRef.current = false;
        if (!pendingConfirmationRef.current) {
          log('Ignored watch cancellation without a pending action');
          return;
        }
        appendUserMessage('Cancel');
        void cancelPendingOperation().then(() => showDocument(createDisplayDocument({
          id: 'cue-watch-cancelled',
          title: 'Cancelled',
          source: { app: 'cue', name: 'Cue' },
          state: 'success',
          message: 'The pending action was cancelled.',
        }))).catch(error => log(`Could not cancel pending operation: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      const action = displayDocumentRef.current?.actions?.find((item: any) => item.id === actionId);
      if (action) void dispatchDocumentAction(action);
      else log(`Ignored unknown watch action: ${actionId}`);
    };
    const unsubscribeWatchStatus = watch.subscribeStatus(message => {
      setWatchName(message.startsWith('Connected: ') ? message.slice('Connected: '.length) : message);
      if (message === 'Watch disconnected') log(message);
    });
    watch.onDiagnostic = message => log(`BLE: ${message}`);
    return () => { window.removeEventListener('online', retryTelemetry); transcriptionAbort.current?.abort(); audio.stop(); unsubscribe(); unsubscribeWatchStatus(); playbackRef.current?.stop(); workers.forEach(instance => instance.terminate()); workers.clear(); watch.onTrigger = undefined; watch.onAction = undefined; watch.onDiagnostic = undefined; };
  }, []);

  function setAiPreference(mode: AiMode) {
    aiModeChosen.current = true;
    aiModeRef.current = mode;
    setAiMode(mode);
    try { window.localStorage.setItem('cue.ai.mode', mode); }
    catch (error) { log(`Could not save AI mode: ${error instanceof Error ? error.message : String(error)}`); }
  }

  function runModel(stage: Stage, data: { text?: string; candidates?: Array<{ toolId: string; text: string }>; asrModel?: ASRModelSize; audio?: Float32Array; sampleRate?: number }, measureRequest = true): Promise<WorkerReply> {
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
          const task = pending.current.get(reply.id);
          if (reply.status === 'running' && task) {
            task.inferenceStartedAt = performance.now();
            task.inferenceModel = reply.model;
            log(`Local model started (${stage}): ${reply.model ?? 'unknown model'}`);
          }
          if (reply.status !== 'complete' && reply.status !== 'error') {
            setStatus(old => ({ ...old, [stage]: `${reply.status}${reply.model ? ` — ${reply.model}` : ''}` })); return;
          }
          setStatus(old => ({ ...old, [stage]: reply.status === 'error' ? `Error — ${reply.error}` : `Complete — ${reply.model ?? 'done'}` }));
          if (task) {
            if (reply.status === 'complete') readyModels.current.add(stage);
            else readyModels.current.delete(stage);
            const durationMs = task.inferenceStartedAt === undefined ? undefined : performance.now() - task.inferenceStartedAt;
            if (durationMs !== undefined) recordLocalInference(task.measurement, reply.model ?? task.inferenceModel, durationMs);
            const model = reply.model ?? task.inferenceModel ?? 'unknown model';
            const duration = durationMs === undefined ? '' : ` in ${(durationMs / 1000).toFixed(1)}s`;
            log(reply.status === 'error'
              ? `Local model failed (${stage}): ${model}${duration} — ${reply.error ?? 'Unknown error'}`
              : `Local model completed (${stage}): ${model}${duration}`);
            pending.current.delete(reply.id);
            task.resolve(reply);
          }
        };
        instance.onerror = event => {
          const message = event.message || 'Model worker failed.';
          instance!.terminate();
          if (workers.get(stage) === instance) workers.delete(stage);
          readyModels.current.delete(stage);
          setStatus(old => ({ ...old, [stage]: `Error — ${message}` }));
          pending.current.forEach((task, pendingId) => {
            if (task.stage === stage) {
              if (task.inferenceStartedAt !== undefined) recordLocalInference(task.measurement, task.inferenceModel, performance.now() - task.inferenceStartedAt);
              task.resolve({ id: pendingId, stage, status: 'error', error: message });
              pending.current.delete(pendingId);
            }
          });
          log(message);
        };
    }
    return new Promise(resolve => { pending.current.set(id, { stage, resolve, measurement: measureRequest ? activeRequest.current : undefined }); instance!.postMessage({ id, stage, ...data }, data.audio ? [data.audio.buffer] : []); });
  }

  function warmModel(stage: 'embed' | 'rerank', data: { text: string; candidates?: Array<{ toolId: string; text: string }> }) {
    if (readyModels.current.has(stage) || modelWarmups.current[stage]) return;
    const warmup = Promise.resolve().then(() => runModel(stage, data, false)).catch(error => ({
      id: 0, stage, status: 'error', error: error instanceof Error ? error.message : String(error),
    }));
    modelWarmups.current[stage] = warmup;
    void warmup.then(reply => {
      if (reply.status === 'error') log(`Could not prepare local ${stage} model: ${reply.error ?? 'Unknown error'}`);
    }).finally(() => {
      if (modelWarmups.current[stage] === warmup) delete modelWarmups.current[stage];
    });
  }

  async function getEnvironment(forceRetrieval = false, skipRetrieval = false) {
    if (environment.current) {
      if (!skipRetrieval && (forceRetrieval || aiModeRef.current !== 'dots3_always')) await environment.current.ensureRetrieval();
      return environment.current;
    }
    const loadingMeasurement = activeRequest.current;
    const loadingStartedAt = performance.now();
    const { database, registryData, initialState } = await (async () => {
      try {
        const database = await openBrowserDatabase();
        const registryData = await database.getRegistryData();
        const initialState: any = await database.getConversationState();
        return { database, registryData, initialState };
      } finally {
        recordIndexInitialization(loadingMeasurement, performance.now() - loadingStartedAt);
      }
    })();
    const embed = async (text: string, options?: { purpose?: string }) => {
      await modelWarmups.current.embed;
      const reply = await runModel('embed', { text }, options?.purpose !== 'index');
      if (reply.status === 'error') throw new Error(reply.error);
      setEmbedding({ ...reply.result, model: reply.model });
      return reply.result;
    };
    const rerankTools = async (text: string, candidates: Array<{ toolId: string; text: string }>) => {
      if (shouldUseCloudWhileLoading(aiModeRef.current, readyModels.current.has('rerank'), localContinuation.current)) {
        warmModel('rerank', { text, candidates });
        throw new Error('Local cross-encoder is still loading');
      }
      await modelWarmups.current.rerank;
      const reply = await runModel('rerank', { text, candidates });
      if (reply.status === 'error') throw new Error(reply.error);
      return reply.result;
    };
    if (database.storageWarning) log(database.storageWarning);
    environment.current = await createDatabaseEnvironment({
      database,
      registryData,
      embed,
      initializeRetrieval: !skipRetrieval && (forceRetrieval || aiModeRef.current !== 'dots3_always'),
      onToolExecution: (durationMs: number, success: boolean) => recordToolExecution(activeRequest.current, durationMs, success),
      onIndexStart: () => {
        const measurement = activeRequest.current;
        const startedAt = performance.now();
        return () => recordIndexInitialization(measurement, performance.now() - startedAt);
      },
      onUsage: recordUsage,
      argumentNormalizerEnabled: () => aiModeRef.current === 'automatic',
      normalizeArguments: (prompt: string) => normalizeWithOpenRouter({
        prompt,
        onCall: onExternalCall,
      }),
      rerankTools,
      onRerankDecision: (decision: RerankDecision) => log(`Cross-encoder decision: top ${decision.topScore}, second ${decision.secondScore ?? 'none'}, margin ${decision.margin ?? 'n/a'}; score >= ${decision.minimumScore}: ${decision.scorePassed ? 'pass' : 'fail'}; margin >= ${decision.minimumMargin}: ${decision.margin === null ? 'not applicable' : decision.marginPassed ? 'pass' : 'fail'}; ${decision.decision}`),
      initialState: Array.isArray(initialState?.segments) ? initialState : undefined,
    });
    if (initialState?.status === 'awaiting_confirmation' && initialState.pendingConfirmation?.call) updatePendingConfirmation({ call: initialState.pendingConfirmation.call, fromWorkflow: true });
    if (initialState?.status === 'awaiting_confirmation' && initialState.executionState?.pendingConfirmation) {
      updatePendingConfirmation({ plan: initialState.executionState.plan, executionState: initialState.executionState, externalPlan: true });
    }
    if (initialState && ['awaiting_tool_choice', 'awaiting_argument', 'awaiting_entity_choice'].includes(initialState.status)) setPendingClarification(true);
    log(`Loaded ${registryData.tools.length} trusted provider tools from browser storage (${database.storage.backend})`);
    return environment.current;
  }

  function stopStage(stage: Stage) {
    const instance = workers.get(stage);
    if (!instance && !(stage === 'transcribe' && transcriptionAbort.current)) return;
    if (stage === 'transcribe') transcriptionAbort.current?.abort();
    if (instance) { instance.terminate(); workers.delete(stage); }
    readyModels.current.delete(stage);
    pending.current.forEach((task, id) => {
      if (task.stage === stage) {
        if (task.inferenceStartedAt !== undefined) recordLocalInference(task.measurement, task.inferenceModel, performance.now() - task.inferenceStartedAt);
        task.resolve({ id, stage, status: 'error', error: 'Stopped by user.' });
        pending.current.delete(id);
      }
    });
    setStatus(old => ({ ...old, [stage]: 'Stopped by user' }));
    log(`${stage} stopped`);
  }

  function freezeBuffer() {
    try { const snapshot = audio.snapshot(); setFrozenAudio(snapshot.audio.slice()); log(`Frozen ${snapshot.audio.length} samples at ${snapshot.sampleRate} Hz; transcription is not started automatically`); }
    catch (error) { log(error instanceof Error ? error.message : String(error)); }
  }

  async function showDocument(document: any, lightweightLoading = false, watchText?: string) {
    const validation = validateDisplayDocument(document, { registry: environment.current?.registry });
    if (!validation.valid) throw new TypeError(`Invalid display document: ${validation.errors.join('; ')}`);
    displayDocumentRef.current = document;
    setDisplayDocument(document);
    if (document.state !== 'loading') {
      setChatMessages(old => [...old, { id: crypto.randomUUID(), role: 'assistant', document }]);
    }
    if (watch.connected) {
      watchConfirmationRef.current = document.state === 'confirmation_required';
      if (lightweightLoading && document.state === 'loading') await watch.sendThinking();
      else if (watchText !== undefined) await watch.sendDisplayText(watchText);
      else await watch.sendDisplayDocument(document);
    }
  }

  async function processDots3Request(request: string, runtime: any, context: any, resumedExecutionState?: any, directAnswer = false) {
    let response;
    if (resumedExecutionState) {
      response = { kind: 'tool', plan: resumedExecutionState.plan };
      log('Resuming the saved execution plan');
    } else {
      const previous = await getConversationState();
      if (directAnswer) {
        log('OpenRouter direct answer started without a tool plan');
        response = await answerWithOpenRouter({ request, onCall: onExternalCall }).then(text => ({
          kind: 'direct_answer',
          text,
          state: {
            conversationId: previous?.status === 'completed' || previous?.status === 'cancelled'
              ? `conversation_${crypto.randomUUID()}`
              : previous?.conversationId ?? `conversation_${crypto.randomUUID()}`,
            status: 'completed',
            originalRequest: request,
            pendingQuestion: null,
            pendingReasoning: false,
            reasoningHistory: previous?.reasoningHistory ?? [],
          },
        }));
      } else {
        log('OpenRouter planning started with the currently registered tool catalog; browser records remain local');
        response = await planWithOpenRouter({
          request,
          context,
          runtime,
          priorState: previous,
          onCall: onExternalCall,
        });
      }
    }
    if (response.kind === 'clarification') {
      log('External planner requested clarification');
      await addClarification();
      updatePendingConfirmation(undefined);
      await saveConversationState(response.state);
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
    if (response.kind === 'direct_answer') {
      log('OpenRouter answered without using a tool');
      updatePendingConfirmation(undefined);
      setPendingClarification(false);
      await saveConversationState(response.state);
      runtime.intelligence.cancelPendingOperation();
      const answerDocument = parseDisplayDocument(response.text, { registry: runtime.registry });
      if (answerDocument) {
        await showDocument(answerDocument);
        return;
      }
      await showDocument(createDisplayDocument({
        id: 'cue-dots3-direct-answer',
        title: 'OpenRouter response',
        source: { app: 'openrouter', name: 'OpenRouter' },
        state: 'ready',
        message: response.text,
        elements: [{ type: 'text', text: response.text, role: 'body' }],
      }), false, response.text);
      return;
    }
    if (response.kind !== 'tool' || !response.plan) throw new TypeError('OpenRouter returned an unsupported reasoning outcome.');
    markMultiStep(activeRequest.current, response.plan.operations.length);
    for (const operation of response.plan.operations) {
      log(`Validated plan proposal: ${operation.toolId}; dependencies=${operation.dependsOn.length}; bindings=${operation.inputBindings.length}; fan-out=${Boolean(operation.forEach)}`);
    }

    const reasoningHistory = response.reasoningHistory ?? resumedExecutionState?.reasoningHistory ?? [];
    const fanOutProgress = new Map<string, string>();
    const saveExecutionState = async (executionState: any) => {
      executionState.reasoningHistory = reasoningHistory;
      for (const [templateId, iteration] of Object.entries(executionState.iterations ?? {}) as Array<[string, any]>) {
        const completed = iteration.children.filter((id: string) => executionState.plan.operations.find((operation: any) => operation.id === id)?.status === 'succeeded').length;
        const progress = `${completed}/${iteration.children.length}`;
        if (fanOutProgress.get(templateId) !== progress) {
          log(`Fan-out ${templateId}: ${progress} item operations completed`);
          fanOutProgress.set(templateId, progress);
        }
      }
      const state = executionState.plan.status === 'waiting_for_confirmation' ? 'awaiting_confirmation'
        : executionState.plan.status === 'completed' ? 'completed'
          : executionState.plan.status === 'failed' ? 'failed'
            : executionState.plan.status === 'waiting_for_input' ? 'awaiting_argument' : 'executing';
      await saveConversationState({
        conversationId: executionState.plan.conversationId,
        status: state,
        originalRequest: executionState.plan.originalRequest,
        reasoningHistory: executionState.reasoningHistory,
        pendingReasoning: state === 'awaiting_argument',
        pendingQuestion: executionState.pendingConfirmation
          ? `Confirm ${executionState.pendingConfirmation.toolId}?`
          : executionState.pendingQuestion,
        executionState,
      });
    };
    const outcome = await runtime.dispatcher.dispatchPlan(response.plan, { executionState: resumedExecutionState, onStateChange: saveExecutionState });
    outcome.executionState.reasoningHistory = reasoningHistory;
    if (outcome.state === 'operation_limit') {
      await saveConversationState({
        conversationId: outcome.plan.conversationId,
        status: 'awaiting_argument',
        originalRequest: outcome.plan.originalRequest,
        reasoningHistory: outcome.executionState.reasoningHistory,
        pendingReasoning: true,
        pendingQuestion: outcome.question,
        executionState: outcome.executionState,
      });
      await addClarification();
      setPendingClarification(true);
      updatePendingConfirmation(undefined);
      await showDocument(createDisplayDocument({
        id: 'cue-plan-operation-limit',
        title: 'Narrow the request',
        source: { app: 'cue', name: 'Cue' },
        state: 'clarification_required',
        message: outcome.question,
        elements: [{ type: 'text', text: outcome.question, role: 'body' }],
      }));
      return;
    }
    if (outcome.state === 'confirmation_required') {
      log(`Confirmation required for ${outcome.pendingConfirmation.toolId}`);
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
    await saveConversationState({
      conversationId: outcome.plan.conversationId,
      status: outcome.plan.status,
      originalRequest: outcome.plan.originalRequest,
      reasoningHistory: outcome.executionState.reasoningHistory,
      executionState: outcome.executionState,
    });
    if (outcome.document) await showDocument(outcome.document);
    else await showDocument(createDisplayDocument({
      id: 'cue-dots3-completed',
      title: 'Plan completed',
      source: { app: 'cue', name: 'Cue' },
      state: 'success',
      message: 'All required operations completed or were safely skipped.',
    }));
    log('OpenRouter plan completed under Cue validation and execution control');
  }

  async function processTranscript(text: string, continuePendingLocally = false, existingMeasurement?: RequestMeasurement, displayText?: string) {
    if (checkingGpuRef.current) throw new Error('GPU assessment is still running. Please wait.');
    let clean = text.trim();
    if (!clean) throw new Error('Enter transcript text first.');
    appendUserMessage(displayText ?? clean);
    const restart = clarificationRestart(clean);
    if (restart !== undefined) {
      try {
        const state = await getConversationState();
        if (state && ['awaiting_tool_choice', 'awaiting_argument', 'awaiting_entity_choice'].includes(state.status)) {
          const completedActions = clarificationHasCompletedSideEffects(state);
          await cancelPendingOperation(existingMeasurement);
          if (!restart || completedActions) {
            await showRestartedDocument(completedActions);
            return;
          }
          clean = restart;
        }
      } catch (error) {
        const message = `Could not restart pending request: ${error instanceof Error ? error.message : String(error)}`;
        log(message);
        await showDocument(createDisplayDocument({
          id: 'cue-restart-error', title: 'Restart failed', source: { app: 'cue', name: 'Cue' }, state: 'error', message,
        }));
        throw error;
      }
    }
    await recordUsage('requests');
    if (aiModeRef.current === 'dots3_always') await recordUsage('dots3Requests');
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
      const message = `This OpenRouter plan is awaiting confirmation with exact arguments${pending ? `: ${JSON.stringify(pending.arguments)}` : ''}. Confirm it as shown, or cancel it and submit a new request to make changes.`;
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
    const measurement = existingMeasurement ?? activeRequest.current ?? beginRequestMeasurement(aiModeRef.current);
    if (measurement.requestText === null) measurement.requestText = clean;
    activeRequest.current = measurement;
    let requestFailed = false;
    setBusy(true);
    try {
      await showDocument(createDisplayDocument({ id: 'cue-loading', title: 'Working', source: { app: 'cue', name: 'Cue' }, state: 'loading', message: 'Discovering provider tools and preparing a local response.', elements: [{ type: 'text', text: clean, role: 'body' }] }), true);
      const savedState = await getConversationState();
      const continuingLocal = isLocalWorkflowContinuation(savedState, continuePendingLocally);
      const coldAutomatic = shouldUseCloudWhileLoading(aiModeRef.current, readyModels.current.has('embed'), continuingLocal);
      if (coldAutomatic) warmModel('embed', { text: 'Prepare the local embedding model.' });
      const runtime = await getEnvironment(continuePendingLocally, coldAutomatic);
      const requestNow = clockForRuntime(runtime);
      const context = { now: requestNow, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: navigator.language, weekStartsOn: 1 };
      if (aiModeRef.current === 'web_ai' && savedState?.pendingReasoning) {
        const message = 'This request is awaiting hosted reasoning. Switch to Automatic or Always OpenRouter to continue, or cancel the pending request.';
        setPendingClarification(true);
        await showDocument(createDisplayDocument({
          id: 'cue-hosted-workflow-paused',
          title: 'Hosted workflow paused',
          source: { app: 'cue', name: 'Cue' },
          state: 'clarification_required',
          message,
          elements: [{ type: 'text', text: message, role: 'body' }],
        }));
        return;
      }
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
        if (savedState?.status === 'executing' && savedState.executionState) {
          await processDots3Request(clean, runtime, context, savedState.executionState);
          return;
        }
        if (/^(?:cancel|stop|never mind|nevermind|no|don't|do not)$/i.test(clean)) {
          setTranscriptInput('');
          await cancelPendingOperation();
          return;
        }
        setTranscriptInput('');
        const pending = savedState.executionState.pendingConfirmation;
        const message = `This OpenRouter plan is awaiting confirmation with exact arguments: ${JSON.stringify(pending.arguments)}. Confirm it as shown, or cancel it and submit a new request to make changes.`;
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
      if (!continuePendingLocally && aiModeRef.current !== 'web_ai'
        && (aiModeRef.current === 'dots3_always' || savedState?.pendingReasoning
          || (savedState?.executionState && ['awaiting_confirmation', 'executing'].includes(savedState.status)))) {
        await processDots3Request(clean, runtime, context);
        return;
      }
      if (coldAutomatic) {
        log('Automatic mode is using OpenRouter while the local embedding model loads');
        await processDots3Request(clean, runtime, context);
        return;
      }
      const escalationReason = aiModeRef.current === 'automatic' ? runtime.intelligence.requiresExternalPlanning(clean) : undefined;
      if (!continuePendingLocally && escalationReason) {
        log(`Automatic mode escalated: ${escalationReason}`);
        await processDots3Request(clean, runtime, context);
        return;
      }
      log('Local-first request routing accepted');
      await recordUsage('localCalls');
      recordLocalProcessing(activeRequest.current);
      localContinuation.current = continuingLocal;
      let outcome;
      try {
        outcome = await runtime.intelligence.handle(clean, { context: { ...context, now: requestNow } });
      } finally {
        localContinuation.current = false;
      }
      markMultiStep(activeRequest.current, outcome.operations?.length ?? outcome.plan?.operations?.length ?? 0);
      if (outcome.state) await saveConversationState(outcome.state);
      if (outcome.kind === 'clarification' || ['awaiting_tool_choice', 'awaiting_argument', 'awaiting_entity_choice'].includes(outcome.state?.status)) {
        await addClarification();
      }
      const rerankDiagnostics = outcome.diagnostics?.rerank ?? outcome.retrieval?.rerankDiagnostics;
      if (rerankDiagnostics?.candidates) {
        log(`Cross-encoder ranking: ${rerankDiagnostics.candidates.map((item: any) => `${item.toolId} ${item.score.toFixed(3)}`).join(', ')}`);
      }
      if (!continuePendingLocally && aiModeRef.current === 'automatic'
        && (outcome.state?.status === 'awaiting_tool_choice' || outcome.kind === 'no_tool')) {
        log(rerankDiagnostics?.error
          ? `Cross-encoder unavailable: ${rerankDiagnostics.error}; trying the configured OpenRouter fallback`
          : rerankDiagnostics?.candidates
            ? 'Cross-encoder scores or margin below routing thresholds; trying the configured OpenRouter fallback'
            : outcome.kind === 'no_tool'
              ? 'Local retrieval found no matching tool; trying the configured OpenRouter fallback'
              : 'Tool choice remains uncertain; cross-encoder result unavailable for this outcome; trying the configured OpenRouter fallback');
        await processDots3Request(clean, runtime, context, undefined, outcome.kind === 'no_tool');
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
      requestFailed = true;
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
    finally {
      if (!existingMeasurement) setBusy(false);
      const state = displayDocumentRef.current?.state;
      const completionStatus: CompletionStatus = requestFailed || state === 'error'
        ? 'failed'
        : state === 'clarification_required' ? 'clarification'
          : state === 'confirmation_required' ? 'awaiting_confirmation'
            : 'completed';
      if (!requestFailed && ['awaiting_confirmation', 'clarification'].includes(completionStatus)) await retainRequestMeasurement(measurement);
      else await persistRequestMeasurement(measurement, completionStatus);
    }
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
    if (!confirmedOnWatch) appendUserMessage('Confirm');
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
        const outcome = await runtime.intelligence.handle('yes', { confirmed: true, context: { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: navigator.language, weekStartsOn: 1 } });
        if (outcome.state) await saveConversationState(outcome.state);
        if (outcome.kind === 'confirmation_required') {
          updatePendingConfirmation({ call: outcome.pendingCall, fromWorkflow: true });
          watchConfirmationRef.current = true;
          if (activeRequest.current) await retainRequestMeasurement(activeRequest.current);
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
          onStateChange: async (state: PlanExecutionState) => saveConversationState({
            conversationId: state.plan.conversationId,
            status: state.plan.status === 'waiting_for_confirmation' ? 'awaiting_confirmation'
              : state.plan.status === 'completed' ? 'completed'
                : state.plan.status === 'failed' ? 'failed' : 'executing',
            originalRequest: state.plan.originalRequest,
            reasoningHistory: state.reasoningHistory,
            pendingQuestion: state.pendingConfirmation ? `Confirm ${state.pendingConfirmation.toolId}?` : undefined,
            executionState: state,
          }),
        });
        if (outcome.state === 'confirmation_required') {
          updatePendingConfirmation({ plan: outcome.plan, executionState: outcome.executionState, externalPlan: true });
          watchConfirmationRef.current = true;
          if (activeRequest.current) await retainRequestMeasurement(activeRequest.current);
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
      if (!pendingAction.fromWorkflow && pendingAction.call) await saveConversationState(null);
      await showDocument(document);
      if (activeRequest.current) await persistRequestMeasurement(activeRequest.current, 'completed');
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
      if (activeRequest.current) await persistRequestMeasurement(activeRequest.current, 'failed');
    }
    finally { setBusy(false); }
  }

  async function cancelPendingOperation(preserveMeasurement?: RequestMeasurement) {
    const savedState = await getConversationState();
    const pendingExecution = pendingConfirmationRef.current?.executionState ?? savedState?.executionState;
    if (pendingExecution) {
      const cancelled = structuredClone(pendingExecution);
      cancelled.plan.status = 'cancelled';
      if (cancelled.pendingConfirmation) {
        const operation = cancelled.plan.operations.find((item: any) => item.id === cancelled.pendingConfirmation.operationId);
        if (operation) operation.status = 'skipped';
      }
      cancelled.pendingConfirmation = undefined;
      await saveConversationState({
        conversationId: cancelled.plan.conversationId,
        status: 'cancelled',
        originalRequest: cancelled.plan.originalRequest,
        executionState: cancelled,
      });
    } else if (savedState?.pendingReasoning) {
      await saveConversationState({ ...savedState, status: 'cancelled', pendingReasoning: false });
    } else {
      environment.current?.intelligence.cancelPendingOperation();
      if (environment.current) await saveConversationState(environment.current.intelligence.getState());
      else if (savedState) {
        const cancelled = structuredClone(savedState);
        cancelled.status = 'cancelled';
        cancelled.pendingArguments = [];
        cancelled.pendingConfirmation = null;
        if (cancelled.executionPlan) cancelled.executionPlan.status = 'cancelled';
        await saveConversationState(cancelled);
      }
    }
    environment.current?.intelligence.cancelPendingOperation();
    updatePendingConfirmation(undefined);
    watchConfirmationRef.current = false;
    setPendingClarification(false);
    if (activeRequest.current && activeRequest.current !== preserveMeasurement) await persistRequestMeasurement(activeRequest.current, 'cancelled');
    log('Pending operation cancelled');
  }

  async function showRestartedDocument(completedActions: boolean) {
    const message = completedActions
      ? 'The pending request was cancelled. Earlier completed actions were not undone. State your new request separately.'
      : 'The pending request was cancelled. Say or enter a new request.';
    await showDocument(createDisplayDocument({
      id: 'cue-restarted',
      title: 'Ready for a new request',
      source: { app: 'cue', name: 'Cue' },
      state: 'ready',
      message,
      elements: [{ type: 'text', text: message, role: 'body' }],
    }));
  }

  async function restartClarification() {
    const state = await getConversationState();
    if (!state || !['awaiting_tool_choice', 'awaiting_argument', 'awaiting_entity_choice'].includes(state.status)) {
      throw new Error('There is no pending clarification to restart.');
    }
    appendUserMessage('Start over');
    await cancelPendingOperation();
    setTranscriptInput('');
    await showRestartedDocument(clarificationHasCompletedSideEffects(state));
  }

  async function resetDemoData() {
    if (!window.confirm('Reset this demo session to the committed synthetic baseline?')) return;
    setBusy(true);
    try {
      if (activeRequest.current) await persistRequestMeasurement(activeRequest.current, 'cancelled');
      await (await openBrowserDatabase()).resetDemoData();
      environment.current = undefined;
      displayDocumentRef.current = undefined;
      setDisplayDocument(undefined);
      setChatMessages([]);
      setTranscriptInput('');
      setScenario('');
      updatePendingConfirmation(undefined);
      watchConfirmationRef.current = false;
      setPendingClarification(false);
      log('Demo session reset to the committed synthetic baseline');
    } catch (error) { log(`Demo reset failed: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setBusy(false); }
  }

  async function exportLocalBackup() {
    try {
      const backup = await (await openBrowserDatabase()).exportBackup();
      const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `cue-browser-backup-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      log('Local browser backup exported');
    } catch (error) {
      log(`Local backup export failed: ${error instanceof Error ? error.message : String(error)}`);
    }
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
          await processTranscript(action.optionId, true, undefined, typeof action.label === 'string' ? action.label : action.optionId);
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
        const call = {
          toolId: result.toolId,
          arguments: result.arguments,
          operationId: `direct_${crypto.randomUUID()}`,
        };
        const pending = { call, fromWorkflow: false };
        await saveConversationState({
          conversationId: `interaction_${crypto.randomUUID()}`,
          status: 'awaiting_confirmation',
          pendingConfirmation: { call },
        });
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
    setBusy(true);
    try {
      await processTranscript(transcriptInput);
      setTranscriptInput('');
      setScenario('');
    }
    catch { /* Error is already reported in the status log. */ }
    finally { setBusy(false); }
  }

  async function runPipeline(snapshot = audio.snapshot()) {
    if (checkingGpuRef.current) { log('GPU assessment is still running. Please wait.'); return; }
    if (running.current) return;
    running.current = true;
    const measurement = beginRequestMeasurement(aiModeRef.current);
    activeRequest.current = measurement;
    const controller = new AbortController();
    transcriptionAbort.current = controller;
    setBusy(true);
    try {
      log(`Frozen ${snapshot.audio.length} samples at ${snapshot.sampleRate} Hz`);
      const runCloud = async (): Promise<WorkerReply> => {
        log('Sending audio to Cloudflare for transcription.');
        setStatus(old => ({ ...old, transcribe: 'Transcribing in cloud (Cloudflare)…' }));
        try {
          const result = await transcribeInCloud(snapshot.audio, snapshot.sampleRate, controller.signal);
          return { id: 0, stage: 'transcribe', status: 'complete', model: `Cloudflare ${CLOUD_MODEL}`, result };
        } catch (cloudError) {
          const message = cloudError instanceof Error ? cloudError.message : String(cloudError);
          setStatus(old => ({ ...old, transcribe: `Error — ${message}` }));
          throw cloudError;
        }
      };
      let asr: WorkerReply;
      const selectedModel = asrModelRef.current;
      if (selectedModel === 'cloud') {
        asr = await runCloud();
      } else {
        try {
          asr = await runModel('transcribe', { ...snapshot, audio: snapshot.audio.slice(), asrModel: selectedModel });
          if (asr.status === 'error') throw new Error(asr.error);
        } catch (error) {
          if (controller.signal.aborted) throw new Error('Stopped by user.');
          log(`Local transcription unavailable: ${error instanceof Error ? error.message : String(error)}.`);
          asr = await runCloud();
        }
      }
      const text = String(asr.result ?? '').trim();
      setStatus(old => ({ ...old, transcribe: `Complete — ${asr.model}` }));
      if (!text) throw new Error('No speech was detected.');
      await processTranscript(text, false, measurement);
      setTranscriptInput('');
      setScenario('');
      if (!measurement.completed) {
        const state = displayDocumentRef.current?.state;
        const completionStatus: CompletionStatus = state === 'error' ? 'failed'
          : state === 'clarification_required' ? 'clarification'
            : state === 'confirmation_required' ? 'awaiting_confirmation' : 'completed';
        if (completionStatus === 'awaiting_confirmation' || completionStatus === 'clarification') await retainRequestMeasurement(measurement);
        else await persistRequestMeasurement(measurement, completionStatus);
      }
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
      if (!measurement.completed) await persistRequestMeasurement(measurement, 'failed');
    } finally { transcriptionAbort.current = undefined; running.current = false; setBusy(false); }
  }

  async function connectWatch() {
    try { const name = await watch.connect(); setWatchName(name); log(`Connected: ${name}`); }
    catch (error) { log(error instanceof Error ? error.message : String(error)); }
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

  function transcribeBuffer() {
    try {
      const snapshot = audio.snapshot();
      setFrozenAudio(snapshot.audio.slice());
      void runPipeline(snapshot);
    } catch (error) { log(error instanceof Error ? error.message : String(error)); }
  }

  async function startHoldCapture() {
    if (holdingRef.current || !recording || buffer < 0.2 || busy) return;
    try {
      audio.beginCapture(recordingLimitSeconds);
      holdingRef.current = true; setHolding(true);
      holdTimer.current = window.setTimeout(() => { void finishHoldCapture(); log('Maximum 5-minute extension reached'); }, recordingLimitSeconds * 1000);
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

  return <main className="app-shell app-shell-centered">
    <header className="app-header">
      <a className="app-brand" href="/landing" onClick={event => { event.preventDefault(); navigateTo('/landing'); }}>
        <span>Cue</span>
      </a>
      <nav className="app-header-actions" aria-label="App options">
        <button className="app-icon-button" aria-label="Reset demo session" title="Reset demo session" disabled={busy} onClick={() => void resetDemoData()}>
          <RotateCcw size={22} strokeWidth={1.8} aria-hidden="true" />
        </button>
        <button className="app-icon-button" aria-label="Microphone controls" title="Microphone controls" onClick={() => {
          if (connectionDialogRef.current?.open) connectionDialogRef.current.close();
          if (settingsDialogRef.current?.open) settingsDialogRef.current.close();
          if (microphoneDialogRef.current && !microphoneDialogRef.current.open) microphoneDialogRef.current.showModal();
        }}>
          <Mic size={22} strokeWidth={1.8} aria-hidden="true" />
        </button>
        <button className="app-icon-button" aria-label="Watch connection options" title="Watch connection options" onClick={() => {
          if (microphoneDialogRef.current?.open) microphoneDialogRef.current.close();
          if (settingsDialogRef.current?.open) settingsDialogRef.current.close();
          if (connectionDialogRef.current && !connectionDialogRef.current.open) connectionDialogRef.current.showModal();
        }}>
          <Bluetooth size={22} strokeWidth={1.8} aria-hidden="true" />
        </button>
        <button className="app-icon-button" aria-label="AI and transcription settings" title="AI and transcription settings" onClick={() => {
          if (microphoneDialogRef.current?.open) microphoneDialogRef.current.close();
          if (connectionDialogRef.current?.open) connectionDialogRef.current.close();
          if (settingsDialogRef.current && !settingsDialogRef.current.open) settingsDialogRef.current.showModal();
        }}>
          <Settings size={22} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </nav>
    </header>

    <div className="app-content">
      <section className="app-panel" aria-label="Cue chat">
        <div className="app-chat-log" role="log" aria-label="Current session" aria-live="polite" ref={chatLogRef} onScroll={event => {
          const element = event.currentTarget;
          chatStickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        }}>
          {chatMessages.map(entry => entry.role === 'user'
            ? <div className="app-chat-message app-chat-user" key={entry.id}><strong>You</strong><p>{entry.text}</p></div>
            : <div className="app-chat-message app-chat-assistant" key={entry.id}>
              <strong>Cue</strong>
              <DisplayDocumentView document={entry.document} onAction={!busy && entry.document === displayDocument ? action => void dispatchDocumentAction(action) : undefined} />
              {entry.document === displayDocument && pendingConfirmation && <button disabled={busy} onClick={() => void confirmPendingAction()}>Confirm local mock action</button>}
              {entry.document === displayDocument && pendingClarification && <button disabled={busy} onClick={() => void restartClarification().catch(error => log(`Could not restart pending request: ${error instanceof Error ? error.message : String(error)}`))}>Start over</button>}
            </div>)}
          {displayDocument?.state === 'loading' && <div className="app-chat-message app-chat-assistant"><strong>Cue</strong><p>Working…</p></div>}
        </div>

        <label className="app-message-label">{pendingClarification ? 'Your reply' : 'Your message'}
          <textarea className="app-message-input" value={transcriptInput} disabled={busy} onChange={event => { setTranscriptInput(event.target.value); setScenario(''); }} placeholder={pendingClarification ? 'Enter the missing details or a correction' : 'Ask Cue to find something, make a plan, or answer a question…'} />
        </label>
        {pendingClarification && <p className="app-clarification" role="status">Reply to continue, or say “go back” or “no, I meant” followed by a new request to start over.</p>}

        <div className="app-compose-actions">
          <label className="app-scenario-select">Try an example
            <select value={scenario} disabled={busy} onChange={event => { setScenario(event.target.value); setTranscriptInput(event.target.value); }}>
              <option value="">Choose an example</option>
              {DEMO_SCENARIOS.map(request => <option key={request} value={request}>{request}</option>)}
            </select>
          </label>
          <button className="app-primary-action" disabled={busy || checkingGpu || (!transcriptInput.trim() && (!recording || buffer < 0.2))} onClick={() => transcriptInput.trim() ? void submitTranscript() : transcribeBuffer()}>
            {busy ? 'Processing…' : transcriptInput.trim() ? pendingClarification ? 'Send reply' : 'Process message' : 'Transcribe'}
          </button>
        </div>

        {checkingGpu && <p role="status">Checking GPU performance to choose defaults…</p>}

        {(busy || Object.values(status).some(value => value !== 'Not started')) && <div className="app-stage-status" aria-live="polite">
          {(['transcribe', 'embed', 'rerank'] as Stage[]).map(stage => <p key={stage}>
            <span>{stage === 'rerank' ? 'Cross-encoder' : stage}</span>
            <span>{status[stage]}</span>
            {busy && <button onClick={() => stopStage(stage)}>Stop</button>}
          </p>)}
        </div>}

        <p className="app-embedding-status">Embedding: {embedding ? `${embedding.dimensions} dimensions (${embedding.model ?? 'MiniLM'})` : 'Prepared on first request in the browser'}</p>
      </section>

      <details className="app-status-log">
        <summary>Status log</summary>
        <pre>{logs.join('\n')}</pre>
      </details>
    </div>

    <dialog ref={microphoneDialogRef} className="app-modal" aria-labelledby="microphone-title" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.currentTarget.close(); }
    }} onClick={event => {
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.target === event.currentTarget && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) event.currentTarget.close();
    }}>
      <div className="app-modal-heading">
        <div><p className="app-kicker">AUDIO INPUT</p><h2 id="microphone-title">Microphone controls</h2></div>
        <button autoFocus onClick={() => microphoneDialogRef.current?.close()}>Close</button>
      </div>
      <div className={`app-microphone-status${recording ? ' is-recording' : ''}`} role="status">
        <span className="app-recording-dot" aria-hidden="true" />
        <span>{recording ? 'Recording' : 'Microphone off'}</span>
      </div>
      <p className="app-buffer-status">Rolling buffer: {buffer.toFixed(1)} / 10.0 seconds · {audio.sampleRate || '—'} Hz</p>
      {checkingGpu && <p role="status">Checking GPU performance to choose defaults…</p>}
      <p className="app-modal-note">Local Whisper sends the recording to Cloudflare if it cannot run. Cloud only always sends the recording to Cloudflare.</p>
      {status.transcribe !== 'Not started' && <p className="app-modal-status" role="status">{status.transcribe}</p>}
      <div className="app-hold-capture">
        <button onClick={() => void toggleMicrophone()}>{recording ? 'Stop microphone' : 'Start microphone'}</button>
        <div className="app-capture-instructions">
          <p><span className="app-click-label">Click</span><span className="app-tap-label">Tap</span> to transcribe the last 10 seconds, or hold to add more (up to 5 additional minutes).</p>
        </div>
        <button className="app-secondary-action" disabled={busy || checkingGpu || !recording || buffer < 0.2} onPointerDown={event => {
          if (!event.isPrimary || event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          void startHoldCapture();
        }} onPointerUp={() => void finishHoldCapture()} onPointerCancel={() => void finishHoldCapture()} onLostPointerCapture={() => void finishHoldCapture()} onClick={event => { if (event.detail === 0) transcribeBuffer(); }}>
          {holding ? 'Release to transcribe…' : 'Transcribe'}
        </button>
      </div>
      <div className="app-microphone-actions">
        <button disabled={!recording || buffer < 0.2} onClick={freezeBuffer}>Freeze last 10 seconds</button>
        <button disabled={!frozenAudio} onClick={() => void playFrozenRecording()}>{playbackActive ? 'Stop playback' : 'Play frozen recording'}</button>
      </div>
    </dialog>

    <dialog ref={connectionDialogRef} className="app-modal" aria-labelledby="connection-modal-title" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.currentTarget.close(); }
    }} onClick={event => {
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.target === event.currentTarget && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) event.currentTarget.close();
    }}>
        <div className="app-modal-heading">
          <div><p className="app-kicker">OPTIONAL DEVICE</p><h2 id="connection-modal-title">Watch connection</h2></div>
          <button autoFocus onClick={() => connectionDialogRef.current?.close()}>Close</button>
        </div>
        <p className="app-modal-status" role="status">{watchName}</p>
        <div className="app-modal-actions">
          <button className="app-primary-action" onClick={() => watch.connected ? watch.disconnect() : void connectWatch()}>{watch.connected ? 'Disconnect watch' : 'Connect Bangle.js'}</button>
          <button disabled={!watch.connected || testSending} onClick={() => void sendWatchTest()}>{testSending ? 'Sending test…' : 'Send test to watch'}</button>
          <button disabled={installing} onClick={() => void installOnWatch()}>{installing ? 'Installing…' : 'Install Cue on watch'}</button>
        </div>
        {installStatus && <p role="status">{installStatus}</p>}
        <details className="app-download-options">
          <summary>Manual installation</summary>
          <p>Download the watch app and install it with the Espruino Web IDE.</p>
          <button onClick={() => downloadWatchFile('cue.app.js', watchAppSource)}>Download watch display app</button>
          <a href="https://www.espruino.com/ide/" target="_blank" rel="noreferrer">Open Espruino Web IDE</a>
        </details>
    </dialog>

    <dialog ref={settingsDialogRef} className="app-modal" aria-labelledby="settings-modal-title" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.currentTarget.close(); }
    }} onClick={event => {
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.target === event.currentTarget && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) event.currentTarget.close();
    }}>
        <div className="app-modal-heading">
          <div><p className="app-kicker">PREFERENCES</p><h2 id="settings-modal-title">AI settings</h2></div>
          <button autoFocus onClick={() => settingsDialogRef.current?.close()}>Close</button>
        </div>
        {checkingGpu && <p role="status">Checking GPU performance to choose defaults…</p>}
        <label>AI mode<select value={aiMode} disabled={busy} onChange={event => {
          const value = event.target.value;
          if (value === 'web_ai' || value === 'automatic' || value === 'dots3_always') setAiPreference(value);
        }}>
          <option value="web_ai">Web AI</option>
          <option value="automatic">Automatic</option>
          <option value="dots3_always">Always OpenRouter</option>
        </select></label>
        <p className="app-modal-note">Automatic keeps straightforward requests local when its models are ready, and uses OpenRouter while they load or for complex or uncertain requests. Always OpenRouter sends the request and registered tool catalog through the configured backend. Avoid sensitive text in external modes.</p>
        <label>Whisper model<select value={asrModel} disabled={busy} onChange={event => {
          const value = event.target.value;
          if (value === 'cloud' || value === 'tiny' || value === 'base' || value === 'small') { asrModelChosen.current = true; setAsrModel(value); asrModelRef.current = value; }
        }}>{Object.entries(ASR_MODELS).map(([size, model]) => <option key={size} value={size}>{model.label}</option>)}<option value="cloud">Cloud only — Cloudflare Whisper</option></select></label>
        <p className="app-modal-note">Tool availability and demo data are stored locally in this browser.</p>
        <div className="app-modal-actions app-utility-actions">
          <button disabled={busy} onClick={() => void exportLocalBackup()}>Export local backup</button>
        </div>
    </dialog>
  </main>;
}
