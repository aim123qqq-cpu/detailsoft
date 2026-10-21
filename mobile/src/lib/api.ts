import { randomUUID } from 'expo-crypto';
import type {
  AnalyticsOverview, AuthProvider, Booking, BookingAvailability, BookingListItem, BookingQuote, CatalogSection, CatalogVariant, CenterRole, CenterSettings, Customer, CustomerProfile, EstimateLineInput, EstimateVersion, IntakeFinding, LoginRequest, LoginStatus, ManagedCatalog, ManagedCatalogItem,
  OrderDocument, OrderDocumentContent, OrderDocumentType, OrderListItem, OrderRecommendation, Permission, PhotoAsset, QuoteSelection, ServiceCatalog, SessionContext, SimpleServiceInput, TeamMember, Vehicle, WorkOrder
} from '@df/types';
import { ApiRequestError } from '@df/apiError';
import { localAvailability, localBooking, localCreateCustomer, localCreateVehicle, localQuote, localSearchCustomers, localSearchVehicles, localServicesCatalog, type BookingPack } from '@df/offline/bookingLocal';
import { localAddPhoto, localAssignMaster, localCloseOrder, localCompleteWork, localCreateEstimate, localCreateOrder, localDecideEstimate, localSaveIntake, localSetPause, localStartWork, localUpdateOperation } from '@df/offline/orderLocal';
import { cachedPaths, configureSync, enqueue, flush, hasPending, markReachable, pendingBusy, readCache, tokenScope, writeCache } from '@df/offline/sync';
import { isSlotAvailable } from '@df/shared/bookingRules';
import { buildDocumentContent, validSignature, type DocumentParties } from '@df/shared/orderDocuments';
import './offline-store';

/** An answer from the server with an error: the message is the server's own, ready for the user. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly details: Record<string, unknown>) {
    super(message);
  }
}

/** The server could not be reached at all. */
export class NetworkError extends Error {
  constructor() {
    super('Нет связи с сервером. Проверьте интернет или Wi-Fi центра.');
    this.name = 'NetworkError';
  }
}

/** A refusal from the server or from the same rules applied on the phone (offline): both are shown as is. */
export const isRefusal = (error: unknown) => error instanceof ApiError || error instanceof ApiRequestError;

/** The public DetailFlow server: offered on first launch. */
export const DEFAULT_SERVER = 'detailflow.ru';

/**
 * "detailflow.ru" → "https://detailflow.ru"; a center's own machine ("192.168.1.60:4173", "localhost",
 * any address with a port) → "http://…". No trailing slash.
 */
export function normalizeServerUrl(input: string) {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const local = /^(\d{1,3}\.){3}\d{1,3}(:\d+)?$/.test(trimmed) || /^localhost(:\d+)?$/i.test(trimmed) || /:\d+$/.test(trimmed);
  return `${local ? 'http' : 'https'}://${trimmed}`;
}

/** True when a DetailFlow server answers at this address. */
export async function probeServer(url: string) {
  // An address that swallows packets would otherwise keep the button spinning forever.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${url}/api/ready`, { headers: { accept: 'application/json' }, signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

type RequestInit = { method?: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal };

const ORDERS_LIST = '/api/orders?limit=50';
const PACK_PATH = '/api/offline/booking-pack';
const MASTERS = '/api/tenants/current/masters';
const BOOKING_LISTS = '/api/bookings?';
const nowIso = () => new Date().toISOString();
// Live answers that must never come from the phone's copy.
const cacheable = (path: string) => !path.startsWith('/api/auth/login-requests') && path !== '/api/ready';
/** "/api/orders/<id>" → "order:<id>", "/api/bookings/<id>" → "booking:<id>". */
const entityOf = (path: string) => {
  const match = /^\/api\/(order|booking)s\/([^/?]+)$/.exec(path);
  return match && !['availability', 'quote-preview'].includes(match[2]) ? `${match[1]}:${match[2]}` : null;
};
const orderUrl = (orderId: string, suffix = '') => `/api/orders/${encodeURIComponent(orderId)}${suffix}`;
const prefetched = new Map<string, number>();
let packLoadedAt = 0;

/**
 * The client of one server and one session. As in the web app it works without the server:
 * answers are kept on the phone (SQLite), and order and booking changes made offline are applied
 * to that copy by the same rules as on the server and queued; the queue is sent in order later.
 */
export function createApi(base: string, token: string | null, onUnauthorized: () => void) {
  const send = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    signal: init.signal,
    headers: {
      accept: 'application/json',
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers
    },
    body: init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body)
  });

  if (base && token) configureSync({
    scope: () => tokenScope(`${base}|${token}`),
    send: (item) => send(item.path, { method: item.method, body: item.body ?? undefined, headers: { 'idempotency-key': item.key } })
  });

  async function request<T>(path: string, init: RequestInit = {}, options: { offlineCopy?: boolean } = {}): Promise<T> {
    const method = init.method ?? 'GET';
    // An order or booking with unsent changes is shown from the phone's copy until the queue is sent.
    const pendingEntity = method === 'GET' ? entityOf(path) : null;
    if (pendingEntity && await hasPending(pendingEntity)) {
      const local = await readCache<T>(path);
      if (local !== undefined) { void flush(); return local; }
    }
    let response: Response;
    try {
      response = await send(path, init);
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error;
      markReachable(false);
      if (method === 'GET' && cacheable(path) && options.offlineCopy !== false) {
        const cached = await readCache<T>(path);
        if (cached !== undefined) return cached;
      }
      throw new NetworkError();
    }
    // A success whose body cannot be read (the connection dropped mid-answer) is a failed request,
    // never an empty result: a screen would otherwise take `{}` for an order or a list.
    const payload = await response.json().catch(() => {
      if (response.ok) throw new NetworkError();
      return {};
    });
    markReachable(true);
    if (response.ok && method === 'GET' && cacheable(path)) void writeCache(path, payload);
    if (response.status === 401 && !path.startsWith('/api/auth/')) onUnauthorized();
    if (!response.ok) {
      throw new ApiError(payload.error?.message ?? 'Не удалось выполнить запрос', response.status, payload.error?.code ?? 'request_failed', payload.error?.details ?? {});
    }
    return payload as T;
  }

  /**
   * An order change that also works without the server: sent directly when possible, otherwise
   * applied to the phone's copy of the order and queued. Once anything waits, every next change waits too.
   */
  async function orderChange<T>(orderId: string, label: string, method: string, path: string, body: unknown,
    local: (order: WorkOrder) => { order: WorkOrder; result: T }): Promise<T> {
    const key = randomUUID();
    const init = { method, body: JSON.stringify(body), headers: { 'idempotency-key': key } };
    if (!(await hasPending())) {
      try {
        const result = await request<T>(path, init);
        if (result && typeof result === 'object' && 'estimateVersions' in result) await writeCache(orderUrl(orderId), result);
        return result;
      } catch (error) {
        if (!(error instanceof NetworkError)) throw error;
      }
    }
    const cached = await readCache<WorkOrder>(orderUrl(orderId));
    if (!cached) throw new Error('Заказ не сохранён на телефоне. Откройте его, когда будет связь с сервером');
    const { order, result } = local(cached);
    await writeCache(orderUrl(orderId), order);
    const list = await readCache<{ items: OrderListItem[] }>(ORDERS_LIST);
    if (list) await writeCache(ORDERS_LIST, { ...list, items: list.items.map((item) => item.id === orderId ? { ...item, status: order.status } : item) });
    await enqueue({ method, path, body: init.body, key, label, entity: `order:${orderId}` });
    return result;
  }
  const whole = (apply: (order: WorkOrder) => WorkOrder) => (order: WorkOrder) => { const next = apply(order); return { order: next, result: next }; };

  // ---- Keeping what is needed offline ----

  /** Unfinished orders (and their bookings) are kept on the phone so work goes on without the server. */
  async function prefetchOrders(items: OrderListItem[]) {
    const due = items.filter((item) => item.status !== 'CLOSED' && Date.now() - (prefetched.get(item.id) ?? 0) > 120_000).slice(0, 30);
    for (const item of due) {
      if (await hasPending(`order:${item.id}`)) continue;
      prefetched.set(item.id, Date.now());
      try {
        const order = await request<WorkOrder>(orderUrl(item.id));
        if (order.bookingId) await request<Booking>(`/api/bookings/${encodeURIComponent(order.bookingId)}`);
      } catch { return; }
    }
  }
  /** Bookings of today and tomorrow are kept whole, so an intake can start from them offline. */
  async function prefetchBookings(items: BookingListItem[]) {
    const until = Date.now() + 2 * 24 * 60 * 60 * 1000;
    const due = items.filter((item) => item.status === 'CONFIRMED' && Date.parse(item.startAt) < until && Date.now() - (prefetched.get(item.id) ?? 0) > 120_000).slice(0, 20);
    for (const item of due) {
      if (await hasPending(`booking:${item.id}`)) continue;
      prefetched.set(item.id, Date.now());
      try { await request<Booking>(`/api/bookings/${encodeURIComponent(item.id)}`); } catch { return; }
    }
  }
  /** Schedule, prices, busy time and customers: what booking without the server is computed from. */
  async function refreshBookingPack(force = false) {
    if (!force && Date.now() - packLoadedAt < 60_000) return;
    packLoadedAt = Date.now();
    try { await request<BookingPack>(PACK_PATH); } catch { /* offline: the saved pack stays */ }
  }
  async function offlinePack() {
    const pack = await readCache<BookingPack>(PACK_PATH);
    if (!pack) throw new NetworkError();
    return pack;
  }
  /** The server answer when it can be reached, otherwise the same computation on the saved pack. */
  async function withPack<T>(online: () => Promise<T>, local: (pack: BookingPack) => T): Promise<T> {
    try { return await online(); }
    catch (error) {
      if (!(error instanceof NetworkError)) throw error;
      return local(await offlinePack());
    }
  }
  async function busyWithLocal(pack: BookingPack) {
    const local = await pendingBusy();
    return [...pack.busy.filter((item) => !local.some((entry) => entry.id === item.id)), ...local.filter((entry) => !entry.free)];
  }
  /** Puts a booking made or moved on this phone into the saved booking lists it belongs to. */
  async function upsertBookingInLists(item: BookingListItem) {
    const today = nowIso().slice(0, 10);
    const day = item.startAt.slice(0, 10);
    for (const path of await cachedPaths(BOOKING_LISTS)) {
      const list = await readCache<{ items: BookingListItem[] }>(path);
      if (!list) continue;
      const params = new URLSearchParams(path.slice(BOOKING_LISTS.length));
      const from = params.get('from');
      const fits = params.get('view') === 'upcoming' ? day >= today : from ? day >= from && day <= (params.get('to') ?? from) : false;
      const items = list.items.filter((entry) => entry.id !== item.id);
      if (fits) items.push(item);
      if (params.get('view') !== 'overdue') items.sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt));
      await writeCache(path, { ...list, items });
    }
  }
  async function findBookingListItem(bookingId: string) {
    for (const path of await cachedPaths(BOOKING_LISTS)) {
      const found = (await readCache<{ items: BookingListItem[] }>(path))?.items.find((item) => item.id === bookingId);
      if (found) return found;
    }
    return null;
  }
  /** Center, customer and car for an act built on the phone: from the saved session, orders list and pack. */
  async function localParties(order: WorkOrder): Promise<DocumentParties | null> {
    const session = await readCache<SessionContext>('/api/session');
    const listed = (await readCache<{ items: OrderListItem[] }>(ORDERS_LIST))?.items.find((item) => item.id === order.id);
    const pack = await readCache<BookingPack>(PACK_PATH);
    const customer = listed?.customer ?? pack?.customers.find((item) => item.id === order.customerId);
    const vehicle = listed?.vehicle ?? pack?.customers.flatMap((item) => item.vehicles).find((item) => item.id === order.vehicleId);
    if (!session || !customer || !vehicle) return null;
    return {
      centerName: session.tenant.name,
      customer: { name: customer.name, phoneDisplay: customer.phoneDisplay },
      vehicle: { make: vehicle.make, model: vehicle.model, generation: vehicle.generation, plate: vehicle.plate, color: vehicle.color }
    };
  }
  async function localDocumentContent(orderId: string, type: OrderDocumentType) {
    const order = await readCache<WorkOrder>(orderUrl(orderId));
    const parties = order && await localParties(order);
    if (!order || !parties) throw new NetworkError();
    const built = buildDocumentContent(order, parties, type);
    if (built.kind !== 'built') throw new ApiRequestError(built.message, 409, built.code);
    return { order, content: built.content as OrderDocumentContent };
  }

  return {
    authProviders: (signal?: AbortSignal) => request<{ items: AuthProvider[]; demo: boolean }>('/api/auth/providers', { signal }),
    createLoginRequest: (provider: AuthProvider['provider'], purpose: 'login' | 'signup' = 'login') =>
      request<LoginRequest>('/api/auth/login-requests', { method: 'POST', body: { provider, purpose } }),
    /** A confirmed sign-up request becomes a new center; the answer is the owner's session. */
    createCenter: (login: LoginRequest, input: { centerName: string; ownerName: string }) =>
      request<{ token: string; expiresAt: string; tenant: { id: string; name: string } }>(`/api/auth/login-requests/${encodeURIComponent(login.id)}/center`, {
        method: 'POST', headers: { 'x-login-secret': login.pollSecret }, body: input
      }),
    loginStatus: (login: LoginRequest, signal?: AbortSignal) =>
      request<LoginStatus>(`/api/auth/login-requests/${encodeURIComponent(login.id)}`, { signal, headers: { 'x-login-secret': login.pollSecret } }),
    openSession: (login: LoginRequest, tenantId?: string) =>
      request<{ token: string; expiresAt: string; tenant: { id: string; name: string } }>(`/api/auth/login-requests/${encodeURIComponent(login.id)}/session`, {
        method: 'POST', headers: { 'x-login-secret': login.pollSecret }, body: tenantId ? { tenantId } : {}
      }),
    session: (signal?: AbortSignal) => request<SessionContext>('/api/session', { signal }),
    logout: () => request<{ revoked: boolean }>('/api/auth/logout', { method: 'POST', body: {} }),
    deleteAccount: () => request<{ deleted: true }>('/api/me', { method: 'DELETE' }),

    // ---- Orders ----
    listOrders: async (signal?: AbortSignal) => {
      const result = await request<{ items: OrderListItem[] }>(ORDERS_LIST, { signal });
      void prefetchOrders(result.items);
      void refreshBookingPack();
      void request(MASTERS).catch(() => {});
      return result;
    },
    getOrder: (orderId: string, signal?: AbortSignal) => request<WorkOrder>(orderUrl(orderId), { signal }),
    listMasters: (signal?: AbortSignal) => request<{ items: { id: string; displayName: string; activeOrders: number }[] }>(MASTERS, { signal }),
    assignMaster: async (orderId: string, memberId: string) => {
      const masters = (await readCache<{ items: { id: string; displayName: string }[] }>(MASTERS))?.items ?? [];
      return orderChange(orderId, 'Назначение мастера', 'PUT', orderUrl(orderId, '/assignment'), { memberId }, (order) => {
        const master = masters.find((item) => item.id === memberId);
        if (!master) throw new ApiRequestError('Список мастеров не сохранён на телефоне. Назначьте мастера, когда будет связь', 422, 'not_a_master');
        const next = localAssignMaster(order, master, nowIso());
        return { order: next, result: next };
      });
    },
    startWork: (orderId: string) => orderChange(orderId, 'Начало работ', 'POST', orderUrl(orderId, '/work/start'), {}, whole((order) => localStartWork(order, nowIso()))),
    updateOperation: (orderId: string, operationId: string, status: 'PENDING' | 'DONE' | 'BLOCKED', note = '') =>
      orderChange(orderId, status === 'DONE' ? 'Операция выполнена' : 'Отметка операции', 'PATCH', orderUrl(orderId, `/work/operations/${encodeURIComponent(operationId)}`),
        { status, note }, whole((order) => localUpdateOperation(order, operationId, status, note, nowIso()))),
    pauseWork: (orderId: string, note: string) => orderChange(orderId, 'Пауза работ', 'POST', orderUrl(orderId, '/work/pause'), { note }, whole((order) => localSetPause(order, true, note, nowIso()))),
    resumeWork: (orderId: string) => orderChange(orderId, 'Возобновление работ', 'POST', orderUrl(orderId, '/work/resume'), {}, whole((order) => localSetPause(order, false, '', nowIso()))),
    completeWork: (orderId: string) => orderChange(orderId, 'Завершение работ', 'POST', orderUrl(orderId, '/work/complete'), {}, whole((order) => localCompleteWork(order, nowIso()))),
    saveIntake: (orderId: string, input: { conditionSummary: string; findings: IntakeFinding[]; recommendations: OrderRecommendation[]; bodyType: string }) =>
      orderChange(orderId, 'Приёмка автомобиля', 'PUT', orderUrl(orderId, '/intake'), input, whole((order) => localSaveIntake(order, input, nowIso(), randomUUID))),
    addPhoto: (orderId: string, input: { phase: 'intake' | 'result'; kind: 'intake' | 'defect'; zone: string; dataUrl: string }) =>
      orderChange<PhotoAsset>(orderId, input.phase === 'result' ? 'Фото результата' : 'Фото приёмки', 'POST', orderUrl(orderId, '/photos'), input,
        (order) => { const local = localAddPhoto(order, input, nowIso(), randomUUID); return { order: local.order, result: local.photo }; }),
    createEstimate: async (orderId: string, lines: EstimateLineInput[]) => {
      // Ids come from the phone so an approval and work started offline can refer to this version.
      const id = `estimate_${randomUUID()}`;
      const withIds = lines.map((line) => ({ ...line, id: `estimate_line_${randomUUID()}` }));
      const estimate = await orderChange<EstimateVersion>(orderId, 'Смета', 'POST', orderUrl(orderId, '/estimates'), { id, lines: withIds }, (order) => {
        const local = localCreateEstimate(order, withIds, id, nowIso());
        return { order: local.order, result: local.estimate };
      });
      // Sent directly, the answer is the estimate only: keep the phone's copy of the order in step.
      const cached = await readCache<WorkOrder>(orderUrl(orderId));
      if (cached && !cached.estimateVersions.some((item) => item.id === estimate.id)) {
        await writeCache(orderUrl(orderId), { ...cached, status: 'ESTIMATE_DRAFT', currentEstimateVersionId: estimate.id, estimateVersions: [...cached.estimateVersions, estimate] });
      }
      return estimate;
    },
    decideEstimate: (orderId: string, input: { estimateVersionId: string; decision: 'APPROVED' | 'REJECTED'; method: 'in_person' | 'phone' | 'messenger'; responsible: string }) => {
      const full = { ...input, source: 'native_app' };
      return orderChange(orderId, input.decision === 'APPROVED' ? 'Согласование сметы' : 'Отказ от сметы', 'POST', orderUrl(orderId, '/estimate-approvals'), full,
        whole((order) => localDecideEstimate(order, full, nowIso())));
    },
    closeOrder: (orderId: string, input: { responsible: string; note: string; customerAccepted: boolean; completenessChecked: boolean }) =>
      orderChange(orderId, 'Выдача автомобиля', 'POST', orderUrl(orderId, '/handover'), input, whole((order) => localCloseOrder(order, input, nowIso()))),
    /** Starts intake: the order of a booking (the server returns the existing one on a repeat); offline it is made on the phone. */
    createOrder: async (bookingId: string) => {
      const id = `order_${randomUUID()}`;
      const key = randomUUID();
      const body = JSON.stringify({ bookingId, id });
      if (!(await hasPending())) {
        try {
          const order = await request<WorkOrder>('/api/orders', { method: 'POST', body, headers: { 'idempotency-key': key } });
          await writeCache(orderUrl(order.id), order);
          return order;
        } catch (error) {
          if (!(error instanceof NetworkError)) throw error;
        }
      }
      const listed = await findBookingListItem(bookingId);
      const booking = await readCache<Booking>(`/api/bookings/${encodeURIComponent(bookingId)}`);
      const source = booking ?? (listed && { id: listed.id, customerId: listed.customer.id, vehicleId: listed.vehicle.id, status: listed.status });
      if (!source) throw new NetworkError();
      if (listed?.orderId) {
        const existing = await readCache<WorkOrder>(orderUrl(listed.orderId));
        if (existing) return existing;
      }
      const order = localCreateOrder(source, id, nowIso());
      await writeCache(orderUrl(id), order);
      if (listed) {
        await upsertBookingInLists({ ...listed, orderId: id });
        const list = await readCache<{ items: OrderListItem[] }>(ORDERS_LIST);
        if (list) await writeCache(ORDERS_LIST, { ...list, items: [{ id, status: order.status, createdAt: order.createdAt, totalAmountMinor: null, masterName: null, masterMemberId: null, customer: listed.customer, vehicle: listed.vehicle }, ...list.items] });
      }
      await enqueue({ method: 'POST', path: '/api/orders', body, key, label: `Начало приёмки${listed ? ` · ${listed.customer.name}` : ''}`, entity: `order:${id}`, dependsOn: [`booking:${bookingId}`] });
      return order;
    },

    // ---- Documents ----
    previewDocument: async (orderId: string, type: OrderDocumentType, signal?: AbortSignal) => {
      // Unsent changes of the order are on the phone only: the preview is built here from them.
      if (!(await hasPending(`order:${orderId}`))) {
        try {
          return await request<{ type: OrderDocumentType; content: OrderDocumentContent }>(orderUrl(orderId, `/documents/preview?type=${type}`), { signal }, { offlineCopy: false });
        } catch (error) {
          if (!(error instanceof NetworkError)) throw error;
        }
      }
      return { type, content: (await localDocumentContent(orderId, type)).content };
    },
    getDocument: async (orderId: string, documentId: string, signal?: AbortSignal) => {
      const path = orderUrl(orderId, `/documents/${encodeURIComponent(documentId)}`);
      // An act issued offline exists only on the phone until the queue reaches the server.
      if (documentId.startsWith('doc_local_')) {
        const local = await readCache<OrderDocument>(path);
        if (local) return local;
      }
      return request<OrderDocument>(path, { signal });
    },
    issueDocument: async (orderId: string, input: { type: OrderDocumentType; signerName?: string; signatureDataUrl?: string }) => {
      const path = orderUrl(orderId, '/documents');
      const key = randomUUID();
      if (!(await hasPending())) {
        try {
          return await request<OrderDocument>(path, { method: 'POST', body: input, headers: { 'idempotency-key': key } });
        } catch (error) {
          if (!(error instanceof NetworkError)) throw error;
        }
      }
      // Offline: the act and the signature stay on the phone; the server numbers the act when it gets it.
      const signed = Boolean(input.signatureDataUrl);
      if (signed && !validSignature(input.signerName ?? '', input.signatureDataUrl!)) throw new ApiRequestError('Проверьте ФИО и подпись', 422, 'validation_error');
      const { order, content } = await localDocumentContent(orderId, input.type);
      const now = nowIso();
      const document: OrderDocument = {
        id: `doc_local_${randomUUID()}`, type: input.type, number: 'присвоится при отправке', signed,
        signerName: signed ? input.signerName!.trim() : null, signedAt: signed ? now : null, actorName: null, createdAt: now,
        current: true, outdated: false, content, signatureDataUrl: signed ? input.signatureDataUrl! : null
      };
      const { content: _content, signatureDataUrl: _signature, ...summary } = document;
      await writeCache(`${path}/${document.id}`, document);
      await writeCache(orderUrl(orderId), { ...order, documents: [summary, ...order.documents.map((item) => item.type === input.type ? { ...item, current: false } : item)] });
      await enqueue({ method: 'POST', path, body: JSON.stringify(input), key, label: input.type === 'intake_act' ? 'Акт приёмки' : 'Акт выдачи', entity: `order:${orderId}` });
      return document;
    },

    // ---- Statistics and management (online only) ----
    analytics: (from: string, to: string, signal?: AbortSignal) =>
      request<AnalyticsOverview>(`/api/analytics/overview?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { signal }),
    catalog: (signal?: AbortSignal) => request<ManagedCatalog>('/api/tenants/current/catalog', { signal }),
    createSection: (name: string) => request<CatalogSection>('/api/tenants/current/catalog/sections', { method: 'POST', body: { name } }),
    createSimpleService: (input: SimpleServiceInput) => request<ManagedCatalogItem>('/api/tenants/current/catalog/simple-services', { method: 'POST', body: input }),
    updateSimpleService: (serviceId: string, input: SimpleServiceInput & { active: boolean }) =>
      request<ManagedCatalogItem>(`/api/tenants/current/catalog/simple-services/${encodeURIComponent(serviceId)}`, { method: 'PUT', body: input }),
    settings: (signal?: AbortSignal) => request<CenterSettings>('/api/tenants/current/settings', { signal }),
    centerSetup: (signal?: AbortSignal) => request<{ services: number; members: number; bookings: number }>('/api/tenants/current/setup', { signal }),
    updateSettings: (input: Omit<CenterSettings, 'timezone'>) => request<CenterSettings>('/api/tenants/current/settings', { method: 'PATCH', body: input }),
    team: (signal?: AbortSignal) => request<{ items: TeamMember[] }>('/api/tenants/current/team', { signal }),
    createMember: (input: { displayName: string; roles: string[] }) =>
      request<{ member: TeamMember; accessToken: string }>('/api/tenants/current/team', { method: 'POST', body: input }),
    updateMember: (memberId: string, input: { roles?: string[]; status?: TeamMember['status'] }) =>
      request<TeamMember>(`/api/tenants/current/team/${encodeURIComponent(memberId)}`, { method: 'PATCH', body: input }),
    messengerInvite: (memberId: string, provider: AuthProvider['provider']) =>
      request<{ code: string; provider: AuthProvider['provider']; expiresAt: string; botName: string | null; deepLink: string | null }>(
        `/api/tenants/current/team/${encodeURIComponent(memberId)}/messenger-invites`, { method: 'POST', body: { provider } }),
    removeMessengerLink: (memberId: string, linkId: string) =>
      request<{ removed: boolean }>(`/api/tenants/current/team/${encodeURIComponent(memberId)}/messenger-links/${encodeURIComponent(linkId)}`, { method: 'DELETE' }),
    roles: (signal?: AbortSignal) => request<{ permissions: Permission[]; items: CenterRole[] }>('/api/tenants/current/roles?includeArchived=true', { signal }),
    createRole: (input: { name: string; permissions: string[] }) => request<CenterRole>('/api/tenants/current/roles', { method: 'POST', body: input }),
    updateRole: (key: string, input: { name?: string; permissions?: string[] }) =>
      request<CenterRole>(`/api/tenants/current/roles/${encodeURIComponent(key)}`, { method: 'PATCH', body: input }),
    setRoleArchived: (key: string, archived: boolean) =>
      request<CenterRole>(`/api/tenants/current/roles/${encodeURIComponent(key)}/${archived ? 'archive' : 'restore'}`, { method: 'POST', body: {} }),

    // ---- Bookings and customers ----
    listBookings: async (view: 'upcoming' | 'overdue', signal?: AbortSignal) => {
      const result = await request<{ items: BookingListItem[] }>(`/api/bookings?view=${view}&limit=50`, { signal });
      if (view === 'upcoming') { void prefetchBookings(result.items); void refreshBookingPack(); }
      return result;
    },
    bookingCalendar: (from: string, to: string, signal?: AbortSignal) =>
      request<{ items: BookingListItem[] }>(`/api/bookings?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=50`, { signal }),
    getBooking: (bookingId: string, signal?: AbortSignal) => request<Booking>(`/api/bookings/${encodeURIComponent(bookingId)}`, { signal }),
    updateBooking: async (bookingId: string, input: { startAt: string } | { status: 'CANCELLED' | 'NO_SHOW' }) => {
      const path = `/api/bookings/${encodeURIComponent(bookingId)}`;
      const key = randomUUID();
      const body = JSON.stringify(input);
      if (!(await hasPending())) {
        try { return await request<Booking>(path, { method: 'PATCH', body, headers: { 'idempotency-key': key } }); }
        catch (error) { if (!(error instanceof NetworkError)) throw error; }
      }
      const booking = await readCache<Booking>(path);
      if (!booking) throw new NetworkError();
      if (booking.status !== 'CONFIRMED') throw new ApiRequestError('Изменить можно только подтверждённую запись', 409, 'invalid_booking_state');
      const listed = await findBookingListItem(bookingId);
      if (listed?.orderId) throw new ApiRequestError('По записи уже создан заказ', 409, 'booking_has_order');
      if ('status' in input) {
        // Cancelling or a no-show frees the time at once on this phone.
        if (input.status === 'NO_SHOW' && Date.parse(booking.startAt) > Date.now()) throw new ApiRequestError('Отметить неявку можно после времени начала записи', 409, 'booking_not_started');
        const changed: Booking = { ...booking, status: input.status, slotConflict: false, pendingSync: true };
        await writeCache(path, changed);
        if (listed) await upsertBookingInLists({ ...listed, status: input.status, slotConflict: false, pendingSync: true });
        await enqueue({ method: 'PATCH', path, body, key, label: `${input.status === 'CANCELLED' ? 'Отмена' : 'Неявка'}${listed ? ` · ${listed.customer.name}` : ''}`,
          entity: `booking:${bookingId}`, busy: { id: bookingId, startAt: booking.startAt, durationMinutes: booking.estimatedDurationMinutes, free: true } });
        return changed;
      }
      const pack = await offlinePack();
      if (!isSlotAvailable(pack.schedule, await busyWithLocal(pack), input.startAt, booking.estimatedDurationMinutes, bookingId)) throw new ApiRequestError('Это время уже занято', 409, 'slot_unavailable');
      const moved: Booking = { ...booking, startAt: input.startAt, pendingSync: true };
      await writeCache(path, moved);
      if (listed) await upsertBookingInLists({ ...listed, startAt: input.startAt, pendingSync: true });
      await enqueue({ method: 'PATCH', path, body, key, label: `Перенос записи${listed ? ` · ${listed.customer.name}` : ''}`, entity: `booking:${bookingId}`,
        busy: { id: bookingId, startAt: input.startAt, durationMinutes: booking.estimatedDurationMinutes } });
      return moved;
    },
    availability: async (date: string, durationMinutes: number, excludeBookingId?: string, signal?: AbortSignal) => {
      // Bookings made here and not yet sent are unknown to the server: count them on the phone.
      if (!(await pendingBusy()).length) {
        try {
          return await request<BookingAvailability>(`/api/bookings/availability?date=${encodeURIComponent(date)}&durationMinutes=${durationMinutes}${excludeBookingId ? `&excludeBookingId=${encodeURIComponent(excludeBookingId)}` : ''}`,
            { signal }, { offlineCopy: false });
        } catch (error) {
          if (!(error instanceof NetworkError)) throw error;
        }
      }
      const pack = await offlinePack();
      return localAvailability(pack, await pendingBusy(), date, durationMinutes, excludeBookingId ?? null);
    },
    createBooking: async (input: { customerId: string; vehicleId: string; channel: string; startAt: string; selections: QuoteSelection[] }, idempotencyKey: string) => {
      if (!(await hasPending())) {
        try {
          const booking = await request<Booking>('/api/bookings', { method: 'POST', body: input, headers: { 'idempotency-key': idempotencyKey } });
          void refreshBookingPack(true);
          return booking;
        } catch (error) {
          if (!(error instanceof NetworkError)) throw error;
        }
      }
      // Offline: the phone picks the id, checks the time like the server and queues the booking.
      // If the time is taken on the server meanwhile, it is kept there with a conflict mark.
      const pack = await offlinePack();
      const quote = localQuote(pack, input.vehicleId, input.selections);
      if (!isSlotAvailable(pack.schedule, await busyWithLocal(pack), input.startAt, quote.totalDurationMinutes)) throw new ApiRequestError('Это время уже занято', 409, 'slot_unavailable');
      const id = `booking_${randomUUID()}`;
      const booking: Booking = { ...localBooking(id, input, quote, pack, nowIso()), pendingSync: true };
      await writeCache(`/api/bookings/${id}`, booking);
      const customer = pack.customers.find((item) => item.id === input.customerId);
      const vehicle = customer?.vehicles.find((item) => item.id === input.vehicleId);
      if (customer && vehicle) await upsertBookingInLists({
        id, channel: input.channel, startAt: input.startAt, estimatedDurationMinutes: quote.totalDurationMinutes, status: 'CONFIRMED',
        preliminaryAmountMinor: quote.totalAmountMinor, orderId: null, pendingSync: true,
        customer: { id: customer.id, name: customer.name, phoneDisplay: customer.phoneDisplay },
        vehicle: { id: vehicle.id, make: vehicle.make, model: vehicle.model, generation: vehicle.generation, plate: vehicle.plate, color: vehicle.color, bodyType: vehicle.bodyType }
      });
      await enqueue({ method: 'POST', path: '/api/bookings', body: JSON.stringify({ ...input, id, allowSlotConflict: true }), key: idempotencyKey,
        label: `Новая запись${customer ? ` · ${customer.name}` : ''}`, entity: `booking:${id}`,
        dependsOn: [`customer:${input.customerId}`, `vehicle:${input.vehicleId}`], busy: { id, startAt: input.startAt, durationMinutes: quote.totalDurationMinutes } });
      return booking;
    },
    // Archived matches are returned too, so a returning customer is brought back instead of duplicated.
    searchCustomers: (phone: string, signal?: AbortSignal) => withPack(
      () => request<{ items: Customer[] }>(`/api/customers?phone=${encodeURIComponent(phone)}&includeArchived=true`, { signal }, { offlineCopy: false }),
      (pack) => ({ items: localSearchCustomers(pack, phone) })),
    searchVehicles: (plate: string, signal?: AbortSignal) => withPack(
      () => request<{ items: (Vehicle & { customer: Pick<Customer, 'id' | 'name' | 'phoneDisplay'> | null })[] }>(`/api/vehicles?plate=${encodeURIComponent(plate)}`, { signal }, { offlineCopy: false }),
      (pack) => ({ items: localSearchVehicles(pack, plate) })),
    createCustomer: async (input: { name: string; phone: string }) => {
      if (!(await hasPending())) {
        try {
          const customer = await request<Customer>('/api/customers', { method: 'POST', body: input });
          void refreshBookingPack(true);
          return customer;
        } catch (error) {
          if (!(error instanceof NetworkError)) throw error;
        }
      }
      // Offline: checked against the saved customers; on the server the phone is checked again and a
      // match asks "same customer?" instead of duplicating. Customers are never merged.
      const id = `cust_${randomUUID()}`;
      const { pack, customer } = localCreateCustomer(await offlinePack(), input, id);
      await writeCache(PACK_PATH, pack);
      await enqueue({ method: 'POST', path: '/api/customers', body: JSON.stringify({ ...input, id, checkDuplicatePhone: true }), key: randomUUID(),
        label: `Новый клиент · ${customer.name}`, entity: `customer:${id}` });
      return customer;
    },
    customerProfile: (customerId: string, signal?: AbortSignal) => request<CustomerProfile>(`/api/customers/${encodeURIComponent(customerId)}/profile`, { signal }),
    searchCatalog: (query: string, signal?: AbortSignal) => request<{ items: CatalogVariant[] }>(`/api/vehicle-catalog/variants?q=${encodeURIComponent(query)}`, { signal }),
    vehicleClasses: (signal?: AbortSignal) => withPack(
      () => request<{ items: string[] }>('/api/tenants/current/vehicle-classes', { signal }, { offlineCopy: false }),
      (pack) => ({ items: [...new Set(pack.classRules.map((rule) => rule.tenantClass))].sort() })),
    createVehicle: async (input: { customerId: string; catalogVariantId?: string; manual?: { make: string; model: string; generation?: string; bodyType: string }; tenantClass?: string; plateDisplay: string; color: string },
      variant: CatalogVariant | null = null) => {
      if (!(await hasPending())) {
        try {
          const result = await request<{ vehicle: Vehicle }>('/api/vehicles', { method: 'POST', body: input });
          void refreshBookingPack(true);
          return result;
        } catch (error) {
          if (!(error instanceof NetworkError)) throw error;
        }
      }
      const id = `veh_${randomUUID()}`;
      const { pack, vehicle } = localCreateVehicle(await offlinePack(), input, variant, id);
      await writeCache(PACK_PATH, pack);
      await enqueue({ method: 'POST', path: '/api/vehicles', body: JSON.stringify({ ...input, id }), key: randomUUID(),
        label: `Новый автомобиль · ${vehicle.plate}`, entity: `vehicle:${id}`, dependsOn: [`customer:${input.customerId}`] });
      return { vehicle };
    },
    services: (vehicleId: string, signal?: AbortSignal) => withPack(
      () => request<ServiceCatalog>(`/api/tenants/current/services?vehicleId=${encodeURIComponent(vehicleId)}`, { signal }, { offlineCopy: false }),
      (pack) => localServicesCatalog(pack, vehicleId)),
    previewQuote: (vehicleId: string, selections: QuoteSelection[], signal?: AbortSignal) => withPack(
      () => request<BookingQuote>('/api/bookings/quote-preview', { method: 'POST', body: { vehicleId, selections }, signal }),
      (pack) => localQuote(pack, vehicleId, selections))
  };
}

export type Api = ReturnType<typeof createApi>;
