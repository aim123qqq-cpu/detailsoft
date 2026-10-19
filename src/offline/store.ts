/**
 * Tiny key-value store on IndexedDB for the offline copy of server data and the queue of changes.
 * Falls back to memory when IndexedDB is unavailable (private mode, tests): the app keeps working,
 * it just forgets the copy on reload.
 */
type StoreName = 'cache' | 'outbox';

const DB_NAME = 'detailflow-offline';
const memory: Record<StoreName, Map<string, unknown>> = { cache: new Map(), outbox: new Map() };
let opening: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (opening) return opening;
  opening = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('cache');
        request.result.createObjectStore('outbox');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
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
  if (!(await open())) return memory[store].get(key) as T | undefined;
  return run<T>(store, 'readonly', (objects) => objects.get(key) as IDBRequest<T>);
}

export async function storeSet(store: StoreName, key: string, value: unknown): Promise<void> {
  if (!(await open())) { memory[store].set(key, value); return; }
  await run(store, 'readwrite', (objects) => objects.put(value, key));
}

export async function storeDelete(store: StoreName, key: string): Promise<void> {
  if (!(await open())) { memory[store].delete(key); return; }
  await run(store, 'readwrite', (objects) => objects.delete(key));
}

/** All entries ordered by key. */
export async function storeEntries<T>(store: StoreName): Promise<Array<[string, T]>> {
  if (!(await open())) return [...memory[store].entries()].sort(([left], [right]) => left.localeCompare(right)) as Array<[string, T]>;
  const [keys, values] = await Promise.all([
    run<IDBValidKey[]>(store, 'readonly', (objects) => objects.getAllKeys()),
    run<T[]>(store, 'readonly', (objects) => objects.getAll())
  ]);
  return (keys ?? []).map((key, index) => [String(key), (values ?? [])[index]] as [string, T]);
}
