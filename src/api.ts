import type { CatalogVariant, Customer, Vehicle } from './types';

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
  }
};
