import { availabilityForDate, computeQuote, formatMoney, priceLabel, type BusyBooking, type CenterSchedule, type PricingMode } from '../shared/bookingRules.ts';
import { normalizePhone, normalizePlate } from '../shared/normalize.ts';
import { ApiRequestError } from '../apiError.ts';
import type { Booking, BookingAvailability, BookingQuote, Customer, QuoteSelection, ServiceCatalog, ServiceOffering, Vehicle } from '../types';

type Price = { amountMinor: number; durationMinutes: number };
type Prices = Record<string, Price>;

/** GET /api/offline/booking-pack (server/offline-pack.mjs). */
export type BookingPack = {
  generatedAt: string;
  classRules: Array<{ variantId: string | null; classMatch: string | null; tenantClass: string; priority: number }>;
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
export function localAvailability(pack: BookingPack, extraBusy: Array<BusyBooking & { free?: boolean }>, date: string, durationMinutes: number, excludeBookingId: string | null = null): BookingAvailability {
  // A booking cancelled here no longer occupies its time; the booking being moved does not block itself.
  const busy = [...pack.busy.filter((item) => !extraBusy.some((extra) => extra.id === item.id)), ...extraBusy.filter((item) => !item.free)]
    .filter((item) => item.id !== excludeBookingId);
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

/**
 * Pricing class of a vehicle added on the phone, as server getVehiclePricingContext decides it:
 * an explicit class, else the best rule for its catalog variant or system class, else the system
 * class, else "Стандарт".
 */
export function localVehicleClass(pack: BookingPack, vehicle: { catalogVariantId: string | null; systemVehicleClass: string | null; tenantClass: string | null }) {
  if (vehicle.tenantClass) return vehicle.tenantClass;
  const rule = [...pack.classRules].sort((left, right) => right.priority - left.priority).find((item) =>
    item.variantId === vehicle.catalogVariantId && vehicle.catalogVariantId !== null ||
    item.variantId === null && item.classMatch !== null && item.classMatch === vehicle.systemVehicleClass);
  return rule?.tenantClass ?? vehicle.systemVehicleClass ?? 'Стандарт';
}

/** A customer made on the phone; refuses a phone that the saved customers already have. */
export function localCreateCustomer(pack: BookingPack, input: { name: string; phone: string }, id: string): { pack: BookingPack; customer: Customer } {
  const name = input.name.trim();
  const phoneNormalized = normalizePhone(input.phone);
  if (name.length < 2 || phoneNormalized.length < 7) throw new ApiRequestError('Укажите имя и корректный телефон', 422, 'validation_error');
  const existing = pack.customers.find((customer) => customer.phoneNormalized === phoneNormalized);
  if (existing) throw new ApiRequestError(`Клиент с этим телефоном уже есть: ${existing.name}`, 409, 'customer_phone_exists', { customers: [{ id: existing.id, name: existing.name, phoneDisplay: existing.phoneDisplay }] });
  const customer: Customer = { id, name, phoneDisplay: input.phone.trim(), visitCount: 0, archived: false, vehicles: [] };
  return { pack: { ...pack, customers: [...pack.customers, { ...customer, phoneNormalized }] }, customer };
}

type VehicleInput = {
  customerId: string;
  catalogVariantId?: string;
  manual?: { make: string; model: string; generation?: string; bodyType: string; systemVehicleClass?: string };
  tenantClass?: string;
  plateDisplay: string;
  color: string;
};
type VariantInfo = { id: string; make: string; model: string; generation?: string | null; bodyType: string; systemVehicleClass?: string | null };

/** A vehicle added on the phone; the same checks as the server, including a plate already on file. */
export function localCreateVehicle(pack: BookingPack, input: VehicleInput, variant: VariantInfo | null, id: string): { pack: BookingPack; vehicle: Vehicle } {
  const owner = pack.customers.find((customer) => customer.id === input.customerId);
  if (!owner) throw new ApiRequestError('Клиент не найден', 404, 'customer_not_found');
  const model = input.catalogVariantId ? variant : input.manual ? {
    id: null, make: input.manual.make.trim(), model: input.manual.model.trim(), generation: input.manual.generation?.trim() || null,
    bodyType: input.manual.bodyType, systemVehicleClass: input.manual.systemVehicleClass?.trim() || null
  } : null;
  if (!model || (input.catalogVariantId && model.id !== input.catalogVariantId) || model.make.length < 2 || !model.model.length) {
    throw new ApiRequestError('Проверьте госномер, цвет и модель', 422, 'validation_error');
  }
  const plate = normalizePlate(input.plateDisplay);
  if (plate.length < 3 || !input.color.trim()) throw new ApiRequestError('Проверьте госномер, цвет и модель', 422, 'validation_error');
  const matches = pack.customers.flatMap((customer) => customer.vehicles.filter((vehicle) => normalizePlate(vehicle.plate) === plate)
    .map((vehicle) => ({ ...vehicle, customer: { id: customer.id, name: customer.name, phoneDisplay: customer.phoneDisplay } })));
  if (matches.length) throw new ApiRequestError('Возможно, автомобиль уже существует', 409, 'possible_duplicate', { matches });
  const tenantClass = input.tenantClass?.trim() || null;
  const vehicle: Vehicle = {
    id, catalogVariantId: input.catalogVariantId ?? null, make: model.make, model: model.model, generation: model.generation ?? null,
    bodyType: model.bodyType, plate: input.plateDisplay.trim(), color: input.color.trim(), status: 'active', active: true, tenantClass
  };
  const vehicleClass = localVehicleClass(pack, { catalogVariantId: vehicle.catalogVariantId ?? null, systemVehicleClass: model.systemVehicleClass ?? null, tenantClass });
  return {
    pack: {
      ...pack,
      customers: pack.customers.map((customer) => customer.id === owner.id ? { ...customer, vehicles: [...customer.vehicles, vehicle] } : customer),
      vehicleClasses: { ...pack.vehicleClasses, [id]: vehicleClass }
    },
    vehicle
  };
}
