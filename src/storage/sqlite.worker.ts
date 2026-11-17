/// <reference lib="webworker" />
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { StorageValue } from './storage';

type Request = {
  id: number;
  operation: 'get' | 'getAll' | 'entries' | 'put' | 'putIfAbsent' | 'incrementNumber' | 'delete' | 'clear' | 'close';
  store: string;
  key?: string;
  value?: StorageValue;
};

const databasePromise = sqlite3InitModule().then(sqlite3 => {
  if (!('opfs' in sqlite3)) throw new Error('SQLite OPFS is unavailable in this browser context.');
  const db = new sqlite3.oo1.OpfsDb('/cue-user.sqlite3');
  const version = Number(db.selectValue('PRAGMA user_version') ?? 0);
  if (version > 1) throw new Error(`The local database schema version ${version} is newer than this Cue application supports.`);
  if (version < 1) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('CREATE TABLE cue_entries(store TEXT NOT NULL, entry_key TEXT NOT NULL, value_json TEXT NOT NULL, PRIMARY KEY(store, entry_key)); PRAGMA user_version = 1; COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return db;
});

self.addEventListener('message', async event => {
  const request = event.data as Request;
  try {
    const db = await databasePromise;
    if (request.operation === 'get') {
      const result = db.selectValue('SELECT value_json FROM cue_entries WHERE store=? AND entry_key=?', [request.store, request.key ?? '']);
      self.postMessage({ id: request.id, value: result === undefined ? undefined : JSON.parse(String(result)) });
    } else if (request.operation === 'getAll') {
      const rows = db.selectValues('SELECT value_json FROM cue_entries WHERE store=? ORDER BY entry_key', [request.store]);
      self.postMessage({ id: request.id, value: rows.map(value => JSON.parse(String(value))) });
    } else if (request.operation === 'entries') {
      const rows = db.selectArrays('SELECT entry_key,value_json FROM cue_entries WHERE store=? ORDER BY entry_key', [request.store]);
      self.postMessage({ id: request.id, value: rows.map(([key, value]) => ({ key: String(key), value: JSON.parse(String(value)) })) });
    } else if (request.operation === 'put') {
      db.exec({ sql: 'INSERT INTO cue_entries(store,entry_key,value_json) VALUES(?,?,?) ON CONFLICT(store,entry_key) DO UPDATE SET value_json=excluded.value_json', bind: [request.store, request.key ?? '', JSON.stringify(request.value)] });
      self.postMessage({ id: request.id });
    } else if (request.operation === 'putIfAbsent') {
      db.exec({ sql: 'INSERT OR IGNORE INTO cue_entries(store,entry_key,value_json) VALUES(?,?,?)', bind: [request.store, request.key ?? '', JSON.stringify(request.value)] });
      self.postMessage({ id: request.id, value: Number(db.selectValue('SELECT changes()')) === 1 });
    } else if (request.operation === 'incrementNumber') {
      const amount = request.value;
      if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0) throw new RangeError('Counter increment is invalid.');
      db.exec('BEGIN IMMEDIATE');
      try {
        const stored = db.selectValue('SELECT value_json FROM cue_entries WHERE store=? AND entry_key=?', [request.store, request.key ?? '']);
        const current = stored === undefined ? 0 : JSON.parse(String(stored));
        if (!Number.isSafeInteger(current) || current < 0 || current + amount > Number.MAX_SAFE_INTEGER) {
          throw new RangeError('Stored counter is invalid or exceeds the supported range.');
        }
        const next = current + amount;
        db.exec({
          sql: 'INSERT INTO cue_entries(store,entry_key,value_json) VALUES(?,?,?) ON CONFLICT(store,entry_key) DO UPDATE SET value_json=excluded.value_json',
          bind: [request.store, request.key ?? '', JSON.stringify(next)],
        });
        db.exec('COMMIT');
        self.postMessage({ id: request.id, value: next });
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    } else if (request.operation === 'delete') {
      db.exec({ sql: 'DELETE FROM cue_entries WHERE store=? AND entry_key=?', bind: [request.store, request.key ?? ''] });
      self.postMessage({ id: request.id });
    } else if (request.operation === 'clear') {
      db.exec({ sql: 'DELETE FROM cue_entries WHERE store=?', bind: [request.store] });
      self.postMessage({ id: request.id });
    } else if (request.operation === 'close') {
      db.close();
      self.postMessage({ id: request.id });
    }
  } catch (error) {
    self.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
});
