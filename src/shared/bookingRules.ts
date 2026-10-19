/**
 * Booking rules shared by the server (server/repository.mjs) and the app working offline:
 * the same code decides free time and computes a booking quote on both sides.
 */

export type CenterSchedule = {
  timezone: string;
  workingDays: number[];
  openTime: string;
  closeTime: string;
  slotStepMinutes: number;
  simultaneousCapacity: number;
};

/** A confirmed booking that occupies capacity. */
export type BusyBooking = { id: string; startAt: string; durationMinutes: number };

export function timeToMinutes(value: unknown) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value ?? ''));
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
}

export function minutesToTime(value: number) {
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

/** "2026-12-28" + "10:00" in the center's time zone → "2026-12-28T10:00:00+03:00". */
export function localDateTime(date: string, time: string, timezone: string) {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(utcGuess));
  const part = (type: string) => Number(parts.find((entry) => entry.type === type)?.value);
  const representedUtc = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'));
  const offsetMinutes = Math.round((representedUtc - utcGuess) / 60_000);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
  return `${date}T${time}:00${offset}`;
}

export function localBookingParts(startAt: string, timezone: string) {
  const date = new Date(startAt);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const part = (type: string) => Number(parts.find((entry) => entry.type === type)?.value);
  return {
    dayOfWeek: new Date(Date.UTC(part('year'), part('month') - 1, part('day'))).getUTCDay(),
    minuteOfDay: part('hour') * 60 + part('minute')
  };
}

/** Within working hours, on the slot grid, and below the center's simultaneous capacity. */
export function isSlotAvailable(schedule: CenterSchedule, bookings: BusyBooking[], startAt: string, durationMinutes: number, excludeBookingId: string | null = null) {
  const start = Date.parse(startAt);
  if (!Number.isFinite(start) || !Number.isInteger(durationMinutes) || durationMinutes <= 0) return false;
  const local = localBookingParts(startAt, schedule.timezone);
  const openMinutes = timeToMinutes(schedule.openTime);
  const closeMinutes = timeToMinutes(schedule.closeTime);
  if (!local || openMinutes === null || closeMinutes === null || !schedule.workingDays.includes(local.dayOfWeek) ||
    local.minuteOfDay < openMinutes || local.minuteOfDay + durationMinutes > closeMinutes ||
    (local.minuteOfDay - openMinutes) % schedule.slotStepMinutes !== 0) return false;
  const end = start + durationMinutes * 60_000;
  const overlapping = bookings.filter((booking) => {
    if (booking.id === excludeBookingId) return false;
    const bookingStart = Date.parse(booking.startAt);
    return bookingStart < end && bookingStart + booking.durationMinutes * 60_000 > start;
  }).length;
  return overlapping < schedule.simultaneousCapacity;
}

export function availabilityForDate(schedule: CenterSchedule, bookings: BusyBooking[], date: string, durationMinutes: number) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 720) {
    return { kind: 'invalid' as const };
  }
  const [year, month, day] = date.split('-').map(Number);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (calendarDate.toISOString().slice(0, 10) !== date) return { kind: 'invalid' as const };
  if (!schedule.workingDays.includes(calendarDate.getUTCDay())) {
    return { kind: 'available' as const, date, durationMinutes, closed: true, slots: [] };
  }
  const openMinutes = timeToMinutes(schedule.openTime) ?? 0;
  const closeMinutes = timeToMinutes(schedule.closeTime) ?? 0;
  const slots = [];
  for (let minute = openMinutes; minute + durationMinutes <= closeMinutes; minute += schedule.slotStepMinutes) {
    const time = minutesToTime(minute);
    const startAt = localDateTime(date, time, schedule.timezone);
    slots.push({ time, startAt, available: isSlotAvailable(schedule, bookings, startAt, durationMinutes) });
  }
  return { kind: 'available' as const, date, durationMinutes, closed: false, slots };
}

export type PricingMode = 'fixed' | 'from' | 'inspection';

export function formatMoney(amountMinor: number, prefix = '') {
  const rubles = String(Math.round(amountMinor / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${prefix}${rubles} ₽`;
}

export function priceLabel(amountMinor: number, pricingMode: PricingMode) {
  return pricingMode === 'inspection' ? 'После осмотра' : formatMoney(amountMinor, pricingMode === 'from' ? 'от ' : '');
}

type Operation = { id: string; name: string };
/** A package priced for the vehicle's class. */
export type PricedPackage = { id: string; name: string; amountMinor: number; durationMinutes: number; operations: Operation[] };
/** A service with each operation priced for the vehicle's class; operationCount is how many it has in total. */
export type PricedService = {
  id: string; name: string; pricingMode: PricingMode; operationCount: number;
  operations: Array<Operation & { amountMinor: number; durationMinutes: number }>;
};
export type QuoteSelection = { type: 'service' | 'package'; id: string };

/**
 * Preliminary quote: packages first; a service pays only for operations not already in a chosen
 * package. Lookups return null for an unknown or inactive item (or one without a price).
 */
export function computeQuote(rawSelections: unknown, findPackage: (id: string) => PricedPackage | null, findService: (id: string) => PricedService | null) {
  if (!Array.isArray(rawSelections) || rawSelections.length === 0 || rawSelections.length > 20) return { kind: 'invalid' as const };
  const selections = [...new Map(rawSelections.map((selection) => [`${selection?.type}:${selection?.id}`, selection])).values()] as QuoteSelection[];
  if (selections.some((selection) => !['service', 'package'].includes(selection?.type) || typeof selection?.id !== 'string')) return { kind: 'invalid' as const };

  const lines = [];
  const warnings: Array<{ code: string; message: string; itemId: string }> = [];
  const packageOperations = new Set<string>();
  for (const selection of selections.filter((item) => item.type === 'package')) {
    const priced = findPackage(selection.id);
    if (!priced) return { kind: 'not_found' as const, resource: 'offering' };
    if (priced.operations.some((operation) => packageOperations.has(operation.id))) {
      return { kind: 'conflict' as const, code: 'package_overlap', message: 'Выбранные пакеты содержат одинаковые операции' };
    }
    for (const operation of priced.operations) packageOperations.add(operation.id);
    lines.push({
      id: priced.id, type: 'package' as const, name: priced.name, amountMinor: priced.amountMinor, durationMinutes: priced.durationMinutes,
      operations: priced.operations, excludedOperations: [] as Operation[], excluded: false, pricingMode: 'fixed' as PricingMode
    });
  }
  for (const selection of selections.filter((item) => item.type === 'service')) {
    const service = findService(selection.id);
    if (!service) return { kind: 'not_found' as const, resource: 'offering' };
    if (!service.operations.length || service.operations.length !== service.operationCount) return { kind: 'not_found' as const, resource: 'price' };
    const excludedOperations = service.operations.filter((operation) => packageOperations.has(operation.id));
    const billable = service.operations.filter((operation) => !packageOperations.has(operation.id));
    if (excludedOperations.length) warnings.push({ code: 'package_overlap', message: `${service.name}: операции из пакета исключены из повторной оплаты`, itemId: service.id });
    if (service.pricingMode !== 'fixed') warnings.push({ code: 'price_requires_inspection', message: `${service.name}: окончательная цена определяется после осмотра`, itemId: service.id });
    lines.push({
      id: service.id, type: 'service' as const, name: service.name,
      amountMinor: billable.reduce((sum, operation) => sum + operation.amountMinor, 0),
      durationMinutes: billable.reduce((sum, operation) => sum + operation.durationMinutes, 0),
      operations: service.operations.map(({ id, name }) => ({ id, name })),
      excludedOperations: excludedOperations.map(({ id, name }) => ({ id, name })),
      excluded: billable.length === 0,
      pricingMode: service.pricingMode
    });
  }
  return {
    kind: 'quoted' as const,
    lines,
    totalAmountMinor: lines.reduce((sum, line) => sum + line.amountMinor, 0),
    totalDurationMinutes: lines.reduce((sum, line) => sum + line.durationMinutes, 0),
    warnings
  };
}
