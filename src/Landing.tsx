import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import watchAppSource from '../watch/bangle-app.js?raw';
import { navigateTo } from './navigation';
import { watch } from './services/watch';
import { DEMO_SCENARIOS } from './demo/demoScenarios.js';
import type { UserDatabase } from './storage/userDatabase';
import { calculateStatistics, flushTelemetryQueue, type ModeStatistics, type RequestStatistic, type StatisticsSummary } from './statistics';

const WatchModel = lazy(() => import('./components/WatchModel'));

async function openBrowserDatabase() {
  const database = await import('./storage/userDatabase');
  return database.openBrowserDatabase();
}

function WatchModelFallback() {
  return <div className="watch-model watch-model-loading" aria-hidden="true" />;
}

function parseStatistics(value: unknown): StatisticsSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('The statistics response is invalid.');
  const source = value as Partial<StatisticsSummary>;
  if (!Number.isSafeInteger(source.sampleSize) || (source.sampleSize ?? -1) < 0
    || !Array.isArray(source.localModels)
    || source.localModels.some(model => typeof model !== 'string')
    || !Array.isArray(source.byMode) || !Array.isArray(source.byExternalModel) || !Array.isArray(source.bySelectedMode)) {
    throw new TypeError('The statistics response is invalid.');
  }
  for (const name of ['averageExternalApiCalls', 'averageResponseMs', 'averageLocalInferenceMs',
    'averageExternalAiMs', 'averageToolExecutionMs', 'completionRate', 'toolSuccessRate'] as const) {
    const item = source[name];
    if (item !== null && (typeof item !== 'number' || !Number.isFinite(item))) throw new TypeError(`The ${name} statistic is invalid.`);
  }
  return value as StatisticsSummary;
}

async function requestGlobalUsage(request: string) {
  const query = request ? `?${new URLSearchParams({ request })}` : '';
  const response = await fetch(`/.netlify/functions/global-stats${query}`, {
    method: 'GET',
    cache: 'no-store',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
  let value: unknown;
  try {
    value = JSON.parse(await response.text());
  } catch {
    throw new Error('The global statistics service returned an invalid response.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('The global statistics response is invalid.');
  }
  const result = value as { error?: string };
  if (!response.ok) throw new Error(result.error ?? `Global statistics request failed (${response.status}).`);
  return parseStatistics(result);
}

function formatAverage(value: number | null, digits = 1) {
  return value === null ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function formatPercent(value: number | null) {
  return value === null ? '—' : `${value.toFixed(1)}%`;
}

const modeLabels = { web_ai: 'Local only', automatic: 'Automatic', dots3_always: 'Always OpenRouter' } as const;
const comparisonMetrics: Array<{
  label: string;
  field: keyof ModeStatistics;
  unit: string;
  scale?: number;
  sample: (mode: ModeStatistics) => number;
}> = [
  { label: 'External AI calls per request', field: 'averageExternalApiCalls', unit: 'calls', sample: mode => mode.requests },
  { label: 'Response time', field: 'averageResponseMs', unit: 'ms', sample: mode => mode.requests },
  { label: 'Local inference time', field: 'averageLocalInferenceMs', unit: 'ms', sample: mode => mode.requests },
  { label: 'External AI latency per call', field: 'averageExternalCallLatencyMs', unit: 'ms', sample: mode => mode.externalCalls },
  { label: 'Completion rate', field: 'completionRate', unit: '%', scale: 100, sample: mode => mode.requests },
  { label: 'Tool success rate', field: 'toolSuccessRate', unit: '%', scale: 100, sample: mode => mode.toolCalls },
  { label: 'Input tokens per request', field: 'averageInputTokens', unit: 'tokens', sample: mode => mode.tokenSampleSize },
  { label: 'Output tokens per request', field: 'averageOutputTokens', unit: 'tokens', sample: mode => mode.tokenSampleSize },
];

function ModeComparisons({ modes, filtered }: { modes: ModeStatistics[]; filtered: boolean }) {
  return <>
    <h4>Measured comparisons by selected mode</h4>
    <p>{filtered ? 'These are unpaired runs of the selected request, not controlled experiments.' : 'These are unpaired requests, not controlled runs of the same request.'} Small samples may be unreliable. Token averages include requests with complete reported token counts, including zero for requests without external calls.</p>
    {comparisonMetrics.map(metric => {
      const values = modes.map(mode => {
        const value = mode[metric.field];
        return typeof value === 'number' ? value * (metric.scale ?? 1) : null;
      });
      const max = Math.max(0, ...values.filter((value): value is number => value !== null));
      return <div className="statistics-comparison" key={metric.field}>
        <h5>{metric.label}</h5>
        {modes.map((mode, index) => <div className="statistics-bar-row" key={mode.mode}>
          <span>{modeLabels[mode.mode]}</span>
          <div className="statistics-bar-track" aria-hidden="true"><div className="statistics-bar" style={{ width: `${max && values[index] !== null ? values[index]! / max * 100 : 0}%` }} /></div>
          <span>{values[index] === null ? '—' : `${formatAverage(values[index])} ${metric.unit}`} (n={metric.sample(mode)})</span>
        </div>)}
      </div>;
    })}
    <p>{modes.map(mode => `${modeLabels[mode.mode]}: ${mode.requests} requests (${mode.periodStart && mode.periodEnd ? `${new Date(mode.periodStart).toLocaleDateString()} – ${new Date(mode.periodEnd).toLocaleDateString()}` : 'no data'})`).join(' · ')}</p>
  </>;
}

function StatisticsSummaryView({ title, stats, local = false, filtered = false }: { title: string; stats: StatisticsSummary; local?: boolean; filtered?: boolean }) {
  const period = stats.periodStart && stats.periodEnd
    ? `${new Date(stats.periodStart).toLocaleDateString()} – ${new Date(stats.periodEnd).toLocaleDateString()}`
    : 'No completed requests yet';
  return <div className="statistics-summary">
    <h3>{title}</h3>
    <p>{stats.sampleSize.toLocaleString()} requests · {period}</p>
    <dl className="statistics-highlights">
      <div><dt>Average external API calls / request</dt><dd>{formatAverage(stats.averageExternalApiCalls)}</dd></div>
      <div><dt>Average response time</dt><dd>{formatAverage(stats.averageResponseMs)} ms</dd></div>
      <div><dt>Completion rate</dt><dd>{formatPercent(stats.completionRate === null ? null : stats.completionRate * 100)}</dd></div>
      <div><dt>Tool success rate</dt><dd>{formatPercent(stats.toolSuccessRate === null ? null : stats.toolSuccessRate * 100)}</dd></div>
    </dl>
    <ModeComparisons modes={stats.bySelectedMode} filtered={filtered} />
    <h4>Average timing by execution mode</h4>
    {stats.byMode.length
      ? <div className="statistics-table-wrap"><table className="statistics-table">
        <thead><tr><th>Mode</th><th>Requests</th><th>Response</th><th>Local inference</th><th>External AI</th><th>Tools</th><th>Completion</th><th>Tool success</th></tr></thead>
        <tbody>{stats.byMode.map(mode => <tr key={mode.mode}>
          <th scope="row">{mode.mode}</th><td>{mode.requests.toLocaleString()}</td>
          <td>{formatAverage(mode.averageResponseMs)} ms</td><td>{formatAverage(mode.averageLocalInferenceMs)} ms</td>
          <td>{formatAverage(mode.averageExternalAiMs)} ms</td><td>{formatAverage(mode.averageToolExecutionMs)} ms</td>
          <td>{formatPercent(mode.completionRate * 100)}</td><td>{formatPercent(mode.toolSuccessRate === null ? null : mode.toolSuccessRate * 100)}</td>
        </tr>)}</tbody>
      </table></div>
      : <p>No execution-mode samples yet.</p>}
    <h4>External models</h4>
    {stats.byExternalModel.length
      ? <ul className="statistics-models">{stats.byExternalModel.map(model => <li key={`${model.provider}:${model.model}`}>
        <strong>{model.provider} / {model.model}</strong>: {model.calls.toLocaleString()} calls across {model.requests.toLocaleString()} requests; {formatAverage(model.averageLatencyMs)} ms average latency; {model.tokenUsageCalls.toLocaleString()} calls with reported token usage.
      </li>)}</ul>
      : <p>No external model calls in this sample.</p>}
    {local && <p>Local models: {stats.localModels.length ? stats.localModels.join(', ') : 'None recorded.'}</p>}
    <details>
      <summary>Supplementary totals</summary>
      <p>{stats.sampleSize.toLocaleString()} requests · {stats.totalExternalApiCalls.toLocaleString()} external API calls · {stats.totalToolCalls.toLocaleString()} tool calls ({stats.totalToolFailures.toLocaleString()} failed) · {stats.totalClarifications.toLocaleString()} clarifications · {stats.multiStepRequests.toLocaleString()} multi-step requests · {formatAverage(stats.inputTokens, 0)} input and {formatAverage(stats.outputTokens, 0)} output tokens reported on {stats.tokenUsageCalls.toLocaleString()} calls.</p>
    </details>
  </div>;
}

export default function Landing() {
  const heroRef = useRef<HTMLElement>(null);
  const statisticsRef = useRef<HTMLElement>(null);
  const heroProgressRef = useRef(0);
  const [watchStatus, setWatchStatus] = useState(watch.status);
  const [connecting, setConnecting] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [installStatus, setInstallStatus] = useState('');
  const [database, setDatabase] = useState<UserDatabase>();
  const [localRecords, setLocalRecords] = useState<RequestStatistic[]>();
  const [selectedRequest, setSelectedRequest] = useState('');
  const [globalRefresh, setGlobalRefresh] = useState(0);
  const [sharingEnabled, setSharingEnabled] = useState(false);
  const [sharingStatus, setSharingStatus] = useState('');
  const [globalUsage, setGlobalUsage] = useState<{ request: string; stats: StatisticsSummary }>();
  const [globalBusy, setGlobalBusy] = useState(true);
  const [globalError, setGlobalError] = useState('');
  const localUsage = localRecords && calculateStatistics(localRecords, selectedRequest || undefined);

  const connected = watch.connected;
  const connectionStage = watchStatus.startsWith('Requesting')
    ? 'Requesting Bluetooth'
    : watchStatus.startsWith('Connecting')
      ? 'Connecting'
      : watchStatus.startsWith('Connection failed')
        ? 'Connection failed'
        : watchStatus === 'Watch disconnected'
          ? 'Disconnected'
          : connected ? 'Connected' : 'Ready to connect';
  const screenTitle = installing
    ? 'Installing Cue'
    : installed
      ? 'Cue installed'
      : connected
        ? 'Connected'
        : connectionStage === 'Ready to connect' ? 'Cue' : connectionStage;
  const screenBody = installing
    ? installStatus || 'Installing the Cue watch app.'
    : installed
      ? 'Continue to Cue'
      : connected
        ? 'Install the Cue watch app'
        : connectionStage === 'Ready to connect'
          ? 'Connect watch'
          : connectionStage === 'Requesting Bluetooth'
            ? 'Select your Bangle.js 2'
            : connectionStage === 'Connecting'
              ? 'Connecting to the watch'
          : connectionStage === 'Connection failed'
            ? watchStatus.replace(/^Connection failed:\s*/, '')
            : connectionStage === 'Disconnected'
              ? 'Reconnect to continue'
              : 'Please wait';
  const screenAction = installing
    ? undefined
    : installed
      ? 'Continue to Cue'
      : connected
        ? 'Install Cue'
        : connectionStage === 'Connection failed' || connectionStage === 'Disconnected'
          ? 'Retry'
          : connectionStage === 'Ready to connect'
            ? 'Tap to connect'
            : 'Please wait';

  useEffect(() => {
    const hero = heroRef.current;
    if (!hero) return;
    const update = () => {
      const bounds = hero.getBoundingClientRect();
      const progress = Math.min(1, Math.max(0, -bounds.top / bounds.height));
      heroProgressRef.current = progress;
      hero.style.setProperty('--hero-progress', String(progress));
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  useEffect(() => {
    const section = statisticsRef.current;
    if (!section) return;
    const update = () => {
      const bounds = section.getBoundingClientRect();
      section.classList.toggle('snap-section-entered', bounds.top <= 1 && bounds.bottom > 0);
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  useEffect(() => {
    let active = true;
    let telemetryDatabase: UserDatabase | undefined;
    const retryTelemetry = () => {
      if (telemetryDatabase) void flushTelemetryQueue(telemetryDatabase).catch(error => {
        if (active) setSharingStatus(`Telemetry retry failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    };
    window.addEventListener('online', retryTelemetry);
    const unsubscribe = watch.subscribeStatus(status => {
      if (active) setWatchStatus(status);
    });

    void openBrowserDatabase()
      .then(async openedDatabase => {
        const [records, sharing] = await Promise.all([
          openedDatabase.getRequestStatistics(),
          openedDatabase.getPreference<boolean>('sharePublicTelemetryWithRequestText'),
        ]);
        if (!active) return;
        telemetryDatabase = openedDatabase;
        setDatabase(openedDatabase);
        setLocalRecords(records);
        setSharingEnabled(sharing === true);
        retryTelemetry();
      })
      .catch(error => {
        if (active) setSharingStatus(`Local browser storage is unavailable: ${error instanceof Error ? error.message : String(error)}`);
      });

    return () => {
      active = false;
      window.removeEventListener('online', retryTelemetry);
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let active = true;
    setGlobalBusy(true);
    setGlobalError('');
    void requestGlobalUsage(selectedRequest)
      .then(stats => { if (active) setGlobalUsage({ request: selectedRequest, stats }); })
      .catch(error => { if (active) setGlobalError(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (active) setGlobalBusy(false); });
    return () => { active = false; };
  }, [selectedRequest, globalRefresh]);

  async function connectWatch() {
    setConnecting(true);
    try {
      await watch.connect();
    } catch (error) {
      setWatchStatus(`Connection failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setConnecting(false);
    }
  }

  async function installOnWatch() {
    if (!watch.connected || installing || installed) return;
    setInstalling(true);
    setInstallStatus('Preparing installation…');
    try {
      await watch.installWatchApp(watchAppSource, setInstallStatus);
      setInstalled(true);
      setInstallStatus('Cue installed and ready.');
    } catch (error) {
      setInstallStatus(`Installation failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setInstalling(false);
    }
  }

  function loadGlobalUsage() {
    setGlobalRefresh(count => count + 1);
  }

  async function toggleSharing(enabled: boolean) {
    if (!database) return;
    setSharingEnabled(enabled);
    setSharingStatus('');
    try {
      if (enabled && await database.getPreference<boolean>('sharePublicTelemetryWithRequestText') !== true) await database.clearPendingTelemetry();
      await database.setPreference('sharePublicTelemetryWithRequestText', enabled);
      if (enabled) {
        const result = await flushTelemetryQueue(database);
        setSharingStatus(result.failed ? 'Some opted-in uploads are queued for retry.' : 'Automatic sharing is enabled for future requests.');
      } else {
        await database.clearPendingTelemetry();
        setSharingStatus('Automatic sharing is off; queued uploads were removed. Previously shared aggregates cannot be withdrawn.');
      }
    } catch (error) {
      setSharingEnabled(!enabled);
      setSharingStatus(`Could not save the sharing preference: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function activateWatchScreen() {
    if (installing) return;
    if (installed) navigateTo('/app');
    else if (connected) void installOnWatch();
    else if (!connecting && watch.bluetoothAvailable) void connectWatch();
  }

  return <main className="landing">
    <div className="landing-stage">
      <section className="landing-hero" ref={heroRef} aria-labelledby="landing-title">
        <div className="hero-watch">
          <Suspense fallback={<WatchModelFallback />}>
            <WatchModel
              mode="hero"
              title="Cue"
              message="Connect watch"
              action="Tap to connect"
              onScreenAction={activateWatchScreen}
              scrollProgressRef={heroProgressRef}
            />
          </Suspense>
        </div>
        <div className="hero-copy">
          <h1 id="landing-title">Cue</h1>
          <p>Endless possibilities</p>
        </div>
      </section>

      <section className="landing-demo" aria-labelledby="demo-title">
        <div className="demo-copy">
          <h2 id="demo-title">Try the demo</h2>
          <p>Click connect on the watch to connect over BLE.</p>
          <p className="demo-watch-status" role="status">{watchStatus}</p>
          {connected
            ? <button className="primary-action" disabled={installing} onClick={() => installed ? navigateTo('/app') : void installOnWatch()}>
              {installing ? 'Installing Cue…' : installed ? 'Continue to Cue' : 'Install Cue on watch'}
            </button>
            : <button className="primary-action" disabled={connecting || !watch.bluetoothAvailable} onClick={() => void connectWatch()}>
              {connectionStage === 'Connection failed' || connectionStage === 'Disconnected' ? 'Retry connection' : connecting ? 'Connecting…' : 'Connect Bangle.js 2'}
            </button>}
          {!watch.bluetoothAvailable && <p className="demo-note">Web Bluetooth is unavailable in this browser. You can still use the demo without a watch.</p>}
          {connected && <p className="demo-note">Installing Cue writes only cue.app.js and cue.info, then restarts the watch. It does not erase other stored apps or user settings.</p>}
          {installStatus && <p className="demo-watch-status" role="status">{installStatus}</p>}

          <div className="no-watch">
            <h3>Got no Bangle?</h3>
            <p>Try the demo without connecting.</p>
            <button onClick={() => navigateTo('/app')}>Try the demo without a watch</button>
          </div>
        </div>
        <div className="demo-watch">
          <Suspense fallback={<WatchModelFallback />}>
            <WatchModel
              mode="demo"
              title={screenTitle}
              message={screenBody}
              action={screenAction}
              onScreenAction={activateWatchScreen}
              screenActionDisabled={installing || (!connected && !watch.bluetoothAvailable)}
            />
          </Suspense>
        </div>
      </section>
    </div>

    <section className="landing-statistics" ref={statisticsRef} aria-labelledby="statistics-title">
      <span className="section-snap-anchor" aria-hidden="true" />
      <div className="statistics-inner">
        <h2 id="statistics-title">Statistics</h2>
        <p>Request averages are shown with sample size and period. Public statistics show aggregates; opted-in request records are also stored on the server.</p>
        <label className="statistics-filter">Filter by demo request
          <select value={selectedRequest} onChange={event => setSelectedRequest(event.target.value)}>
            <option value="">All requests</option>
            {DEMO_SCENARIOS.map(request => <option key={request} value={request}>{request}</option>)}
          </select>
        </label>
        {selectedRequest && <p>Showing only records whose original request exactly matches the selected demo request. Older records without request text are excluded.</p>}
        {globalBusy
          ? <p role="status">Loading global statistics…</p>
          : globalError
            ? <div role="status"><p>Global statistics are unavailable: {globalError}</p><button onClick={() => void loadGlobalUsage()}>Retry</button></div>
            : globalUsage?.request === selectedRequest && <StatisticsSummaryView title="Community aggregates" stats={globalUsage.stats} filtered={Boolean(selectedRequest)} />}
        {localUsage && <StatisticsSummaryView title="Your browser (local only)" stats={localUsage} local filtered={Boolean(selectedRequest)} />}

        <div className="statistics-sharing">
          <label>
            <input type="checkbox" checked={sharingEnabled} disabled={!database} onChange={event => void toggleSharing(event.target.checked)} />
            Opt in to automatic public telemetry.
          </label>
          <p>Off by default. When enabled, Cue uploads the actual request text, including transcribed speech, together with execution mode, model names, timing, token and tool counts, completion status, and a random request ID. Request text may contain sensitive information; do not opt in if you do not want it stored. Requests over 100 KB are not shared.</p>
          <p>Records are stored in the database until manually deleted and can be accessed by database administrators; the public statistics endpoint shows aggregates only. Responses, tool arguments, provider records, account details and browser identifiers are not included. Failed uploads retry; turning sharing off removes queued uploads but does not delete records already sent. No extra AI calls are made for statistics.</p>
          {sharingStatus && <p role="status">{sharingStatus}</p>}
          <p>Global aggregates include opted-in records only. Use Refresh to fetch the latest public aggregate.</p>
          <button disabled={globalBusy} onClick={() => void loadGlobalUsage()}>Refresh public statistics</button>
        </div>
      </div>
    </section>
  </main>;
}
