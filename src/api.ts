import type { AuthProvider, CatalogOperation, LoginRequest, LoginStatus, MessengerProvider } from './types';
import type { AnalyticsOverview, Booking, BookingAvailability, BookingListItem, BookingQuote, CatalogSection, CatalogVariant, CenterRole, CenterSettings, Customer, CustomerProfile, EstimateLineInput, EstimateVersion, IntakeFinding, OrderDocument, OrderDocumentContent, OrderDocumentType, Lead, LeadStatus, ManagedCatalog, ManagedCatalogItem, OrderListItem, OrderRecommendation, Permission, PhotoAsset, QuoteSelection, ServiceCatalog, SessionContext, SimpleServiceInput, TeamMember, TeamRole, Vehicle, VehicleProfile, WorkOrder } from './types';

import { ApiRequestError } from './apiError';
import { localAddPhoto, localCompleteWork, localSaveIntake, localSetPause, localStartWork, localUpdateOperation } from './offline/orderLocal';
import { configureSync, enqueue, flush, hasPending, markReachable, readCache, tokenScope, writeCache } from './offline/sync';
import { randomId } from './platform';

export { ApiRequestError };

const SESSION_KEY = 'detailflow.session';
const DEMO_CHOICE_KEY = 'detailflow.demo';
/** Demo tokens stay available in local builds unless VITE_DEMO_AUTH=false. */
export const demoAuthEnabled = import.meta.env.VITE_DEMO_AUTH !== 'false';

export const authSession = {
  token(): string | null {
    try { return localStorage.getItem(SESSION_KEY); } catch { return null; }
  },
  save(token: string) {
    try {
      localStorage.setItem(SESSION_KEY, token);
      sessionStorage.removeItem(DEMO_CHOICE_KEY);
    } catch { /* private mode: session lives until reload */ }
  },
  clear() {
    try {
      localStorage.removeItem(SESSION_KEY);
      sessionStorage.removeItem(DEMO_CHOICE_KEY);
    } catch { /* nothing stored */ }
  },
  /** "Continue in demo mode" is remembered for this browser tab only. */
  demoChosen() {
    try { return sessionStorage.getItem(DEMO_CHOICE_KEY) === '1'; } catch { return false; }
  },
  chooseDemo() {
    try { sessionStorage.setItem(DEMO_CHOICE_KEY, '1'); } catch { /* choice lasts until reload */ }
  }
};

function currentToken() {
  return authSession.token() ?? (demoAuthEnabled ? 'demo-session-token' : null);
}

/** The server could not be reached at all (as opposed to an answer with an error). */
export class NetworkError extends Error {
  constructor() {
    const offline = typeof navigator !== 'undefined' && !navigator.onLine;
    super(offline
      ? 'Нет подключения к интернету. Данные формы сохранены.'
      : 'Не удалось связаться с сервером. Данные формы сохранены — повторите запрос.');
    this.name = 'NetworkError';
  }
}

function send(path: string, init?: RequestInit) {
  const token = currentToken();
  return fetch(path, {
    ...init,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers
    }
  });
}

configureSync({
  scope: () => tokenScope(currentToken()),
  send: (item) => send(item.path, { method: item.method, body: item.body ?? undefined, headers: { 'idempotency-key': item.key } })
});

// Sign-in polling is live state and is never served from the offline copy.
const cacheable = (path: string) => !path.startsWith('/api/auth/login-requests');
const orderPath = (path: string) => /^\/api\/orders\/([^/?]+)$/.exec(path)?.[1] ?? null;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = init?.method ?? 'GET';
  // An order with unsent changes is shown from the phone's copy until the queue reaches the server.
  const pendingOrder = method === 'GET' ? orderPath(path) : null;
  if (pendingOrder && await hasPending(`order:${pendingOrder}`)) {
    const local = await readCache<T>(path);
    if (local !== undefined) { void flush(); return local; }
  }
  let response: Response;
  try {
    response = await send(path, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    markReachable(false);
    if (method === 'GET' && cacheable(path)) {
      const cached = await readCache<T>(path);
      if (cached !== undefined) return cached;
    }
    throw new NetworkError();
  }
  markReachable(true);
  const payload = await response.json();
  if (response.ok && method === 'GET' && cacheable(path)) void writeCache(path, payload);
  if (response.status === 401 && !path.startsWith('/api/auth/login-requests')) {
    // An expired or revoked session must lead to the sign-in screen, never silently to demo access.
    if (authSession.token()) authSession.clear();
    window.dispatchEvent(new CustomEvent('detailflow:unauthorized'));
  }
  if (!response.ok) throw new ApiRequestError(
    payload.error?.message ?? 'Не удалось выполнить запрос', response.status, payload.error?.code ?? 'request_failed', payload.error?.details ?? {}
  );
  return payload;
}

const nowIso = () => new Date().toISOString();
const ORDERS_LIST = '/api/orders?limit=20';
const prefetched = new Map<string, number>();

/**
 * Keeps unfinished orders on the phone so a master can work on them without the server.
 * Runs in the background after the list loads; each order is refreshed at most every 2 minutes.
 */
async function prefetchOrders(items: OrderListItem[]) {
  const due = items.filter((item) => item.status !== 'CLOSED' && Date.now() - (prefetched.get(item.id) ?? 0) > 120_000).slice(0, 30);
  for (const item of due) {
    if (await hasPending(`order:${item.id}`)) continue;
    prefetched.set(item.id, Date.now());
    try {
      const order = await request<WorkOrder>(`/api/orders/${encodeURIComponent(item.id)}`);
      // The order workspace opens through its booking.
      if (order.bookingId) await request<Booking>(`/api/bookings/${encodeURIComponent(order.bookingId)}`);
    } catch { return; }
  }
}

/**
 * An order change that also works without the server: sent directly when possible, otherwise
 * applied to the phone's copy of the order (same rules as the server) and queued. Queued changes
 * keep their order, so once anything is waiting every next change waits too.
 */
async function orderChange<T>(orderId: string, label: string, method: string, path: string, body: unknown,
  local: (order: WorkOrder) => { order: WorkOrder; result: T }): Promise<T> {
  const key = randomId();
  const init = { method, body: JSON.stringify(body), headers: { 'idempotency-key': key } };
  if (!(await hasPending())) {
    try {
      const result = await request<T>(path, init);
      if (result && typeof result === 'object' && 'estimateVersions' in result) await writeCache(`/api/orders/${orderId}`, result);
      return result;
    } catch (error) {
      if (!(error instanceof NetworkError)) throw error;
    }
  }
  const cached = await readCache<WorkOrder>(`/api/orders/${orderId}`);
  if (!cached) throw new Error('Заказ не сохранён на телефоне. Откройте его, когда будет связь с сервером');
  const { order, result } = local(cached);
  await writeCache(`/api/orders/${orderId}`, order);
  const list = await readCache<{ items: OrderListItem[] }>(ORDERS_LIST);
  if (list) await writeCache(ORDERS_LIST, { ...list, items: list.items.map((item) => item.id === orderId ? { ...item, status: order.status } : item) });
  await enqueue({ method, path, body: init.body, key, label, entity: `order:${orderId}` });
  return result;
}

const orderUrl = (orderId: string, suffix: string) => `/api/orders/${encodeURIComponent(orderId)}${suffix}`;

export const api = {
  getAuthProviders(signal?: AbortSignal) {
    return request<{ items: AuthProvider[]; demo: boolean }>('/api/auth/providers', { signal });
  },
  createLoginRequest(provider: MessengerProvider) {
    return request<LoginRequest>('/api/auth/login-requests', { method: 'POST', body: JSON.stringify({ provider }) });
  },
  getLoginStatus(loginId: string, pollSecret: string, signal?: AbortSignal) {
    return request<LoginStatus>(`/api/auth/login-requests/${encodeURIComponent(loginId)}`, { signal, headers: { 'x-login-secret': pollSecret } });
  },
  openSession(loginId: string, pollSecret: string, tenantId?: string) {
    return request<{ token: string; expiresAt: string; tenant: { id: string; name: string } }>(`/api/auth/login-requests/${encodeURIComponent(loginId)}/session`, {
      method: 'POST', headers: { 'x-login-secret': pollSecret }, body: JSON.stringify(tenantId ? { tenantId } : {})
    });
  },
  logout() {
    return request<{ revoked: boolean }>('/api/auth/logout', { method: 'POST', body: JSON.stringify({}) });
  },
  createMessengerInvite(memberId: string, provider: MessengerProvider) {
    return request<{ code: string; provider: MessengerProvider; expiresAt: string; botName: string | null; deepLink: string | null }>(
      `/api/tenants/current/team/${encodeURIComponent(memberId)}/messenger-invites`, { method: 'POST', body: JSON.stringify({ provider }) }
    );
  },
  removeMessengerLink(memberId: string, linkId: string) {
    return request<{ removed: boolean }>(`/api/tenants/current/team/${encodeURIComponent(memberId)}/messenger-links/${encodeURIComponent(linkId)}`, { method: 'DELETE' });
  },
  getSession(signal?: AbortSignal) {
    return request<SessionContext>('/api/session', { signal });
  },
  listBookings(signal?: AbortSignal) {
    return request<{ items: BookingListItem[] }>('/api/bookings?view=upcoming&limit=50', { signal });
  },
  /** Past confirmed bookings with no order: arrival or no-show still has to be recorded. */
  listOverdueBookings(signal?: AbortSignal) {
    return request<{ items: BookingListItem[] }>('/api/bookings?view=overdue&limit=50', { signal });
  },
  listBookingCalendar(from: string, to: string, signal?: AbortSignal) {
    return request<{ items: BookingListItem[] }>(`/api/bookings?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=50`, { signal });
  },
  listLeads(signal?: AbortSignal) {
    return request<{ items: Lead[] }>('/api/leads?limit=50', { signal });
  },
  createLead(input: { customerId?: string; channel: Lead['channel']; contactName: string; phone: string; note: string }) {
    return request<Lead>('/api/leads', { method: 'POST', body: JSON.stringify(input) });
  },
  updateLeadStatus(leadId: string, status: Extract<LeadStatus, 'CONTACTED' | 'LOST'>) {
    return request<Lead>(`/api/leads/${encodeURIComponent(leadId)}`, {
      method: 'PATCH', body: JSON.stringify({ status })
    });
  },
  async listOrders(signal?: AbortSignal) {
    const result = await request<{ items: OrderListItem[] }>(ORDERS_LIST, { signal });
    void prefetchOrders(result.items);
    return result;
  },
  getAnalyticsOverview(from: string, to: string, signal?: AbortSignal) {
    return request<AnalyticsOverview>(`/api/analytics/overview?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { signal });
  },
  getOrder(orderId: string, signal?: AbortSignal) {
    return request<WorkOrder>(`/api/orders/${encodeURIComponent(orderId)}`, { signal });
  },
  searchCustomers(phone: string, signal?: AbortSignal, includeArchived = false) {
    return request<{ items: Customer[] }>(`/api/customers?phone=${encodeURIComponent(phone)}${includeArchived ? '&includeArchived=true' : ''}`, { signal });
  },
  getCustomerProfile(customerId: string, signal?: AbortSignal) {
    return request<CustomerProfile>(`/api/customers/${encodeURIComponent(customerId)}/profile`, { signal });
  },
  updateCustomer(customerId: string, input: { name?: string; phone?: string; confirmDuplicate?: boolean }) {
    return request<CustomerProfile>(`/api/customers/${encodeURIComponent(customerId)}`, {
      method: 'PATCH', body: JSON.stringify(input)
    });
  },
  setCustomerArchived(customerId: string, archived: boolean) {
    return request<CustomerProfile>(`/api/customers/${encodeURIComponent(customerId)}/${archived ? 'archive' : 'reactivate'}`, {
      method: 'POST', body: JSON.stringify({})
    });
  },
  searchVehicles(plate: string, signal?: AbortSignal) {
    return request<{ items: Array<Vehicle & { customer: Customer | null }> }>(`/api/vehicles?plate=${encodeURIComponent(plate)}`, { signal });
  },
  searchCatalog(query: string, signal?: AbortSignal) {
    return request<{ items: CatalogVariant[] }>(`/api/vehicle-catalog/variants?q=${encodeURIComponent(query)}`, { signal });
  },
  createCustomer(input: { name: string; phone: string }) {
    return request<Customer>('/api/customers', { method: 'POST', body: JSON.stringify(input) });
  },
  createVehicle(input: {
    customerId: string;
    catalogVariantId?: string;
    manual?: { make: string; model: string; generation?: string; bodyType: string };
    tenantClass?: string;
    plateDisplay: string;
    color: string;
  }) {
    return request<{ vehicle: Vehicle }>('/api/vehicles', { method: 'POST', body: JSON.stringify(input) });
  },
  listVehicleClasses(signal?: AbortSignal) {
    return request<{ items: string[] }>('/api/tenants/current/vehicle-classes', { signal });
  },
  getVehicleProfile(vehicleId: string, signal?: AbortSignal) {
    return request<VehicleProfile>(`/api/vehicles/${encodeURIComponent(vehicleId)}/profile`, { signal });
  },
  updateVehicleStatus(vehicleId: string, status: Vehicle['status']) {
    return request<{ id: string; status: Vehicle['status']; archivedAt: string | null }>(`/api/vehicles/${encodeURIComponent(vehicleId)}`, {
      method: 'PATCH', body: JSON.stringify({ status })
    });
  },
  updateVehicleDetails(vehicleId: string, input: { bodyType: string; tenantClass: string }) {
    return request<Vehicle>(`/api/vehicles/${encodeURIComponent(vehicleId)}`, {
      method: 'PATCH', body: JSON.stringify(input)
    });
  },
  transferVehicle(vehicleId: string, customerId: string) {
    return request<VehicleProfile>(`/api/vehicles/${encodeURIComponent(vehicleId)}/transfer`, {
      method: 'POST', body: JSON.stringify({ customerId })
    });
  },
  getServices(vehicleId: string, signal?: AbortSignal) {
    return request<ServiceCatalog>(`/api/tenants/current/services?vehicleId=${encodeURIComponent(vehicleId)}`, { signal });
  },
  getManagedCatalog(signal?: AbortSignal) {
    return request<ManagedCatalog>('/api/tenants/current/catalog', { signal });
  },
  getCenterSettings(signal?: AbortSignal) {
    return request<CenterSettings>('/api/tenants/current/settings', { signal });
  },
  updateCenterSettings(input: Omit<CenterSettings, 'timezone'>) {
    return request<CenterSettings>('/api/tenants/current/settings', {
      method: 'PATCH', body: JSON.stringify(input)
    });
  },
  listTeam(signal?: AbortSignal) {
    return request<{ items: TeamMember[] }>('/api/tenants/current/team', { signal });
  },
  createTeamMember(input: { displayName: string; roles: TeamRole[] }) {
    return request<{ member: TeamMember; accessToken: string }>('/api/tenants/current/team', {
      method: 'POST', body: JSON.stringify(input)
    });
  },
  updateTeamMember(memberId: string, input: { roles?: TeamRole[]; status?: TeamMember['status'] }) {
    return request<TeamMember>(`/api/tenants/current/team/${encodeURIComponent(memberId)}`, {
      method: 'PATCH', body: JSON.stringify(input)
    });
  },
  listRoles(options: { includeArchived?: boolean } = {}, signal?: AbortSignal) {
    return request<{ permissions: Permission[]; items: CenterRole[] }>(
      `/api/tenants/current/roles${options.includeArchived ? '?includeArchived=true' : ''}`, { signal });
  },
  createRole(input: { name: string; permissions: string[] }) {
    return request<CenterRole>('/api/tenants/current/roles', { method: 'POST', body: JSON.stringify(input) });
  },
  updateRole(key: string, input: { name?: string; permissions?: string[] }) {
    return request<CenterRole>(`/api/tenants/current/roles/${encodeURIComponent(key)}`, { method: 'PATCH', body: JSON.stringify(input) });
  },
  setRoleArchived(key: string, archived: boolean) {
    return request<CenterRole>(`/api/tenants/current/roles/${encodeURIComponent(key)}/${archived ? 'archive' : 'restore'}`, { method: 'POST' });
  },
  updateManagedCatalogItem(item: ManagedCatalogItem, input: {
    name: string;
    category: string;
    description: string;
    pricingMode: ManagedCatalogItem['pricingMode'];
    active: boolean;
    operationIds?: string[];
    prices: Array<{ operationId?: string; tenantClass: string; amountMinor: number; durationMinutes: number }>;
  }) {
    const collection = item.type === 'service' ? 'services' : 'packages';
    return request<ManagedCatalogItem>(`/api/tenants/current/catalog/${collection}/${encodeURIComponent(item.id)}`, {
      method: 'PATCH', body: JSON.stringify(input)
    });
  },
  createCatalogSection(name: string) {
    return request<CatalogSection>('/api/tenants/current/catalog/sections', { method: 'POST', body: JSON.stringify({ name }) });
  },
  renameCatalogSection(sectionId: string, name: string) {
    return request<CatalogSection>(`/api/tenants/current/catalog/sections/${encodeURIComponent(sectionId)}`, { method: 'PATCH', body: JSON.stringify({ name }) });
  },
  reorderCatalogSections(ids: string[]) {
    return request<{ items: CatalogSection[] }>('/api/tenants/current/catalog/sections/order', { method: 'PUT', body: JSON.stringify({ ids }) });
  },
  deleteCatalogSection(sectionId: string) {
    return request<{ deleted: true }>(`/api/tenants/current/catalog/sections/${encodeURIComponent(sectionId)}`, { method: 'DELETE' });
  },
  createSimpleService(input: SimpleServiceInput) {
    return request<ManagedCatalogItem>('/api/tenants/current/catalog/simple-services', { method: 'POST', body: JSON.stringify(input) });
  },
  updateSimpleService(serviceId: string, input: SimpleServiceInput & { active: boolean }) {
    return request<ManagedCatalogItem>(`/api/tenants/current/catalog/simple-services/${encodeURIComponent(serviceId)}`, { method: 'PUT', body: JSON.stringify(input) });
  },
  listCatalogOperations(signal?: AbortSignal) {
    return request<{ items: CatalogOperation[] }>('/api/tenants/current/catalog/operations', { signal });
  },
  updateCatalogOperation(operationId: string, input: { name?: string; active?: boolean }) {
    return request<CatalogOperation>(`/api/tenants/current/catalog/operations/${encodeURIComponent(operationId)}`, {
      method: 'PATCH', body: JSON.stringify(input)
    });
  },
  createCatalogOperation(name: string) {
    return request<{ id: string; name: string; active: boolean }>('/api/tenants/current/catalog/operations', {
      method: 'POST', body: JSON.stringify({ name })
    });
  },
  createManagedCatalogItem(type: 'service' | 'package', input: {
    name: string;
    category: string;
    description: string;
    pricingMode?: ManagedCatalogItem['pricingMode'];
    operationPrices?: Array<{ operationId: string; amountMinor: number; durationMinutes: number }>;
    operationIds?: string[];
    amountMinor?: number;
    durationMinutes?: number;
  }) {
    const collection = type === 'service' ? 'services' : 'packages';
    return request<ManagedCatalogItem>(`/api/tenants/current/catalog/${collection}`, {
      method: 'POST', body: JSON.stringify(input)
    });
  },
  previewQuote(vehicleId: string, selections: QuoteSelection[], signal?: AbortSignal) {
    return request<BookingQuote>('/api/bookings/quote-preview', {
      method: 'POST',
      body: JSON.stringify({ vehicleId, selections }),
      signal
    });
  },
  getBookingAvailability(date: string, durationMinutes: number, signal?: AbortSignal) {
    return request<BookingAvailability>(`/api/bookings/availability?date=${encodeURIComponent(date)}&durationMinutes=${durationMinutes}`, { signal });
  },
  getBooking(bookingId: string, signal?: AbortSignal) {
    return request<Booking>(`/api/bookings/${encodeURIComponent(bookingId)}`, { signal });
  },
  reviseBookingQuote(bookingId: string, input: { selections: QuoteSelection[]; expectedQuoteVersion: number; reason?: string }) {
    return request<Booking>(`/api/bookings/${encodeURIComponent(bookingId)}/quote`, {
      method: 'PUT', body: JSON.stringify(input)
    });
  },
  updateBooking(bookingId: string, input: { startAt: string } | { status: 'CANCELLED' | 'NO_SHOW' }) {
    return request<Booking>(`/api/bookings/${encodeURIComponent(bookingId)}`, {
      method: 'PATCH', body: JSON.stringify(input)
    });
  },
  createBooking(input: {
    leadId?: string;
    customerId: string;
    vehicleId: string;
    channel: string;
    startAt: string;
    selections: QuoteSelection[];
  }, idempotencyKey: string) {
    return request<Booking>('/api/bookings', {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey },
      body: JSON.stringify(input)
    });
  },
  createOrder(bookingId: string) {
    return request<WorkOrder>('/api/orders', { method: 'POST', body: JSON.stringify({ bookingId }) });
  },
  saveIntake(orderId: string, input: {
    conditionSummary: string;
    findings: IntakeFinding[];
    recommendations: OrderRecommendation[];
  }) {
    return orderChange(orderId, 'Приёмка автомобиля', 'PUT', orderUrl(orderId, '/intake'), input, (order) => {
      const next = localSaveIntake(order, input, nowIso(), randomId);
      return { order: next, result: next };
    });
  },
  async uploadOrderPhoto(orderId: string, input: { phase?: 'intake' | 'result'; kind: 'intake' | 'defect'; zone: string; dataUrl: string }) {
    const photo = await orderChange<PhotoAsset>(orderId, input.phase === 'result' ? 'Фото результата' : 'Фото приёмки', 'POST', orderUrl(orderId, '/photos'), input,
      (order) => { const local = localAddPhoto(order, input, nowIso(), randomId); return { order: local.order, result: local.photo }; });
    // Sent directly: keep the phone's copy of the order in step with the new photo.
    const cached = await readCache<WorkOrder>(`/api/orders/${orderId}`);
    if (cached && !cached.photos.some((item) => item.id === photo.id)) await writeCache(`/api/orders/${orderId}`, { ...cached, photos: [...cached.photos, photo] });
    return photo;
  },
  createEstimate(orderId: string, lines: EstimateLineInput[]) {
    return request<EstimateVersion>(`/api/orders/${encodeURIComponent(orderId)}/estimates`, {
      method: 'POST', body: JSON.stringify({ lines })
    });
  },
  decideEstimate(orderId: string, input: {
    estimateVersionId: string;
    decision: 'APPROVED' | 'REJECTED';
    method: 'in_person' | 'phone' | 'messenger';
    source: string;
    responsible: string;
  }) {
    return request<WorkOrder>(`/api/orders/${encodeURIComponent(orderId)}/estimate-approvals`, {
      method: 'POST', body: JSON.stringify(input)
    });
  },
  listMasters(signal?: AbortSignal) {
    return request<{ items: Array<{ id: string; displayName: string; activeOrders: number }> }>('/api/tenants/current/masters', { signal });
  },
  assignMaster(orderId: string, memberId: string) {
    return request<WorkOrder>(`/api/orders/${encodeURIComponent(orderId)}/assignment`, {
      method: 'PUT', body: JSON.stringify({ memberId })
    });
  },
  startWork(orderId: string) {
    return orderChange(orderId, 'Начало работ', 'POST', orderUrl(orderId, '/work/start'), {}, (order) => {
      const next = localStartWork(order, nowIso());
      return { order: next, result: next };
    });
  },
  updateWorkOperation(orderId: string, operationId: string, status: 'PENDING' | 'DONE' | 'BLOCKED', note = '') {
    return orderChange(orderId, status === 'DONE' ? 'Операция выполнена' : 'Отметка операции', 'PATCH',
      orderUrl(orderId, `/work/operations/${encodeURIComponent(operationId)}`), { status, note }, (order) => {
        const next = localUpdateOperation(order, operationId, status, note, nowIso());
        return { order: next, result: next };
      });
  },
  pauseWork(orderId: string, note: string) {
    return orderChange(orderId, 'Пауза работ', 'POST', orderUrl(orderId, '/work/pause'), { note }, (order) => {
      const next = localSetPause(order, true, note, nowIso());
      return { order: next, result: next };
    });
  },
  resumeWork(orderId: string) {
    return orderChange(orderId, 'Возобновление работ', 'POST', orderUrl(orderId, '/work/resume'), {}, (order) => {
      const next = localSetPause(order, false, '', nowIso());
      return { order: next, result: next };
    });
  },
  completeWork(orderId: string) {
    return orderChange(orderId, 'Завершение работ', 'POST', orderUrl(orderId, '/work/complete'), {}, (order) => {
      const next = localCompleteWork(order, nowIso());
      return { order: next, result: next };
    });
  },
  submitQualityControl(orderId: string, input: {
    decision: 'PASSED' | 'REWORK';
    responsible: string;
    note: string;
    checks: Array<{ code: string; label: string; passed: boolean }>;
  }) {
    return request<WorkOrder>(`/api/orders/${encodeURIComponent(orderId)}/qc`, {
      method: 'POST', body: JSON.stringify(input)
    });
  },
  previewOrderDocument(orderId: string, type: OrderDocumentType, signal?: AbortSignal) {
    return request<{ type: OrderDocumentType; content: OrderDocumentContent }>(`/api/orders/${encodeURIComponent(orderId)}/documents/preview?type=${type}`, { signal });
  },
  getOrderDocument(orderId: string, documentId: string, signal?: AbortSignal) {
    return request<OrderDocument>(`/api/orders/${encodeURIComponent(orderId)}/documents/${encodeURIComponent(documentId)}`, { signal });
  },
  issueOrderDocument(orderId: string, input: { type: OrderDocumentType; signerName?: string; signatureDataUrl?: string }) {
    return request<OrderDocument>(`/api/orders/${encodeURIComponent(orderId)}/documents`, {
      method: 'POST', body: JSON.stringify(input)
    });
  },
  closeOrder(orderId: string, input: { responsible: string; note: string; customerAccepted: boolean; completenessChecked: boolean }) {
    return request<WorkOrder>(`/api/orders/${encodeURIComponent(orderId)}/handover`, {
      method: 'POST', body: JSON.stringify(input)
    });
  }
};
