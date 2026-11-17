export type StorageValue = Record<string, unknown> | string | number | boolean | null | StorageValue[] | undefined;

export interface StorageAdapter {
  readonly backend: 'sqlite-opfs' | 'indexeddb';
  get<T extends StorageValue>(store: string, key: string): Promise<T | undefined>;
  getAll<T extends StorageValue>(store: string): Promise<T[]>;
  entries<T extends StorageValue>(store: string): Promise<Array<{ key: string; value: T }>>;
  put(store: string, key: string, value: StorageValue): Promise<void>;
  putIfAbsent(store: string, key: string, value: StorageValue): Promise<boolean>;
  incrementNumber(store: string, key: string, amount: number): Promise<number>;
  delete(store: string, key: string): Promise<void>;
  clear(store: string): Promise<void>;
  close(): void;
}

type WorkerRequest = {
  id: number;
  operation: 'get' | 'getAll' | 'entries' | 'put' | 'putIfAbsent' | 'incrementNumber' | 'delete' | 'clear' | 'close';
  store: string;
  key?: string;
  value?: StorageValue;
};

type WorkerResponse = { id: number; value?: StorageValue | StorageValue[]; error?: string };

class SqliteOpfsAdapter implements StorageAdapter {
  readonly backend = 'sqlite-opfs' as const;
  private worker: Worker;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: WorkerResponse['value']) => void; reject: (error: Error) => void }>();

  constructor(worker: Worker) {
    this.worker = worker;
    worker.addEventListener('message', event => {
      const response = event.data as WorkerResponse;
      const task = this.pending.get(response.id);
      if (!task) return;
      this.pending.delete(response.id);
      if (response.error) task.reject(new Error(response.error));
      else task.resolve(response.value);
    });
    worker.addEventListener('error', event => {
      const error = new Error(event.message || 'SQLite worker failed.');
      this.pending.forEach(task => task.reject(error));
      this.pending.clear();
    });
  }

  static async open() {
    const worker = new Worker(new URL('./sqlite.worker.ts', import.meta.url), { type: 'module' });
    const adapter = new SqliteOpfsAdapter(worker);
    try {
      await adapter.request({ operation: 'get', store: '__system__', key: '__initialize__' });
      return adapter;
    } catch (error) {
      worker.terminate();
      throw error;
    }
  }

  private request(request: Omit<WorkerRequest, 'id'>): Promise<WorkerResponse['value']> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...request, id });
    });
  }

  async get<T extends StorageValue>(store: string, key: string) {
    return await this.request({ operation: 'get', store, key }) as T | undefined;
  }

  async getAll<T extends StorageValue>(store: string) {
    return await this.request({ operation: 'getAll', store }) as T[];
  }

  async entries<T extends StorageValue>(store: string) {
    return await this.request({ operation: 'entries', store }) as Array<{ key: string; value: T }>;
  }

  async put(store: string, key: string, value: StorageValue) {
    await this.request({ operation: 'put', store, key, value });
  }

  async putIfAbsent(store: string, key: string, value: StorageValue) {
    return await this.request({ operation: 'putIfAbsent', store, key, value }) === true;
  }

  async incrementNumber(store: string, key: string, amount: number) {
    const result = await this.request({ operation: 'incrementNumber', store, key, value: amount });
    if (typeof result !== 'number') throw new TypeError('Storage returned an invalid counter value.');
    return result;
  }

  async delete(store: string, key: string) {
    await this.request({ operation: 'delete', store, key });
  }

  async clear(store: string) {
    await this.request({ operation: 'clear', store });
  }

  close() {
    void this.request({ operation: 'close', store: '__system__' }).finally(() => this.worker.terminate());
  }
}

type IndexedEntry = { id: string; store: string; key: string; value: StorageValue };

class IndexedDbAdapter implements StorageAdapter {
  readonly backend = 'indexeddb' as const;
  private db: IDBDatabase;

  private constructor(db: IDBDatabase) {
    this.db = db;
  }

  static open() {
    return new Promise<IndexedDbAdapter>((resolve, reject) => {
      const request = indexedDB.open('cue-user-storage', 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('entries', { keyPath: 'id' });
        store.createIndex('byStore', 'store', { unique: false });
      };
      request.onerror = () => reject(request.error ?? new Error('Could not open browser storage.'));
      request.onblocked = () => reject(new Error('Browser storage upgrade is blocked by another open Cue tab.'));
      request.onsuccess = () => resolve(new IndexedDbAdapter(request.result));
    });
  }

  private entryId(store: string, key: string) {
    return `${store}\u0000${key}`;
  }

  private transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>) {
    return new Promise<T>((resolve, reject) => {
      const transaction = this.db.transaction('entries', mode);
      const request = operation(transaction.objectStore('entries'));
      let result: T;
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => reject(request.error ?? new Error('Browser storage request failed.'));
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error ?? new Error('Browser storage transaction failed.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Browser storage transaction was aborted.'));
    });
  }

  async get<T extends StorageValue>(store: string, key: string) {
    const entry = await this.transaction<IndexedEntry | undefined>('readonly', objectStore => objectStore.get(this.entryId(store, key)));
    return entry?.value as T | undefined;
  }

  async getAll<T extends StorageValue>(store: string) {
    const entries = await this.transaction<IndexedEntry[]>('readonly', objectStore => objectStore.index('byStore').getAll(store));
    return entries.map(entry => entry.value as T);
  }

  async entries<T extends StorageValue>(store: string) {
    const entries = await this.transaction<IndexedEntry[]>('readonly', objectStore => objectStore.index('byStore').getAll(store));
    return entries.map(entry => ({ key: entry.key, value: entry.value as T }));
  }

  async put(store: string, key: string, value: StorageValue) {
    await this.transaction<IDBValidKey>('readwrite', objectStore => objectStore.put({ id: this.entryId(store, key), store, key, value }));
  }

  async putIfAbsent(store: string, key: string, value: StorageValue) {
    return new Promise<boolean>((resolve, reject) => {
      const transaction = this.db.transaction('entries', 'readwrite');
      const request = transaction.objectStore('entries').add({ id: this.entryId(store, key), store, key, value });
      let inserted = true;
      request.onerror = event => {
        if (request.error?.name === 'ConstraintError') {
          inserted = false;
          event.preventDefault();
          event.stopPropagation();
        } else {
          reject(request.error ?? new Error('Browser storage request failed.'));
        }
      };
      transaction.oncomplete = () => resolve(inserted);
      transaction.onerror = () => reject(transaction.error ?? new Error('Browser storage transaction failed.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Browser storage transaction was aborted.'));
    });
  }

  async incrementNumber(store: string, key: string, amount: number) {
    return new Promise<number>((resolve, reject) => {
      const transaction = this.db.transaction('entries', 'readwrite');
      const objectStore = transaction.objectStore('entries');
      const id = this.entryId(store, key);
      const request = objectStore.get(id);
      let nextValue: number;
      request.onsuccess = () => {
        const current = request.result?.value ?? 0;
        if (!Number.isSafeInteger(amount) || amount < 0 || !Number.isSafeInteger(current) || current < 0
          || current + amount > Number.MAX_SAFE_INTEGER) {
          transaction.abort();
          reject(new RangeError('Stored counter is invalid or exceeds the supported range.'));
          return;
        }
        nextValue = current + amount;
        objectStore.put({ id, store, key, value: nextValue });
      };
      request.onerror = () => reject(request.error ?? new Error('Browser storage request failed.'));
      transaction.oncomplete = () => resolve(nextValue);
      transaction.onerror = () => reject(transaction.error ?? new Error('Browser storage transaction failed.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Browser storage transaction was aborted.'));
    });
  }

  async delete(store: string, key: string) {
    await this.transaction<undefined>('readwrite', objectStore => objectStore.delete(this.entryId(store, key)));
  }

  async clear(store: string) {
    const entries = await this.transaction<IndexedEntry[]>('readonly', objectStore => objectStore.index('byStore').getAll(store));
    await new Promise<void>((resolve, reject) => {
      const transaction = this.db.transaction('entries', 'readwrite');
      const objectStore = transaction.objectStore('entries');
      entries.forEach(entry => objectStore.delete(entry.id));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not clear browser storage.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Browser storage transaction was aborted.'));
    });
  }

  close() {
    this.db.close();
  }
}

export type OpenStorageResult = { storage: StorageAdapter; persistent: boolean; warning?: string };

export async function openUserStorage(): Promise<OpenStorageResult> {
  let storage: StorageAdapter;
  let warning: string | undefined;
  if (globalThis.crossOriginIsolated && typeof Worker !== 'undefined' && 'storage' in navigator && 'getDirectory' in navigator.storage) {
    const fallback = await IndexedDbAdapter.open();
    let opfs: SqliteOpfsAdapter | undefined;
    try {
      opfs = await SqliteOpfsAdapter.open();
      if (await opfs.get('meta', 'indexedDbImportV1') !== true) {
        for (const store of ['meta', 'providers', 'tools', 'records', 'assets', 'embeddings', 'workflows', 'operations', 'usage', 'preferences', 'requestStats', 'telemetryQueue']) {
          for (const entry of await fallback.entries<StorageValue>(store)) {
            const current = await opfs.get(store, entry.key);
            if (current === undefined) await opfs.put(store, entry.key, entry.value);
          }
        }
        await opfs.put('meta', 'indexedDbImportV1', true);
      }
      storage = opfs;
      fallback.close();
    } catch (error) {
      opfs?.close();
      storage = fallback;
      warning = `SQLite OPFS could not be initialized; using IndexedDB instead: ${error instanceof Error ? error.message : String(error)}`;
    }
  } else {
    storage = await IndexedDbAdapter.open();
  }
  let persistent = false;
  if (navigator.storage?.persist) {
    try {
      persistent = await navigator.storage.persist();
    } catch (error) {
      console.warn('Cue could not request persistent browser storage.', error);
    }
  }
  return { storage, persistent, warning };
}

export function createMemoryStorage(): StorageAdapter {
  const values = new Map<string, StorageValue>();
  const id = (store: string, key: string) => `${store}\u0000${key}`;
  return {
    backend: 'indexeddb',
    async get<T extends StorageValue>(store: string, key: string) {
      const value = values.get(id(store, key));
      return value === undefined ? undefined : structuredClone(value) as T;
    },
    async getAll<T extends StorageValue>(store: string) {
      const prefix = `${store}\u0000`;
      return [...values].filter(([key]) => key.startsWith(prefix)).map(([, value]) => structuredClone(value) as T);
    },
    async entries<T extends StorageValue>(store: string) {
      const prefix = `${store}\u0000`;
      return [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key: key.slice(prefix.length), value: structuredClone(value) as T }));
    },
    async put(store: string, key: string, value: StorageValue) { values.set(id(store, key), structuredClone(value)); },
    async putIfAbsent(store: string, key: string, value: StorageValue) {
      const entryId = id(store, key);
      if (values.has(entryId)) return false;
      values.set(entryId, structuredClone(value));
      return true;
    },
    async incrementNumber(store: string, key: string, amount: number) {
      const entryId = id(store, key);
      const current = values.get(entryId) ?? 0;
      if (!Number.isSafeInteger(amount) || amount < 0 || typeof current !== 'number' || !Number.isSafeInteger(current) || current < 0
        || current + amount > Number.MAX_SAFE_INTEGER) throw new RangeError('Stored counter is invalid or exceeds the supported range.');
      const next = current + amount;
      values.set(entryId, next);
      return next;
    },
    async delete(store: string, key: string) { values.delete(id(store, key)); },
    async clear(store: string) {
      const prefix = `${store}\u0000`;
      values.forEach((_value, key) => { if (key.startsWith(prefix)) values.delete(key); });
    },
    close() {},
  };
}
