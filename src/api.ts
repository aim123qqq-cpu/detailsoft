import type { Booking, BookingAvailability, BookingListItem, BookingQuote, CatalogVariant, Customer, EstimateLineInput, EstimateVersion, IntakeFinding, OrderListItem, OrderRecommendation, QuoteSelection, ServiceCatalog, Vehicle, WorkOrder } from './types';

const sessionHeaders = { authorization: 'Bearer demo-session-token' };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...sessionHeaders,
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers
    }
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message ?? 'Не удалось выполнить запрос');
  return payload;
}

export const api = {
  listBookings(signal?: AbortSignal) {
    return request<{ items: BookingListItem[] }>('/api/bookings?limit=20', { signal });
  },
  listOrders(signal?: AbortSignal) {
    return request<{ items: OrderListItem[] }>('/api/orders?limit=20', { signal });
  },
  searchCustomers(phone: string, signal?: AbortSignal) {
    return request<{ items: Customer[] }>(`/api/customers?phone=${encodeURIComponent(phone)}`, { signal });
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
  createVehicle(input: { customerId: string; catalogVariantId: string; plateDisplay: string; color: string }) {
    return request<{ vehicle: Vehicle }>('/api/vehicles', { method: 'POST', body: JSON.stringify(input) });
  },
  getServices(vehicleId: string, signal?: AbortSignal) {
    return request<ServiceCatalog>(`/api/tenants/current/services?vehicleId=${encodeURIComponent(vehicleId)}`, { signal });
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
  createBooking(input: {
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
  assignMaster(orderId: string, masterName: string) {
    return request<WorkOrder>(`/api/orders/${encodeURIComponent(orderId)}/assignment`, {
      method: 'PUT', body: JSON.stringify({ masterName })
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
  closeOrder(orderId: string, input: { responsible: string; note: string }) {
    return request<WorkOrder>(`/api/orders/${encodeURIComponent(orderId)}/handover`, {
      method: 'POST', body: JSON.stringify(input)
    });
  }
};
