import type { AuthProvider, CatalogOperation, LoginRequest, LoginStatus, MessengerProvider } from './types';
import type { AnalyticsOverview, Booking, BookingAvailability, BookingListItem, BookingQuote, CatalogSection, CatalogVariant, CenterRole, CenterSettings, Customer, CustomerProfile, EstimateLineInput, EstimateVersion, IntakeFinding, OrderDocument, OrderDocumentContent, OrderDocumentType, Lead, LeadStatus, ManagedCatalog, ManagedCatalogItem, OrderListItem, OrderRecommendation, Permission, PhotoAsset, QuoteSelection, ServiceCatalog, SessionContext, SimpleServiceInput, TeamMember, TeamRole, Vehicle, VehicleProfile, WorkOrder } from './types';

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

/** Keeps the API error code and details so screens can react to specific conflicts. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(message: string, status: number, code: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    const token = currentToken();
    response = await fetch(path, {
      ...init,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers
      }
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    const offline = typeof navigator !== 'undefined' && !navigator.onLine;
    throw new Error(offline
      ? 'Нет подключения к интернету. Данные формы сохранены.'
      : 'Не удалось связаться с сервером. Данные формы сохранены — повторите запрос.');
  }
  const payload = await response.json();
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
  listOrders(signal?: AbortSignal) {
    return request<{ items: OrderListItem[] }>('/api/orders?limit=20', { signal });
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
    return request<WorkOrder>(`/api/orders/${encodeURIComponent(orderId)}/intake`, {
      method: 'PUT', body: JSON.stringify(input)
    });
  },
  uploadOrderPhoto(orderId: string, input: { phase?: 'intake' | 'result'; kind: 'intake' | 'defect'; zone: string; dataUrl: string }) {
    return request<PhotoAsset>(`/api/orders/${encodeURIComponent(orderId)}/photos`, {
      method: 'POST', body: JSON.stringify(input)
    });
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
    return request<WorkOrder>(`/api/orders/${encodeURIComponent(orderId)}/work/start`, {
      method: 'POST', body: JSON.stringify({})
    });
  },
  updateWorkOperation(orderId: string, operationId: string, status: 'PENDING' | 'DONE' | 'BLOCKED', note = '') {
    return request<WorkOrder>(`/api/orders/${encodeURIComponent(orderId)}/work/operations/${encodeURIComponent(operationId)}`, {
      method: 'PATCH', body: JSON.stringify({ status, note })
    });
  },
  pauseWork(orderId: string, note: string) {
    return request<WorkOrder>(`/api/orders/${encodeURIComponent(orderId)}/work/pause`, {
      method: 'POST', body: JSON.stringify({ note })
    });
  },
  resumeWork(orderId: string) {
    return request<WorkOrder>(`/api/orders/${encodeURIComponent(orderId)}/work/resume`, {
      method: 'POST', body: JSON.stringify({})
    });
  },
  completeWork(orderId: string) {
    return request<WorkOrder>(`/api/orders/${encodeURIComponent(orderId)}/work/complete`, {
      method: 'POST', body: JSON.stringify({})
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
