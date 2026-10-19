import { useSyncExternalStore } from 'react';
import { storeDelete, storeEntries, storeGet, storeKeys, storeSet } from './store.ts';

/** A change made while the server was out of reach, sent later in the same order. */
export type OutboxItem = {
  id: string;
  scope: string;
  method: string;
  path: string;
  body: string | null;
  /** Idempotency-Key: a resend after a lost answer is not applied twice. */
  key: string;
  label: string;
  /** e.g. "order:<id>": later changes of the same entity depend on earlier ones. */
  entity: string;
  createdAt: string;
  /** Set when the server refused the change; the queue waits for "retry" or "discard". */
  error?: string;
  /** Time a booking made or moved on this phone occupies until the server has it. */
  busy?: { id: string; startAt: string; durationMinutes: number; free?: boolean };
};

/** "order:<id>" → "/api/orders/<id>", "booking:<id>" → "/api/bookings/<id>": the entity's own copy. */
function entityPath(entity: string) {
  const match = /^(order|booking):(.+)$/.exec(entity);
  return match ? `/api/${match[1]}s/${match[2]}` : null;
}

export type SyncState = { reachable: boolean; syncing: boolean; pending: number; failed: OutboxItem | null };

type Sender = (item: OutboxItem) => Promise<Response>;
type Cached<T> = { value: T; savedAt: string };

let send: Sender | null = null;
let scopeOf: () => string = () => 'anonymous';
let state: SyncState = { reachable: typeof navigator === 'undefined' || navigator.onLine !== false, syncing: false, pending: 0, failed: null };
const listeners = new Set<() => void>();
let sequence = 0;

function emit(next: Partial<SyncState>) {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener());
}

/** Scope separates the copies of different employees on one phone (hash of the session token). */
export function tokenScope(token: string | null) {
  let hash = 2166136261;
  for (const char of token ?? 'anonymous') hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(36);
}

export function configureSync(options: { send: Sender; scope: () => string }) {
  send = options.send;
  scopeOf = options.scope;
  void refreshCounts();
}

export const syncState = () => state;
export function subscribeSync(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export const useSyncState = () => useSyncExternalStore(subscribeSync, syncState, syncState);

export function markReachable(reachable: boolean) {
  if (state.reachable === reachable) return;
  emit({ reachable });
  if (reachable) void flush();
}

// ---- Copy of server data -------------------------------------------------------------------

const cacheKey = (path: string) => `${scopeOf()}|${path}`;

export async function readCache<T>(path: string): Promise<T | undefined> {
  return (await storeGet<Cached<T>>('cache', cacheKey(path)))?.value;
}

export async function writeCache(path: string, value: unknown) {
  await storeSet('cache', cacheKey(path), { value, savedAt: new Date().toISOString() });
}

// ---- Queue of changes ------------------------------------------------------------------------

async function scopedItems() {
  const scope = scopeOf();
  return (await storeEntries<OutboxItem>('outbox')).map(([, item]) => item).filter((item) => item.scope === scope);
}

async function refreshCounts() {
  const items = await scopedItems();
  emit({ pending: items.length, failed: items.find((item) => item.error) ?? null });
}

export async function hasPending(entity?: string) {
  return (await scopedItems()).some((item) => !entity || item.entity === entity);
}

export async function enqueue(item: Omit<OutboxItem, 'id' | 'scope' | 'createdAt'>) {
  const createdAt = new Date().toISOString();
  // Keys sort in creation order.
  const id = `${String(Date.now()).padStart(15, '0')}-${String(sequence++).padStart(6, '0')}`;
  await storeSet('outbox', id, { ...item, id, scope: scopeOf(), createdAt });
  await refreshCounts();
  if (state.reachable) void flush();
}

/** Sends queued changes in order; stops at the first one the server refuses or when offline. */
export async function flush() {
  if (state.syncing || !send) return;
  emit({ syncing: true });
  let sentAny = false;
  try {
    for (const item of await scopedItems()) {
      if (item.error) break;
      let response: Response;
      try {
        response = await send(item);
      } catch {
        emit({ reachable: false });
        break;
      }
      if (!state.reachable) emit({ reachable: true });
      const payload = await response.json().catch(() => null);
      if (response.ok) {
        await afterSent(item, payload);
        await storeDelete('outbox', item.id);
        sentAny = true;
      } else if (response.status === 401) {
        break;
      } else {
        await storeSet('outbox', item.id, { ...item, error: payload?.error?.message ?? 'Сервер не принял изменение' });
        break;
      }
    }
  } finally {
    emit({ syncing: false });
    await refreshCounts();
  }
  // Open screens reload their data from the server once everything is sent.
  if (sentAny && state.pending === 0 && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('detailflow:synced'));
}

async function afterSent(item: OutboxItem, payload: unknown) {
  // An order or booking change answers with the whole entity: it replaces the local copy.
  const path = entityPath(item.entity);
  const id = item.entity.slice(item.entity.indexOf(':') + 1);
  if (path && payload && typeof payload === 'object' && (payload as { id?: string }).id === id &&
    ('estimateVersions' in payload || 'quoteVersions' in payload)) await writeCache(path, payload);
}

/** Busy time of bookings made or moved here and not yet accepted (latest change per booking). */
export async function pendingBusy() {
  const latest = new Map<string, NonNullable<OutboxItem['busy']>>();
  for (const item of await scopedItems()) if (item.busy) latest.set(item.busy.id, item.busy);
  return [...latest.values()];
}

/** Paths of saved answers starting with a prefix, for patching lists after a local change. */
export async function cachedPaths(prefix: string) {
  const scope = `${scopeOf()}|`;
  return (await storeKeys('cache'))
    .filter((key) => key.startsWith(scope + prefix)).map((key) => key.slice(scope.length));
}

export async function retryFailed() {
  const failed = (await scopedItems()).find((item) => item.error);
  if (failed) await storeSet('outbox', failed.id, { ...failed, error: undefined });
  await refreshCounts();
  await flush();
}

/**
 * Drops a refused change together with the later changes of the same entity (they were made on top
 * of it) and forgets the local copy of that entity so it is reloaded from the server.
 */
export async function discardFailed() {
  const items = await scopedItems();
  const failed = items.find((item) => item.error);
  if (!failed) return 0;
  const dropped = items.filter((item) => item.entity === failed.entity && item.id >= failed.id);
  for (const item of dropped) await storeDelete('outbox', item.id);
  const path = entityPath(failed.entity);
  if (path) await storeDelete('cache', cacheKey(path));
  await refreshCounts();
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('detailflow:synced'));
  await flush();
  return dropped.length;
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => markReachable(true));
  window.addEventListener('offline', () => emit({ reachable: false }));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void flush(); });
  // The browser may report "online" while the center's server is unreachable: keep trying quietly.
  setInterval(() => { if (state.pending > 0 && !state.failed) void flush(); }, 15_000);
}
