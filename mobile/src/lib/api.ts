import { randomUUID } from 'expo-crypto';
import type {
  AuthProvider, Booking, BookingAvailability, BookingListItem, BookingQuote, CatalogVariant, Customer, CustomerProfile, EstimateLineInput, EstimateVersion, IntakeFinding, LoginRequest, LoginStatus,
  OrderDocument, OrderDocumentContent, OrderDocumentType, OrderListItem, OrderRecommendation, PhotoAsset, QuoteSelection, ServiceCatalog, SessionContext, Vehicle, WorkOrder
} from '@df/types';

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
  }
}

/** "192.168.1.60:4173" → "http://192.168.1.60:4173"; no trailing slash. */
export function normalizeServerUrl(input: string) {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
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

export function createApi(base: string, token: string | null, onUnauthorized: () => void) {
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        method: init.method ?? 'GET',
        signal: init.signal,
        headers: {
          accept: 'application/json',
          ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...init.headers
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined
      });
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error;
      throw new NetworkError();
    }
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401 && !path.startsWith('/api/auth/')) onUnauthorized();
    if (!response.ok) {
      throw new ApiError(payload.error?.message ?? 'Не удалось выполнить запрос', response.status, payload.error?.code ?? 'request_failed', payload.error?.details ?? {});
    }
    return payload as T;
  }

  // Every change carries its own idempotency key, as in the web app: a retry never applies it twice.
  const change = (orderId: string, method: string, path: string, body: unknown) =>
    request<WorkOrder>(`/api/orders/${encodeURIComponent(orderId)}${path}`, { method, body, headers: { 'idempotency-key': randomUUID() } });

  return {
    authProviders: (signal?: AbortSignal) => request<{ items: AuthProvider[]; demo: boolean }>('/api/auth/providers', { signal }),
    createLoginRequest: (provider: AuthProvider['provider']) => request<LoginRequest>('/api/auth/login-requests', { method: 'POST', body: { provider } }),
    loginStatus: (login: LoginRequest, signal?: AbortSignal) =>
      request<LoginStatus>(`/api/auth/login-requests/${encodeURIComponent(login.id)}`, { signal, headers: { 'x-login-secret': login.pollSecret } }),
    openSession: (login: LoginRequest, tenantId?: string) =>
      request<{ token: string; expiresAt: string; tenant: { id: string; name: string } }>(`/api/auth/login-requests/${encodeURIComponent(login.id)}/session`, {
        method: 'POST', headers: { 'x-login-secret': login.pollSecret }, body: tenantId ? { tenantId } : {}
      }),
    session: (signal?: AbortSignal) => request<SessionContext>('/api/session', { signal }),
    logout: () => request<{ revoked: boolean }>('/api/auth/logout', { method: 'POST', body: {} }),
    deleteAccount: () => request<{ deleted: true }>('/api/me', { method: 'DELETE' }),
    listOrders: (signal?: AbortSignal) => request<{ items: OrderListItem[] }>('/api/orders?limit=50', { signal }),
    getOrder: (orderId: string, signal?: AbortSignal) => request<WorkOrder>(`/api/orders/${encodeURIComponent(orderId)}`, { signal }),
    listMasters: (signal?: AbortSignal) => request<{ items: { id: string; displayName: string; activeOrders: number }[] }>('/api/tenants/current/masters', { signal }),
    assignMaster: (orderId: string, memberId: string) => change(orderId, 'PUT', '/assignment', { memberId }),
    startWork: (orderId: string) => change(orderId, 'POST', '/work/start', {}),
    updateOperation: (orderId: string, operationId: string, status: 'PENDING' | 'DONE' | 'BLOCKED', note = '') =>
      change(orderId, 'PATCH', `/work/operations/${encodeURIComponent(operationId)}`, { status, note }),
    pauseWork: (orderId: string, note: string) => change(orderId, 'POST', '/work/pause', { note }),
    resumeWork: (orderId: string) => change(orderId, 'POST', '/work/resume', {}),
    completeWork: (orderId: string) => change(orderId, 'POST', '/work/complete', {}),
    saveIntake: (orderId: string, input: { conditionSummary: string; findings: IntakeFinding[]; recommendations: OrderRecommendation[]; bodyType: string }) =>
      change(orderId, 'PUT', '/intake', input),
    addPhoto: (orderId: string, input: { phase: 'intake' | 'result'; kind: 'intake' | 'defect'; zone: string; dataUrl: string }) =>
      request<PhotoAsset>(`/api/orders/${encodeURIComponent(orderId)}/photos`, { method: 'POST', body: input, headers: { 'idempotency-key': randomUUID() } }),
    createEstimate: (orderId: string, lines: EstimateLineInput[]) =>
      request<EstimateVersion>(`/api/orders/${encodeURIComponent(orderId)}/estimates`, { method: 'POST', body: { lines }, headers: { 'idempotency-key': randomUUID() } }),
    decideEstimate: (orderId: string, input: { estimateVersionId: string; decision: 'APPROVED' | 'REJECTED'; method: 'in_person' | 'phone' | 'messenger'; responsible: string }) =>
      change(orderId, 'POST', '/estimate-approvals', { ...input, source: 'native_app' }),
    closeOrder: (orderId: string, input: { responsible: string; note: string; customerAccepted: boolean; completenessChecked: boolean }) =>
      change(orderId, 'POST', '/handover', input),
    previewDocument: (orderId: string, type: OrderDocumentType, signal?: AbortSignal) =>
      request<{ type: OrderDocumentType; content: OrderDocumentContent }>(`/api/orders/${encodeURIComponent(orderId)}/documents/preview?type=${type}`, { signal }),
    getDocument: (orderId: string, documentId: string, signal?: AbortSignal) =>
      request<OrderDocument>(`/api/orders/${encodeURIComponent(orderId)}/documents/${encodeURIComponent(documentId)}`, { signal }),
    issueDocument: (orderId: string, input: { type: OrderDocumentType; signerName?: string; signatureDataUrl?: string }) =>
      request<OrderDocument>(`/api/orders/${encodeURIComponent(orderId)}/documents`, { method: 'POST', body: input, headers: { 'idempotency-key': randomUUID() } }),
    /** Starts intake: the order of a booking (the server returns the existing one on a repeat). */
    createOrder: (bookingId: string) => request<WorkOrder>('/api/orders', { method: 'POST', body: { bookingId }, headers: { 'idempotency-key': randomUUID() } }),

    listBookings: (view: 'upcoming' | 'overdue', signal?: AbortSignal) => request<{ items: BookingListItem[] }>(`/api/bookings?view=${view}&limit=50`, { signal }),
    bookingCalendar: (from: string, to: string, signal?: AbortSignal) =>
      request<{ items: BookingListItem[] }>(`/api/bookings?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=50`, { signal }),
    getBooking: (bookingId: string, signal?: AbortSignal) => request<Booking>(`/api/bookings/${encodeURIComponent(bookingId)}`, { signal }),
    updateBooking: (bookingId: string, input: { startAt: string } | { status: 'CANCELLED' | 'NO_SHOW' }) =>
      request<Booking>(`/api/bookings/${encodeURIComponent(bookingId)}`, { method: 'PATCH', body: input, headers: { 'idempotency-key': randomUUID() } }),
    availability: (date: string, durationMinutes: number, excludeBookingId?: string, signal?: AbortSignal) =>
      request<BookingAvailability>(`/api/bookings/availability?date=${encodeURIComponent(date)}&durationMinutes=${durationMinutes}${excludeBookingId ? `&excludeBookingId=${encodeURIComponent(excludeBookingId)}` : ''}`, { signal }),
    createBooking: (input: { customerId: string; vehicleId: string; channel: string; startAt: string; selections: QuoteSelection[] }, idempotencyKey: string) =>
      request<Booking>('/api/bookings', { method: 'POST', body: input, headers: { 'idempotency-key': idempotencyKey } }),

    // Archived matches are returned too, so a returning customer is brought back instead of duplicated.
    searchCustomers: (phone: string, signal?: AbortSignal) => request<{ items: Customer[] }>(`/api/customers?phone=${encodeURIComponent(phone)}&includeArchived=true`, { signal }),
    searchVehicles: (plate: string, signal?: AbortSignal) => request<{ items: (Vehicle & { customer: Pick<Customer, 'id' | 'name' | 'phoneDisplay'> | null })[] }>(`/api/vehicles?plate=${encodeURIComponent(plate)}`, { signal }),
    createCustomer: (input: { name: string; phone: string }) => request<Customer>('/api/customers', { method: 'POST', body: input }),
    customerProfile: (customerId: string, signal?: AbortSignal) => request<CustomerProfile>(`/api/customers/${encodeURIComponent(customerId)}/profile`, { signal }),
    searchCatalog: (query: string, signal?: AbortSignal) => request<{ items: CatalogVariant[] }>(`/api/vehicle-catalog/variants?q=${encodeURIComponent(query)}`, { signal }),
    vehicleClasses: (signal?: AbortSignal) => request<{ items: string[] }>('/api/tenants/current/vehicle-classes', { signal }),
    createVehicle: (input: { customerId: string; catalogVariantId?: string; manual?: { make: string; model: string; generation?: string; bodyType: string }; tenantClass?: string; plateDisplay: string; color: string }) =>
      request<{ vehicle: Vehicle }>('/api/vehicles', { method: 'POST', body: input }),
    services: (vehicleId: string, signal?: AbortSignal) => request<ServiceCatalog>(`/api/tenants/current/services?vehicleId=${encodeURIComponent(vehicleId)}`, { signal }),
    previewQuote: (vehicleId: string, selections: QuoteSelection[], signal?: AbortSignal) =>
      request<BookingQuote>('/api/bookings/quote-preview', { method: 'POST', body: { vehicleId, selections }, signal })
  };
}

export type Api = ReturnType<typeof createApi>;
