/**
 * Tiny key-value store on IndexedDB for the offline copy of server data and the queue of changes.
 * Falls back to memory when IndexedDB is unavailable (private mode, tests): the app keeps working,
 * it just forgets the copy on reload.
 */
/** cache: saved answers; outbox: queued changes; meta: when and how big each saved answer is (for cleanup). */
export type StoreName = 'cache' | 'outbox' | 'meta';

/**
 * Where the stores live. The browser uses IndexedDB (below); the native app plugs in SQLite with
 * `setStoreBackend`, and the queue and copy logic in sync.ts stay the same on both.
 */
export type StoreBackend = {
  get<T>(store: StoreName, key: string): Promise<T | undefined>;
  set(store: StoreName, key: string, value: unknown): Promise<void>;
  delete(store: StoreName, key: string): Promise<void>;
  /** All entries ordered by key. */
  entries<T>(store: StoreName): Promise<Array<[string, T]>>;
  keys(store: StoreName): Promise<string[]>;
  wipe(): Promise<void>;
};
let backend: StoreBackend | null = null;
export function setStoreBackend(next: StoreBackend) { backend = next; }
const STORES: StoreName[] = ['cache', 'outbox', 'meta'];

const DB_NAME = 'detailflow-offline';
const memory: Record<StoreName, Map<string, unknown>> = { cache: new Map(), outbox: new Map(), meta: new Map() };
let opening: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (opening) return opening;
  opening = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const connect = (version?: number) => {
        const request = version ? indexedDB.open(DB_NAME, version) : indexedDB.open(DB_NAME);
        request.onupgradeneeded = () => {
          for (const store of STORES) if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);
        };
        request.onsuccess = () => {
          const db = request.result;
          // A database without one of our stores (older app version, or created elsewhere) is upgraded once.
          if (STORES.some((store) => !db.objectStoreNames.contains(store))) {
            const next = db.version + 1;
            db.close();
            return version ? resolve(null) : connect(next);
          }
          resolve(db);
        };
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
      };
      connect();
    } catch {
      resolve(null);
    }
  });
  return opening;
}

function run<T>(store: StoreName, mode: IDBTransactionMode, action: (objects: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return open().then((db) => new Promise<T | undefined>((resolve) => {
    if (!db) return resolve(undefined);
    try {
      const request = action(db.transaction(store, mode).objectStore(store));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  }));
}

export async function storeGet<T>(store: StoreName, key: string): Promise<T | undefined> {
  if (backend) return backend.get<T>(store, key);
  if (!(await open())) return memory[store].get(key) as T | undefined;
  return run<T>(store, 'readonly', (objects) => objects.get(key) as IDBRequest<T>);
}

export async function storeSet(store: StoreName, key: string, value: unknown): Promise<void> {
  if (backend) return backend.set(store, key, value);
  if (!(await open())) { memory[store].set(key, value); return; }
  await run(store, 'readwrite', (objects) => objects.put(value, key));
}

export async function storeDelete(store: StoreName, key: string): Promise<void> {
  if (backend) return backend.delete(store, key);
  if (!(await open())) { memory[store].delete(key); return; }
  await run(store, 'readwrite', (objects) => objects.delete(key));
}

/** All entries ordered by key. */
export async function storeEntries<T>(store: StoreName): Promise<Array<[string, T]>> {
  if (backend) return backend.entries<T>(store);
  if (!(await open())) return [...memory[store].entries()].sort(([left], [right]) => left.localeCompare(right)) as Array<[string, T]>;
  const [keys, values] = await Promise.all([
    run<IDBValidKey[]>(store, 'readonly', (objects) => objects.getAllKeys()),
    run<T[]>(store, 'readonly', (objects) => objects.getAll())
  ]);
  return (keys ?? []).map((key, index) => [String(key), (values ?? [])[index]] as [string, T]);
}

/** Keys only: cheap even when the values are large (orders with photos). */
export async function storeKeys(store: StoreName): Promise<string[]> {
  if (backend) return backend.keys(store);
  if (!(await open())) return [...memory[store].keys()];
  return ((await run<IDBValidKey[]>(store, 'readonly', (objects) => objects.getAllKeys())) ?? []).map(String);
}

/** Erases the whole offline copy and queue on this device (after the account is deleted). */
export async function wipeOfflineData(): Promise<void> {
  if (backend) return backend.wipe();
  for (const store of STORES) memory[store].clear();
  const db = await open();
  db?.close();
  opening = null;
  if (typeof indexedDB === 'undefined') return;
  await new Promise<void>((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(DB_NAME);
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}
