import { availabilityForDate, computeQuote, formatMoney, priceLabel, type BusyBooking, type CenterSchedule, type PricingMode } from '../shared/bookingRules.ts';
import { normalizePhone, normalizePlate } from '../shared/normalize.ts';
import { ApiRequestError } from '../apiError.ts';
import type { Booking, BookingAvailability, BookingQuote, Customer, QuoteSelection, ServiceCatalog, ServiceOffering, Vehicle } from '../types';

type Price = { amountMinor: number; durationMinutes: number };
type Prices = Record<string, Price>;

/** GET /api/offline/booking-pack (server/offline-pack.mjs). */
export type BookingPack = {
  generatedAt: string;
  schedule: CenterSchedule;
  sectionOrder: string[];
  packages: Array<{ id: string; category: string; name: string; description: string; prices: Prices; operations: Array<{ id: string; name: string }> }>;
  services: Array<{ id: string; category: string; name: string; description: string; pricingMode: PricingMode; operations: Array<{ id: string; name: string; prices: Prices }> }>;
  busy: BusyBooking[];
  customers: Array<Customer & { phoneNormalized: string }>;
  vehicleClasses: Record<string, string>;
};

// The class's own price, else the '*' default — the same lookup as on the server.
const priceFor = (prices: Prices, vehicleClass: string): Price | null => prices[vehicleClass] ?? prices['*'] ?? null;

export function vehicleClassOf(pack: BookingPack, vehicleId: string) {
  const vehicleClass = pack.vehicleClasses[vehicleId];
  if (!vehicleClass) throw new ApiRequestError('Автомобиль не сохранён на телефоне. Откройте запись, когда будет связь', 404, 'vehicle_not_found');
  return vehicleClass;
}

export function localServicesCatalog(pack: BookingPack, vehicleId: string): ServiceCatalog {
  const vehicleClass = vehicleClassOf(pack, vehicleId);
  const packages: ServiceOffering[] = pack.packages.flatMap((item) => {
    const price = priceFor(item.prices, vehicleClass);
    return price ? [{ id: item.id, type: 'package' as const, category: item.category, name: item.name, description: item.description, pricingMode: 'fixed' as const,
      price: { amountMinor: price.amountMinor, label: formatMoney(price.amountMinor) }, durationMinutes: price.durationMinutes, operations: item.operations }] : [];
  });
  const services: ServiceOffering[] = pack.services.flatMap((item) => {
    const prices = item.operations.map((operation) => priceFor(operation.prices, vehicleClass));
    // Like the server: a service without a price for every operation is not offered.
    if (!item.operations.length || prices.some((price) => !price)) return [];
    const amountMinor = prices.reduce((sum, price) => sum + price!.amountMinor, 0);
    return [{ id: item.id, type: 'service' as const, category: item.category, name: item.name, description: item.description, pricingMode: item.pricingMode,
      price: { amountMinor, label: priceLabel(amountMinor, item.pricingMode) }, durationMinutes: prices.reduce((sum, price) => sum + price!.durationMinutes, 0),
      operations: item.operations.map(({ id, name }) => ({ id, name })) }];
  });
  const categories: ServiceCatalog['categories'] = [];
  for (const item of [...packages, ...services]) {
    let category = categories.find((entry) => entry.name === item.category);
    if (!category) categories.push(category = { name: item.category, items: [] });
    category.items.push(item);
  }
  const position = (name: string) => { const index = pack.sectionOrder.indexOf(name); return index < 0 ? Number.MAX_SAFE_INTEGER : index; };
  categories.sort((left, right) => position(left.name) - position(right.name));
  return { vehicleClass, categories };
}

export function localQuote(pack: BookingPack, vehicleId: string, selections: QuoteSelection[]): BookingQuote {
  const vehicleClass = vehicleClassOf(pack, vehicleId);
  const result = computeQuote(selections,
    (id) => {
      const item = pack.packages.find((entry) => entry.id === id);
      const price = item && priceFor(item.prices, vehicleClass);
      return item && price ? { id: item.id, name: item.name, ...price, operations: item.operations } : null;
    },
    (id) => {
      const item = pack.services.find((entry) => entry.id === id);
      if (!item) return null;
      const operations = item.operations.flatMap((operation) => {
        const price = priceFor(operation.prices, vehicleClass);
        return price ? [{ id: operation.id, name: operation.name, ...price }] : [];
      });
      return { id: item.id, name: item.name, pricingMode: item.pricingMode, operationCount: item.operations.length, operations };
    });
  if (result.kind === 'conflict') throw new ApiRequestError(result.message, 409, result.code);
  if (result.kind !== 'quoted') throw new ApiRequestError('Выберите услуги из каталога', 422, 'validation_error');
  const { kind, ...quote } = result;
  return { preliminary: true, vehicleClass, ...quote };
}

/** Free time from the saved busy time plus bookings made on this phone and not yet sent. */
export function localAvailability(pack: BookingPack, extraBusy: Array<BusyBooking & { free?: boolean }>, date: string, durationMinutes: number): BookingAvailability {
  // A booking cancelled here no longer occupies its time.
  const busy = [...pack.busy.filter((item) => !extraBusy.some((extra) => extra.id === item.id)), ...extraBusy.filter((item) => !item.free)];
  const result = availabilityForDate(pack.schedule, busy, date, durationMinutes);
  if (result.kind !== 'available') throw new ApiRequestError('Проверьте дату', 422, 'validation_error');
  const { kind, ...availability } = result;
  return availability;
}

export function localSearchCustomers(pack: BookingPack, phone: string): Customer[] {
  const digits = normalizePhone(phone);
  if (digits.length < 4) return [];
  return pack.customers.filter((customer) => customer.phoneNormalized.includes(digits))
    .sort((left, right) => right.visitCount - left.visitCount || left.name.localeCompare(right.name, 'ru'))
    .slice(0, 10)
    .map(({ phoneNormalized, ...customer }) => customer);
}

export function localSearchVehicles(pack: BookingPack, plate: string): Array<Vehicle & { customer: Customer | null }> {
  const normalized = normalizePlate(plate);
  if (normalized.length < 2) return [];
  return pack.customers.flatMap((customer) => customer.vehicles
    .filter((vehicle) => normalizePlate(vehicle.plate).includes(normalized))
    .map((vehicle) => ({ ...vehicle, customer: { id: customer.id, name: customer.name, phoneDisplay: customer.phoneDisplay, visitCount: customer.visitCount, vehicles: [] } })))
    .slice(0, 10);
}

/** The booking as the server would answer it; `id` was chosen on the phone. */
export function localBooking(id: string, input: { customerId: string; vehicleId: string; channel: string; startAt: string; leadId?: string | null }, quote: BookingQuote, pack: BookingPack, now: string): Booking {
  const lines = quote.lines;
  return {
    id, leadId: input.leadId ?? null, customerId: input.customerId, vehicleId: input.vehicleId, channel: input.channel,
    startAt: input.startAt, timezone: pack.schedule.timezone, estimatedDurationMinutes: quote.totalDurationMinutes,
    status: 'CONFIRMED', preliminaryAmountMinor: quote.totalAmountMinor, resourceId: null, quoteVersion: 1, lines,
    quoteVersions: [{ version: 1, vehicleClass: quote.vehicleClass, totalAmountMinor: quote.totalAmountMinor, totalDurationMinutes: quote.totalDurationMinutes, reason: null, actorName: null, createdAt: now, lines }]
  };
}
