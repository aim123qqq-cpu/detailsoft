import type { AuthProvider, CatalogOperation, LoginRequest, LoginStatus, MessengerProvider } from './types';
import type { AnalyticsOverview, Booking, BookingAvailability, BookingListItem, BookingQuote, CatalogSection, CatalogVariant, CenterRole, CenterSettings, Customer, CustomerProfile, EstimateLineInput, EstimateVersion, IntakeFinding, OrderDocument, OrderDocumentContent, OrderDocumentType, Lead, LeadStatus, ManagedCatalog, ManagedCatalogItem, OrderListItem, OrderRecommendation, Permission, PhotoAsset, QuoteSelection, ServiceCatalog, SessionContext, SimpleServiceInput, TeamMember, TeamRole, Vehicle, VehicleProfile, WorkOrder } from './types';

import { ApiRequestError } from './apiError';
import { localAddPhoto, localAssignMaster, localCloseOrder, localCompleteWork, localCreateEstimate, localCreateOrder, localDecideEstimate, localSaveIntake, localSetPause, localStartWork, localUpdateOperation } from './offline/orderLocal';
import { cachedPaths, configureSync, enqueue, flush, hasPending, markReachable, pendingBusy, readCache, tokenScope, writeCache } from './offline/sync';
import { localAvailability, localBooking, localCreateCustomer, localCreateVehicle, localQuote, localSearchCustomers, localSearchVehicles, localServicesCatalog, type BookingPack } from './offline/bookingLocal';
import { isSlotAvailable } from './shared/bookingRules';
import { buildDocumentContent, validSignature, type DocumentParties } from './shared/orderDocuments';
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
/** "/api/orders/<id>" → "order:<id>", "/api/bookings/<id>" → "booking:<id>". */
const entityOf = (path: string) => {
  const match = /^\/api\/(order|booking)s\/([^/?]+)$/.exec(path);
  return match && !['availability', 'quote-preview'].includes(match[2]) ? `${match[1]}:${match[2]}` : null;
};

async function request<T>(path: string, init?: RequestInit, options: { offlineCopy?: boolean } = {}): Promise<T> {
  const method = init?.method ?? 'GET';
  // An order or booking with unsent changes is shown from the phone's copy until the queue reaches the server.
  const pendingEntity = method === 'GET' ? entityOf(path) : null;
  if (pendingEntity && await hasPending(pendingEntity)) {
    const local = await readCache<T>(path);
    if (local !== undefined) { void flush(); return local; }
  }
  let response: Response;
  try {
    response = await send(path, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    markReachable(false);
    if (method === 'GET' && cacheable(path) && options.offlineCopy !== false) {
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

// ---- Bookings without the server ------------------------------------------------------------

const PACK_PATH = '/api/offline/booking-pack';
let packLoadedAt = 0;

/** Keeps the booking pack (schedule, prices, busy time, customers) fresh while online. */
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
  try {
    return await online();
  } catch (error) {
    if (!(error instanceof NetworkError)) throw error;
    return local(await offlinePack());
  }
}

async function busyWithLocal(pack: BookingPack) {
  const local = await pendingBusy();
  return [...pack.busy.filter((item) => !local.some((entry) => entry.id === item.id)), ...local.filter((entry) => !entry.free)];
}

const BOOKING_LISTS = '/api/bookings?';

/** Puts a booking made or moved on this phone into the saved booking lists it belongs to. */
async function upsertBookingInLists(item: BookingListItem) {
  const today = new Date().toISOString().slice(0, 10);
  const day = item.startAt.slice(0, 10);
  for (const path of await cachedPaths(BOOKING_LISTS)) {
    const list = await readCache<{ items: BookingListItem[] }>(path);
    if (!list) continue;
    const params = new URLSearchParams(path.slice(BOOKING_LISTS.length));
    const fits = params.get('view') === 'upcoming' ? day >= today
      : params.get('from') ? day >= params.get('from')! && day <= (params.get('to') ?? params.get('from'))!
      : false;
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
  const order = await readCache<WorkOrder>(`/api/orders/${orderId}`);
  const parties = order && await localParties(order);
  if (!order || !parties) throw new NetworkError();
  const built = buildDocumentContent(order, parties, type);
  if (built.kind !== 'built') throw new ApiRequestError(built.message, 409, built.code);
  return { order, content: built.content as OrderDocumentContent };
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
  async listBookings(signal?: AbortSignal) {
    const result = await request<{ items: BookingListItem[] }>('/api/bookings?view=upcoming&limit=50', { signal });
    void prefetchBookings(result.items);
    return result;
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
  refreshBookingPack,
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
    return withPack(() => request<{ items: Customer[] }>(`/api/customers?phone=${encodeURIComponent(phone)}${includeArchived ? '&includeArchived=true' : ''}`, { signal }),
      (pack) => ({ items: localSearchCustomers(pack, phone) }));
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
    return withPack(() => request<{ items: Array<Vehicle & { customer: Customer | null }> }>(`/api/vehicles?plate=${encodeURIComponent(plate)}`, { signal }),
      (pack) => ({ items: localSearchVehicles(pack, plate) }));
  },
  searchCatalog(query: string, signal?: AbortSignal) {
    return request<{ items: CatalogVariant[] }>(`/api/vehicle-catalog/variants?q=${encodeURIComponent(query)}`, { signal });
  },
  async createCustomer(input: { name: string; phone: string }) {
    if (!(await hasPending())) {
      try {
        const customer = await request<Customer>('/api/customers', { method: 'POST', body: JSON.stringify(input) });
        void refreshBookingPack(true);
        return customer;
      } catch (error) {
        if (!(error instanceof NetworkError)) throw error;
      }
    }
    // Offline: the customer is named on the phone and checked against the saved customers; on the
    // server the phone is checked again and a match asks "same customer?" instead of duplicating.
    const id = `cust_${randomId()}`;
    const { pack, customer } = localCreateCustomer(await offlinePack(), input, id);
    await writeCache(PACK_PATH, pack);
    await enqueue({ method: 'POST', path: '/api/customers', body: JSON.stringify({ ...input, id, checkDuplicatePhone: true }), key: randomId(),
      label: `Новый клиент · ${customer.name}`, entity: `customer:${id}` });
    return customer;
  },
  /** `variant` (the picked catalog entry) lets the phone describe the vehicle when offline. */
  async createVehicle(input: {
    customerId: string;
    catalogVariantId?: string;
    manual?: { make: string; model: string; generation?: string; bodyType: string };
    tenantClass?: string;
    plateDisplay: string;
    color: string;
  }, variant: CatalogVariant | null = null) {
    if (!(await hasPending())) {
      try {
        const result = await request<{ vehicle: Vehicle }>('/api/vehicles', { method: 'POST', body: JSON.stringify(input) });
        void refreshBookingPack(true);
        return result;
      } catch (error) {
        if (!(error instanceof NetworkError)) throw error;
      }
    }
    const id = `veh_${randomId()}`;
    const { pack, vehicle } = localCreateVehicle(await offlinePack(), input, variant, id);
    await writeCache(PACK_PATH, pack);
    await enqueue({ method: 'POST', path: '/api/vehicles', body: JSON.stringify({ ...input, id }), key: randomId(),
      label: `Новый автомобиль · ${vehicle.plate}`, entity: `vehicle:${id}`, dependsOn: [`customer:${input.customerId}`] });
    return { vehicle };
  },
  listVehicleClasses(signal?: AbortSignal) {
    // Offline: the classes of the center's rules, in the server's order (SQL ORDER BY, binary).
    return withPack(() => request<{ items: string[] }>('/api/tenants/current/vehicle-classes', { signal }),
      (pack) => ({ items: [...new Set(pack.classRules.map((rule) => rule.tenantClass))].sort() }));
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
    return withPack(() => request<ServiceCatalog>(`/api/tenants/current/services?vehicleId=${encodeURIComponent(vehicleId)}`, { signal }),
      (pack) => localServicesCatalog(pack, vehicleId));
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
    return withPack(() => request<BookingQuote>('/api/bookings/quote-preview', {
      method: 'POST',
      body: JSON.stringify({ vehicleId, selections }),
      signal
    }), (pack) => localQuote(pack, vehicleId, selections));
  },
  /** excludeBookingId: free time for moving that booking (it does not block itself). */
  async getBookingAvailability(date: string, durationMinutes: number, signal?: AbortSignal, excludeBookingId: string | null = null) {
    // Bookings made here and not yet sent are unknown to the server: count them on the phone.
    if (!(await pendingBusy()).length) {
      try {
        const exclude = excludeBookingId ? `&excludeBookingId=${encodeURIComponent(excludeBookingId)}` : '';
        return await request<BookingAvailability>(`/api/bookings/availability?date=${encodeURIComponent(date)}&durationMinutes=${durationMinutes}${exclude}`, { signal }, { offlineCopy: false });
      } catch (error) {
        if (!(error instanceof NetworkError)) throw error;
      }
    }
    const pack = await offlinePack();
    return localAvailability(pack, await pendingBusy(), date, durationMinutes, excludeBookingId);
  },
  getBooking(bookingId: string, signal?: AbortSignal) {
    return request<Booking>(`/api/bookings/${encodeURIComponent(bookingId)}`, { signal });
  },
  reviseBookingQuote(bookingId: string, input: { selections: QuoteSelection[]; expectedQuoteVersion: number; reason?: string; startAt?: string }) {
    return request<Booking>(`/api/bookings/${encodeURIComponent(bookingId)}/quote`, {
      method: 'PUT', body: JSON.stringify(input)
    });
  },
  async updateBooking(bookingId: string, input: { startAt: string } | { status: 'CANCELLED' | 'NO_SHOW' }) {
    const path = `/api/bookings/${encodeURIComponent(bookingId)}`;
    const key = randomId();
    const body = JSON.stringify(input);
    if (!(await hasPending())) {
      try {
        return await request<Booking>(path, { method: 'PATCH', body, headers: { 'idempotency-key': key } });
      } catch (error) {
        if (!(error instanceof NetworkError)) throw error;
      }
    }
    const booking = await readCache<Booking>(path);
    if (!booking) throw new NetworkError();
    if (booking.status !== 'CONFIRMED') throw new ApiRequestError('Изменить можно только подтверждённую запись', 409, 'invalid_booking_state');
    const listed = await findBookingListItem(bookingId);
    if (listed?.orderId) throw new ApiRequestError('По записи уже создан заказ', 409, 'booking_has_order');
    if ('status' in input) {
      // Cancelling or a no-show frees the time at once on this phone.
      if (input.status === 'NO_SHOW' && Date.parse(booking.startAt) > Date.now()) {
        throw new ApiRequestError('Отметить неявку можно после времени начала записи', 409, 'booking_not_started');
      }
      const changed: Booking = { ...booking, status: input.status, slotConflict: false, pendingSync: true };
      await writeCache(path, changed);
      if (listed) await upsertBookingInLists({ ...listed, status: input.status, slotConflict: false, pendingSync: true });
      await enqueue({ method: 'PATCH', path, body, key, label: `${input.status === 'CANCELLED' ? 'Отмена' : 'Неявка'}${listed ? ` · ${listed.customer.name}` : ''}`,
        entity: `booking:${bookingId}`, busy: { id: bookingId, startAt: booking.startAt, durationMinutes: booking.estimatedDurationMinutes, free: true } });
      return changed;
    }
    const pack = await offlinePack();
    if (!isSlotAvailable(pack.schedule, await busyWithLocal(pack), input.startAt, booking.estimatedDurationMinutes, bookingId)) {
      throw new ApiRequestError('Это время уже занято', 409, 'slot_unavailable');
    }
    const moved: Booking = { ...booking, startAt: input.startAt, pendingSync: true };
    await writeCache(path, moved);
    if (listed) await upsertBookingInLists({ ...listed, startAt: input.startAt, pendingSync: true });
    await enqueue({ method: 'PATCH', path, body, key, label: `Перенос записи${listed ? ` · ${listed.customer.name}` : ''}`, entity: `booking:${bookingId}`,
      busy: { id: bookingId, startAt: input.startAt, durationMinutes: booking.estimatedDurationMinutes } });
    return moved;
  },
  async createBooking(input: {
    leadId?: string;
    customerId: string;
    vehicleId: string;
    channel: string;
    startAt: string;
    selections: QuoteSelection[];
  }, idempotencyKey: string) {
    if (!(await hasPending())) {
      try {
        const booking = await request<Booking>('/api/bookings', {
          method: 'POST',
          headers: { 'idempotency-key': idempotencyKey },
          body: JSON.stringify(input)
        });
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
    if (!isSlotAvailable(pack.schedule, await busyWithLocal(pack), input.startAt, quote.totalDurationMinutes)) {
      throw new ApiRequestError('Это время уже занято', 409, 'slot_unavailable');
    }
    const id = `booking_${randomId()}`;
    const booking: Booking = { ...localBooking(id, input, quote, pack, nowIso()), pendingSync: true };
    await writeCache(`/api/bookings/${id}`, booking);
    const customer = pack.customers.find((item) => item.id === input.customerId);
    const vehicle = customer?.vehicles.find((item) => item.id === input.vehicleId);
    if (customer && vehicle) await upsertBookingInLists({
      id, channel: input.channel, startAt: input.startAt, estimatedDurationMinutes: quote.totalDurationMinutes, status: 'CONFIRMED',
      preliminaryAmountMinor: quote.totalAmountMinor, orderId: null, pendingSync: true,
      customer: { id: customer.id, name: customer.name, phoneDisplay: customer.phoneDisplay },
      vehicle: { id: vehicle.id, make: vehicle.make, model: vehicle.model, generation: vehicle.generation, plate: vehicle.plate, color: vehicle.color }
    });
    await enqueue({ method: 'POST', path: '/api/bookings', body: JSON.stringify({ ...input, id, allowSlotConflict: true }), key: idempotencyKey,
      label: `Новая запись${customer ? ` · ${customer.name}` : ''}`, entity: `booking:${id}`,
      dependsOn: [`customer:${input.customerId}`, `vehicle:${input.vehicleId}`],
      busy: { id, startAt: input.startAt, durationMinutes: quote.totalDurationMinutes } });
    return booking;
  },
  async createOrder(bookingId: string) {
    const id = `order_${randomId()}`;
    const key = randomId();
    const body = JSON.stringify({ bookingId, id });
    if (!(await hasPending())) {
      try {
        return await request<WorkOrder>('/api/orders', { method: 'POST', body, headers: { 'idempotency-key': key } });
      } catch (error) {
        if (!(error instanceof NetworkError)) throw error;
      }
    }
    // Offline intake: the order is created on the phone from the saved booking.
    const listed = await findBookingListItem(bookingId);
    const booking = await readCache<Booking>(`/api/bookings/${encodeURIComponent(bookingId)}`);
    const source = booking ?? (listed && { id: listed.id, customerId: listed.customer.id, vehicleId: listed.vehicle.id, status: listed.status });
    if (!source) throw new NetworkError();
    if (listed?.orderId) {
      const existing = await readCache<WorkOrder>(`/api/orders/${listed.orderId}`);
      if (existing) return existing;
    }
    const order = localCreateOrder(source, id, nowIso());
    await writeCache(`/api/orders/${id}`, order);
    if (listed) {
      await upsertBookingInLists({ ...listed, orderId: id });
      const list = await readCache<{ items: OrderListItem[] }>(ORDERS_LIST);
      if (list) await writeCache(ORDERS_LIST, { ...list, items: [{ id, status: order.status, createdAt: order.createdAt, totalAmountMinor: null, masterName: null, masterMemberId: null, customer: listed.customer, vehicle: listed.vehicle }, ...list.items] });
    }
    await enqueue({ method: 'POST', path: '/api/orders', body, key, label: `Начало приёмки${listed ? ` · ${listed.customer.name}` : ''}`, entity: `order:${id}`,
      dependsOn: [`booking:${bookingId}`] });
    return order;
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
  async createEstimate(orderId: string, lines: EstimateLineInput[]) {
    // Ids come from the phone so an approval and work started offline can refer to this version.
    const id = `estimate_${randomId()}`;
    const withIds = lines.map((line) => ({ ...line, id: `estimate_line_${randomId()}` }));
    const estimate = await orderChange<EstimateVersion>(orderId, 'Смета', 'POST', orderUrl(orderId, '/estimates'), { id, lines: withIds }, (order) => {
      const local = localCreateEstimate(order, withIds, id, nowIso());
      return { order: local.order, result: local.estimate };
    });
    // Sent directly, the answer is the estimate only: keep the phone's copy of the order in step.
    const cached = await readCache<WorkOrder>(`/api/orders/${orderId}`);
    if (cached && !cached.estimateVersions.some((item) => item.id === estimate.id)) {
      await writeCache(`/api/orders/${orderId}`, { ...cached, currentEstimateVersionId: estimate.id, estimateVersions: [...cached.estimateVersions, estimate] });
    }
    return estimate;
  },
  decideEstimate(orderId: string, input: {
    estimateVersionId: string;
    decision: 'APPROVED' | 'REJECTED';
    method: 'in_person' | 'phone' | 'messenger';
    source: string;
    responsible: string;
  }) {
    return orderChange(orderId, input.decision === 'APPROVED' ? 'Согласование сметы' : 'Отказ от сметы', 'POST', orderUrl(orderId, '/estimate-approvals'), input, (order) => {
      const next = localDecideEstimate(order, input, nowIso());
      return { order: next, result: next };
    });
  },
  listMasters(signal?: AbortSignal) {
    return request<{ items: Array<{ id: string; displayName: string; activeOrders: number }> }>('/api/tenants/current/masters', { signal });
  },
  async assignMaster(orderId: string, memberId: string) {
    const masters = (await readCache<{ items: Array<{ id: string; displayName: string }> }>('/api/tenants/current/masters'))?.items ?? [];
    return orderChange(orderId, 'Назначение мастера', 'PUT', orderUrl(orderId, '/assignment'), { memberId }, (order) => {
      const master = masters.find((item) => item.id === memberId);
      if (!master) throw new ApiRequestError('Список мастеров не сохранён на телефоне. Назначьте мастера, когда будет связь', 422, 'not_a_master');
      const next = localAssignMaster(order, master, nowIso());
      return { order: next, result: next };
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
  async previewOrderDocument(orderId: string, type: OrderDocumentType, signal?: AbortSignal) {
    // Unsent changes of the order are on the phone only: the preview is built here from them.
    if (!(await hasPending(`order:${orderId}`))) {
      try {
        return await request<{ type: OrderDocumentType; content: OrderDocumentContent }>(`/api/orders/${encodeURIComponent(orderId)}/documents/preview?type=${type}`, { signal }, { offlineCopy: false });
      } catch (error) {
        if (!(error instanceof NetworkError)) throw error;
      }
    }
    return { type, content: (await localDocumentContent(orderId, type)).content };
  },
  async getOrderDocument(orderId: string, documentId: string, signal?: AbortSignal) {
    const path = `/api/orders/${encodeURIComponent(orderId)}/documents/${encodeURIComponent(documentId)}`;
    // An act issued offline exists only on the phone until the queue reaches the server.
    if (documentId.startsWith('doc_local_')) {
      const local = await readCache<OrderDocument>(path);
      if (local) return local;
    }
    return request<OrderDocument>(path, { signal });
  },
  async issueOrderDocument(orderId: string, input: { type: OrderDocumentType; signerName?: string; signatureDataUrl?: string }) {
    const path = `/api/orders/${encodeURIComponent(orderId)}/documents`;
    const key = randomId();
    if (!(await hasPending())) {
      try {
        return await request<OrderDocument>(path, { method: 'POST', body: JSON.stringify(input), headers: { 'idempotency-key': key } });
      } catch (error) {
        if (!(error instanceof NetworkError)) throw error;
      }
    }
    // Offline: the act and the signature are kept on the phone; the server numbers the act when it
    // receives it (numbers run through the whole center) and builds it with the same code.
    const signed = Boolean(input.signatureDataUrl);
    if (signed && !validSignature(input.signerName ?? '', input.signatureDataUrl!)) throw new ApiRequestError('Проверьте ФИО и подпись', 422, 'validation_error');
    const { order, content } = await localDocumentContent(orderId, input.type);
    const now = nowIso();
    const document: OrderDocument = {
      id: `doc_local_${randomId()}`, type: input.type, number: 'присвоится при отправке', signed,
      signerName: signed ? input.signerName!.trim() : null, signedAt: signed ? now : null, actorName: null, createdAt: now,
      current: true, outdated: false, content, signatureDataUrl: signed ? input.signatureDataUrl! : null
    };
    const { content: _content, signatureDataUrl: _signature, ...summary } = document;
    await writeCache(`${path}/${document.id}`, document);
    await writeCache(`/api/orders/${orderId}`, { ...order, documents: [summary, ...order.documents.map((item) => item.type === input.type ? { ...item, current: false } : item)] });
    await enqueue({ method: 'POST', path, body: JSON.stringify(input), key, label: input.type === 'intake_act' ? 'Акт приёмки' : 'Акт выдачи', entity: `order:${orderId}` });
    return document;
  },
  closeOrder(orderId: string, input: { responsible: string; note: string; customerAccepted: boolean; completenessChecked: boolean }) {
    return orderChange(orderId, 'Выдача автомобиля', 'POST', orderUrl(orderId, '/handover'), input, (order) => {
      const next = localCloseOrder(order, input, nowIso());
      return { order: next, result: next };
    });
  }
};
