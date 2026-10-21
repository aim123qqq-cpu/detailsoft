import * as Crypto from 'expo-crypto';
import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import { setStoreBackend, type StoreName } from '@df/offline/store';

// The shared offline code (and the web's randomId) uses the Web Crypto API; Hermes has none of it.
type WebCrypto = { randomUUID?: () => string; getRandomValues?: typeof Crypto.getRandomValues };
const globalCrypto: WebCrypto = (globalThis as { crypto?: WebCrypto }).crypto ?? {};
if (typeof globalCrypto.randomUUID !== 'function') globalCrypto.randomUUID = Crypto.randomUUID;
if (typeof globalCrypto.getRandomValues !== 'function') globalCrypto.getRandomValues = Crypto.getRandomValues;
(globalThis as { crypto?: unknown }).crypto = globalCrypto;

/**
 * The phone's copy of server answers and the queue of changes made without the server, in SQLite
 * (the web app keeps the same stores in IndexedDB). One table: store, key, JSON value.
 */
let opening: Promise<SQLiteDatabase> | null = null;
function db() {
  opening ??= openDatabaseAsync('detailflow-offline.db').then(async (database) => {
    await database.execAsync(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS kv (store TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (store, key));`);
    return database;
  });
  return opening;
}

setStoreBackend({
  async get<T>(store: StoreName, key: string) {
    const row = await (await db()).getFirstAsync<{ value: string }>('SELECT value FROM kv WHERE store = ? AND key = ?', store, key);
    return row ? JSON.parse(row.value) as T : undefined;
  },
  async set(store, key, value) {
    await (await db()).runAsync('INSERT OR REPLACE INTO kv (store, key, value) VALUES (?, ?, ?)', store, key, JSON.stringify(value));
  },
  async delete(store, key) {
    await (await db()).runAsync('DELETE FROM kv WHERE store = ? AND key = ?', store, key);
  },
  async entries<T>(store: StoreName) {
    const rows = await (await db()).getAllAsync<{ key: string; value: string }>('SELECT key, value FROM kv WHERE store = ? ORDER BY key', store);
    return rows.map((row) => [row.key, JSON.parse(row.value) as T] as [string, T]);
  },
  async keys(store) {
    return (await (await db()).getAllAsync<{ key: string }>('SELECT key FROM kv WHERE store = ? ORDER BY key', store)).map((row) => row.key);
  },
  async wipe() {
    await (await db()).runAsync('DELETE FROM kv');
  }
});
