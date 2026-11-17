import providerSeed from '../../data/seed/provider-manifests.json' with { type: 'json' };
import toolSeed from '../../data/seed/tool-manifests.json' with { type: 'json' };
import providerDataSeed from '../../data/seed/provider-data.json' with { type: 'json' };
import retrievalConfig from '../../data/seed/tool-retrieval-config.json' with { type: 'json' };
import embeddingSeed from '../../data/seed/tool-embeddings.json' with { type: 'json' };
import { validateArguments } from '../intelligence/toolRegistry.js';
import { validateFormats } from '../intelligence/argumentNormalization.js';
import { seedOffsetDays, shiftSeedDates, utcDateString } from '../demo/seedDates.js';
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_CACHE_VERSION,
  EMBEDDING_MODEL,
  EMBEDDING_PREPROCESSING,
  EMBEDDING_REVISION,
  EMBEDDING_TOKENIZER,
} from '../intelligence/embeddingModel.js';
import { openUserStorage, type StorageAdapter, type StorageValue } from './storage.ts';
import type { RequestStatistic } from '../statistics';

const APP_SCHEMA_VERSION = 2;
const DEMO_CLOCK_TIME = '08:00:00+02:00';

function currentDemoClock() {
  return `${utcDateString()}T${DEMO_CLOCK_TIME}`;
}

function presentRecord(stored: StoredRecord) {
  return stored.origin === 'demo-seed' ? shiftSeedDates(stored.value, packagedSeedOffsetDays) : stored.value;
}
const JSON_SCHEMA_REF = { $ref: 'https://cue.local/schemas/cue-display-v1.schema.json' };
const RECORD_STORE = 'records';

type ProviderSeed = {
  id: string;
  name: string;
  description: string;
  version: string;
  status: string;
  adapter: string;
  transport: string;
  demo: boolean;
  contextSearch?: { recordTypes: string[]; fields: string[] };
};

type ToolSeed = {
  id: string;
  providerId: string;
  name: string;
  description: string;
  examples: Array<string | { text: string; locale?: string }>;
  parameters: Record<string, unknown>;
  confirmation: 'none' | 'required';
  keywords: string[];
  resultSchema?: Record<string, unknown>;
  operationType?: string;
  effect?: string;
  requiredPermissions?: string[];
};

type StoredProvider = ProviderSeed & { toolIds: string[]; manifest: Record<string, unknown> };
type StoredTool = ToolSeed & { executionAdapter: string; available: boolean };
type StoredRecord = { providerId: string; recordType: string; recordId: string; value: Record<string, unknown>; origin: 'demo-seed' | 'user' };
type StoredAsset = Record<string, unknown> & { id: string; origin: 'demo-seed' | 'user' };
type SeedEmbeddingEntry = { id: string; sourceType: string; text: string; locale: string | null; contentHash: string };
type SeedEmbeddingFixture = {
  model: string;
  modelVersion: string;
  tokenizer: string;
  revision: string;
  preprocessing: string;
  dtype: string;
  dimensions: number;
  pooling: string;
  normalized: boolean;
  similarityMetric: string;
  seedDate: string;
  entries: SeedEmbeddingEntry[];
  vectorsBase64: string;
};

const seedProviders = providerSeed as ProviderSeed[];
const seedTools = toolSeed as ToolSeed[];
const seedData = providerDataSeed as Record<string, Record<string, Array<Record<string, unknown>>>>;
const seededEmbeddings = embeddingSeed as SeedEmbeddingFixture;
const seedDate = seededEmbeddings.seedDate;
const parsedSeedDate = new Date(`${seedDate}T00:00:00.000Z`);
if (!/^\d{4}-\d{2}-\d{2}$/.test(seedDate) || !Number.isFinite(parsedSeedDate.getTime())
  || utcDateString(parsedSeedDate) !== seedDate) {
  throw new Error('The packaged seed embedding date is invalid.');
}
const packagedSeedOffsetDays = seedOffsetDays(parsedSeedDate);

function recordKey(providerId: string, recordType: string, recordId: string) {
  return JSON.stringify([providerId, recordType, recordId]);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function assertConversationState(state: unknown): asserts state is Record<string, unknown> {
  const statuses = new Set([
    'awaiting_tool_choice', 'awaiting_argument', 'awaiting_entity_choice',
    'awaiting_confirmation', 'executing', 'completed', 'failed', 'cancelled',
  ]);
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new TypeError('Conversation state must be an object.');
  const value = state as Record<string, unknown>;
  if (typeof value.conversationId !== 'string' || !value.conversationId || !statuses.has(String(value.status))) {
    throw new TypeError('Conversation state is invalid.');
  }
  if (new TextEncoder().encode(JSON.stringify(value)).length > 262144) throw new RangeError('Conversation state exceeds the local storage limit.');
}

export class UserDatabase {
  readonly storage: StorageAdapter;
  readonly persistent: boolean;
  readonly storageWarning?: string;

  constructor(storage: StorageAdapter, persistent: boolean, storageWarning?: string) {
    this.storage = storage;
    this.persistent = persistent;
    this.storageWarning = storageWarning;
  }

  static async open() {
    const opened = await openUserStorage();
    const database = new UserDatabase(opened.storage, opened.persistent, opened.warning);
    return database.initialize();
  }

  async initialize() {
    await this.migrate();
    await this.initializeSeed();
    return this;
  }

  private async migrate() {
    let current = await this.storage.get<number>('meta', 'schemaVersion') ?? 0;
    if (!Number.isInteger(current) || current < 0 || current > APP_SCHEMA_VERSION) {
      throw new Error(`Unsupported local database schema version: ${current}`);
    }
    if (current < 1) {
      await this.storage.put('meta', 'schemaVersion', 1);
      current = 1;
    }
    if (current < 2) {
      for (const counter of ['dots3Requests', 'dots3Calls']) {
        if (await this.storage.get('usage', counter) === undefined) await this.storage.put('usage', counter, 0);
      }
      await this.storage.put('meta', 'schemaVersion', 2);
    }
  }

  private async initializeSeedEmbeddings() {
    if (seededEmbeddings.model !== EMBEDDING_MODEL || seededEmbeddings.modelVersion !== EMBEDDING_MODEL
      || seededEmbeddings.tokenizer !== EMBEDDING_TOKENIZER || seededEmbeddings.preprocessing !== EMBEDDING_PREPROCESSING
      || seededEmbeddings.revision !== EMBEDDING_REVISION
      || seededEmbeddings.dtype !== 'q8'
      || seededEmbeddings.dimensions !== EMBEDDING_DIMENSIONS || seededEmbeddings.pooling !== 'mean'
      || seededEmbeddings.normalized !== true || seededEmbeddings.similarityMetric !== 'cosine') {
      console.warn('Packaged seed embeddings are outdated; they will be regenerated locally as needed.');
      return;
    }
    const seedVersion = await sha256(JSON.stringify(seededEmbeddings));
    if (await this.storage.get<string>('meta', 'toolEmbeddingsVersion') === seedVersion) return;
    const bytes = Uint8Array.from(atob(seededEmbeddings.vectorsBase64), character => character.charCodeAt(0));
    const vectorBytes = EMBEDDING_DIMENSIONS * Float32Array.BYTES_PER_ELEMENT;
    if (bytes.byteLength !== seededEmbeddings.entries.length * vectorBytes) {
      throw new Error('The packaged tool embedding fixture has an invalid vector length.');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let index = 0; index < seededEmbeddings.entries.length; index++) {
      const entry = seededEmbeddings.entries[index];
      const expectedContentHash = await sha256(`${entry.sourceType}\u0000${entry.text}\u0000${entry.locale ?? ''}`);
      if (expectedContentHash !== entry.contentHash) throw new Error(`The packaged tool embedding text hash is invalid: ${entry.id}`);
      const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, (_value, dimension) =>
        view.getFloat32(index * vectorBytes + dimension * Float32Array.BYTES_PER_ELEMENT, true));
      const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
      if (vector.some(value => !Number.isFinite(value)) || Math.abs(magnitude - 1) > 0.002) {
        throw new Error(`The packaged tool embedding vector is invalid: ${entry.id}`);
      }
      const cacheKey = `${EMBEDDING_MODEL}:${EMBEDDING_CACHE_VERSION}:${await sha256(entry.text)}`;
      await this.storage.putIfAbsent('embeddings', cacheKey, {
        model: EMBEDDING_MODEL,
        version: EMBEDDING_CACHE_VERSION,
        dimensions: EMBEDDING_DIMENSIONS,
        vector,
      });
    }
    await this.storage.put('meta', 'toolEmbeddingsVersion', seedVersion);
  }

  private async initializeSeed() {
    const toolsByProvider = new Map<string, string[]>();
    for (const tool of seedTools) {
      const tools = toolsByProvider.get(tool.providerId) ?? [];
      tools.push(tool.id);
      toolsByProvider.set(tool.providerId, tools);
    }
    for (const provider of seedProviders) {
      const toolIds = toolsByProvider.get(provider.id) ?? [];
      const stored: StoredProvider = {
        ...provider,
        toolIds,
        manifest: { ...provider, toolIds },
      };
      if (await this.storage.get('providers', provider.id) === undefined) {
        await this.storage.put('providers', provider.id, stored);
      }
    }
    for (const tool of seedTools) {
      const provider = seedProviders.find(item => item.id === tool.providerId);
      if (!provider) throw new TypeError(`Seed tool ${tool.id} references an unknown provider.`);
      const stored: StoredTool = {
        ...tool,
        available: true,
        executionAdapter: provider.adapter,
        resultSchema: tool.resultSchema ?? JSON_SCHEMA_REF,
      };
      if (await this.storage.get('tools', tool.id) === undefined) {
        await this.storage.put('tools', tool.id, stored);
      }
    }
    for (const [providerId, recordsByType] of Object.entries(seedData)) {
      for (const [recordType, records] of Object.entries(recordsByType)) {
        if (recordType === 'assets') {
          for (const asset of records) {
            if (typeof asset.id !== 'string') throw new TypeError('A seed asset is missing its ID.');
            if (await this.storage.get('assets', asset.id) === undefined) {
              await this.storage.put('assets', asset.id, { ...asset, origin: 'demo-seed' });
            }
          }
          continue;
        }
        for (const value of records) {
          if (typeof value.id !== 'string') throw new TypeError(`Seed record in ${providerId}.${recordType} is missing its ID.`);
          const stored: StoredRecord = { providerId, recordType, recordId: value.id, value, origin: 'demo-seed' };
          const key = recordKey(providerId, recordType, value.id);
          if (await this.storage.get(RECORD_STORE, key) === undefined) {
            await this.storage.put(RECORD_STORE, key, stored);
          }
        }
      }
    }
    if (await this.storage.get('meta', 'toolRetrievalConfig') === undefined) {
      await this.storage.put('meta', 'toolRetrievalConfig', retrievalConfig);
    }
    await this.storage.put('meta', 'seedVersion', 1);
    await this.initializeSeedEmbeddings();
  }

  async getRegistryData() {
    const providers = await this.storage.getAll<StoredProvider>('providers');
    const tools = await this.storage.getAll<StoredTool>('tools');
    const storedRecords = await this.storage.getAll<StoredRecord>(RECORD_STORE);
    const assets = await this.storage.getAll<StoredAsset>('assets');
    const data: Record<string, Record<string, Record<string, unknown>[]>> = {};
    for (const stored of storedRecords) {
      data[stored.providerId] ??= {};
      data[stored.providerId][stored.recordType] ??= [];
      data[stored.providerId][stored.recordType].push(presentRecord(stored));
    }
    for (const rows of Object.values(data)) {
      for (const values of Object.values(rows)) values.sort((left, right) => String(left.id).localeCompare(String(right.id)));
    }
    if (assets.length) {
      data.web ??= {};
      data.web.assets = assets.map(({ origin: _origin, ...asset }) => asset);
    }
    const demoClock = currentDemoClock();
    const toolRetrievalConfig = await this.storage.get<Record<string, unknown>>('meta', 'toolRetrievalConfig');
    return { providers, tools, data, demoClock, toolRetrievalConfig: toolRetrievalConfig ?? retrievalConfig };
  }

  async getRecords(providerId: string, recordType: string) {
    const records = await this.storage.getAll<StoredRecord>(RECORD_STORE);
    return records.filter(item => item.providerId === providerId && item.recordType === recordType)
      .sort((left, right) => left.recordId.localeCompare(right.recordId))
      .map(presentRecord);
  }

  async getRecord(providerId: string, recordType: string, recordId: string) {
    const item = await this.storage.get<StoredRecord>(RECORD_STORE, recordKey(providerId, recordType, recordId));
    return item && presentRecord(item);
  }

  async putRecord(providerId: string, recordType: string, value: Record<string, unknown>) {
    if (typeof value.id !== 'string' || !value.id) throw new TypeError('A user record requires a string ID.');
    const stored: StoredRecord = { providerId, recordType, recordId: value.id, value, origin: 'user' };
    await this.storage.put(RECORD_STORE, recordKey(providerId, recordType, value.id), stored);
  }

  async deleteRecord(providerId: string, recordType: string, recordId: string) {
    await this.storage.delete(RECORD_STORE, recordKey(providerId, recordType, recordId));
  }

  async getAssets() {
    return (await this.storage.getAll<StoredAsset>('assets')).map(({ origin: _origin, ...asset }) => asset);
  }

  async nextId(providerId: string, recordType: string, prefix: string) {
    const records = await this.getRecords(providerId, recordType);
    const numbers = records.map(item => String(item.id)).filter(id => id.startsWith(`${prefix}-`))
      .map(id => Number(id.slice(prefix.length + 1))).filter(Number.isInteger);
    return `${prefix}-${Math.max(0, ...numbers) + 1}`;
  }

  async getCachedEmbedding(text: string, model: string) {
    const key = `${model}:${EMBEDDING_CACHE_VERSION}:${await sha256(text)}`;
    return this.storage.get<{ model: string; version: string; dimensions: number; vector: number[] }>('embeddings', key);
  }

  async cacheEmbedding(text: string, model: string, dimensions: number, vector: number[]) {
    if (!Array.isArray(vector) || vector.length !== dimensions || vector.some(value => !Number.isFinite(value))) {
      throw new TypeError(`Cached embedding must contain ${dimensions} finite numbers.`);
    }
    const key = `${model}:${EMBEDDING_CACHE_VERSION}:${await sha256(text)}`;
    await this.storage.put('embeddings', key, { model, version: EMBEDDING_CACHE_VERSION, dimensions, vector });
  }

  async recordUsage(counter: string, amount = 1) {
    const allowed = new Set(['requests', 'localCalls', 'externalCalls', 'dots3Requests', 'dots3Calls', 'executions', 'successes', 'failures', 'clarifications']);
    if (!allowed.has(counter) || !Number.isInteger(amount) || amount < 0 || amount > 10000) {
      throw new TypeError('Usage counter update is invalid.');
    }
    await this.storage.incrementNumber('usage', counter, amount);
  }

  async getUsageStats() {
    const counters = ['requests', 'localCalls', 'externalCalls', 'dots3Requests', 'dots3Calls', 'executions', 'successes', 'failures', 'clarifications'];
    const values = await Promise.all(counters.map(async counter => [
      counter,
      await this.storage.get<number>('usage', counter) ?? 0,
    ] as const));
    for (const [counter, value] of values) {
      if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`Stored usage counter is invalid: ${counter}`);
    }
    return Object.fromEntries(values);
  }

  async recordRequestStatistic(statistic: RequestStatistic) {
    if (!statistic || typeof statistic.requestId !== 'string' || !statistic.requestId) {
      throw new TypeError('Request statistics record is invalid.');
    }
    return this.storage.putIfAbsent('requestStats', statistic.requestId, statistic);
  }

  async getRequestStatistics() {
    return this.storage.getAll<RequestStatistic>('requestStats');
  }

  async queueRequestStatistic(statistic: RequestStatistic) {
    await this.storage.putIfAbsent('telemetryQueue', statistic.requestId, {
      requestId: statistic.requestId,
      statistic,
      attempts: 0,
      nextAttemptAt: 0,
    });
  }

  async getPendingTelemetry() {
    return this.storage.getAll<{
      requestId: string;
      statistic: RequestStatistic;
      attempts: number;
      nextAttemptAt: number;
    }>('telemetryQueue');
  }

  async updatePendingTelemetry(requestId: string, attempts: number, nextAttemptAt: number) {
    const queued = await this.storage.get<{
      requestId: string;
      statistic: RequestStatistic;
      attempts: number;
      nextAttemptAt: number;
    }>('telemetryQueue', requestId);
    if (queued) await this.storage.put('telemetryQueue', requestId, { ...queued, attempts, nextAttemptAt });
  }

  async removePendingTelemetry(requestId: string) {
    await this.storage.delete('telemetryQueue', requestId);
  }

  async clearPendingTelemetry() {
    await this.storage.clear('telemetryQueue');
  }

  async getPreference<T extends StorageValue>(key: string) {
    return this.storage.get<T>('preferences', key);
  }

  async setPreference(key: string, value: StorageValue) {
    if (!key || key.length > 100) throw new TypeError('Preference key is invalid.');
    await this.storage.put('preferences', key, value);
  }

  async executeRegisteredTool(tool: StoredTool, provider: StoredProvider, arguments_: Record<string, unknown>, context: { confirmed?: boolean; operationId?: string }, execute: () => Promise<unknown>) {
    if (!tool.available || provider.status !== 'available') throw new Error(`Provider unavailable: ${provider.id}`);
    const requiredPermissions = tool.requiredPermissions ?? [];
    const providerPermissions = (provider.manifest as { permissions?: string[] }).permissions ?? [];
    if (requiredPermissions.some(permission => !providerPermissions.includes(permission))) {
      throw new Error(`Provider lacks execution permission for ${tool.id}`);
    }
    const validation = validateArguments(tool.parameters, arguments_);
    if (!validation.valid) throw new TypeError(`Invalid arguments for ${tool.id}: ${validation.errors.join('; ')}`);
    const formatErrors = validateFormats(tool.parameters, arguments_);
    if (formatErrors.length) throw new TypeError(`Invalid arguments for ${tool.id}: ${formatErrors.join('; ')}`);
    const sideEffect = tool.confirmation === 'required';
    if (sideEffect && context.confirmed !== true) throw new Error(`Confirmation required for ${tool.id}`);
    if (!sideEffect) return execute();
    const operationId = context.operationId;
    if (typeof operationId !== 'string' || !operationId || operationId.length > 160) throw new TypeError('A valid operation ID is required for a side effect.');
    const payloadHash = await sha256(stableStringify({ toolId: tool.id, arguments: arguments_ }));
    const operation = {
      toolId: tool.id,
      payloadHash,
      status: 'executing',
      updatedAt: new Date().toISOString(),
    };
    if (!await this.storage.putIfAbsent('operations', operationId, operation)) {
      const previous = await this.storage.get<{ toolId: string; payloadHash: string; status: string; result?: StorageValue }>('operations', operationId);
      if (!previous) throw new Error('The operation ID was concurrently claimed and its state could not be read.');
      if (previous.toolId !== tool.id || previous.payloadHash !== payloadHash) {
        throw new Error('Operation ID was already used for a different action or argument set.');
      }
      let existing = previous;
      if (existing.status === 'executing') {
        for (let attempt = 0; attempt < 100; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 50));
          const current = await this.storage.get<typeof existing>('operations', operationId);
          if (!current) throw new Error('The in-progress operation state disappeared.');
          existing = current;
          if (existing.status !== 'executing') break;
        }
      }
      if (existing.status === 'completed') return existing.result;
      if (existing.status === 'executing') throw new Error('The matching operation is still in progress; it was not started again.');
      throw new Error(`Operation cannot be safely repeated after status ${existing.status}.`);
    }
    try {
      const result = await execute();
      await this.storage.put('operations', operationId, {
        toolId: tool.id,
        payloadHash,
        status: 'completed',
        result: result as StorageValue,
        updatedAt: new Date().toISOString(),
      });
      return result;
    } catch (error) {
      try {
        await this.storage.put('operations', operationId, {
          toolId: tool.id,
          payloadHash,
          status: 'failed',
          error: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
          updatedAt: new Date().toISOString(),
        });
      } catch (storageError) {
        throw new AggregateError([error, storageError], 'The action failed and its failure status could not be persisted.');
      }
      throw error;
    }
  }

  async getConversationState() {
    const state = await this.storage.get<Record<string, unknown>>('workflows', 'active');
    if (!state) return undefined;
    if (typeof state.expiresAt === 'string' && Date.parse(state.expiresAt) <= Date.now()) {
      await this.storage.delete('workflows', 'active');
      return undefined;
    }
    assertConversationState(state);
    return state;
  }

  async saveConversationState(state: Record<string, unknown> | null) {
    if (state === null || state.status === 'idle') {
      await this.storage.delete('workflows', 'active');
      return;
    }
    assertConversationState(state);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await this.storage.put('workflows', 'active', { ...state, expiresAt });
  }

  async resetDemoData() {
    for (const store of ['providers', 'tools', RECORD_STORE, 'assets', 'embeddings', 'workflows', 'operations']) {
      await this.storage.clear(store);
    }
    await this.storage.delete('meta', 'toolEmbeddingsVersion');
    await this.initializeSeed();
  }

  async exportBackup() {
    const stores = ['meta', 'providers', 'tools', 'records', 'assets', 'embeddings', 'workflows', 'operations', 'usage', 'preferences', 'requestStats'];
    const data: Record<string, Array<{ key: string; value: StorageValue }>> = {};
    for (const store of stores) data[store] = await this.storage.entries<StorageValue>(store);
    return {
      format: 'cue-browser-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      schemaVersion: await this.storage.get('meta', 'schemaVersion'),
      data,
    };
  }

  close() {
    this.storage.close();
  }
}

let databasePromise: Promise<UserDatabase> | undefined;

export function openBrowserDatabase() {
  if (!databasePromise) {
    databasePromise = UserDatabase.open().catch(error => {
      databasePromise = undefined;
      throw error;
    });
  }
  return databasePromise;
}
