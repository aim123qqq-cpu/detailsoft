export type Vehicle = {
  id: string;
  make: string;
  model: string;
  generation?: string | null;
  bodyType?: string | null;
  plate: string;
  color: string;
  status: 'active' | 'inactive' | 'sold';
  active: boolean;
  tenantClass?: string | null;
};

export type Customer = {
  id: string;
  name: string;
  phoneDisplay: string;
  visitCount: number;
  vehicles: Vehicle[];
};

export type CatalogVariant = {
  id: string;
  make: string;
  model: string;
  generation?: string | null;
  yearFrom?: number | null;
  yearTo?: number | null;
  bodyType: string;
  systemVehicleClass?: string | null;
};

export type ApiError = { error: { code: string; message: string } };

export type ServiceOperation = { id: string; name: string };

export type ServiceOffering = {
  id: string;
  type: 'service' | 'package';
  category: string;
  name: string;
  description: string;
  pricingMode: 'fixed' | 'from' | 'inspection';
  price: { amountMinor: number; label: string };
  durationMinutes: number;
  operations: ServiceOperation[];
};

export type ServiceCatalog = {
  vehicleClass: string;
  categories: Array<{ name: string; items: ServiceOffering[] }>;
};

export type QuoteSelection = { type: 'service' | 'package'; id: string };

export type QuoteLine = {
  id: string;
  type: 'service' | 'package';
  name: string;
  amountMinor: number;
  durationMinutes: number;
  operations: ServiceOperation[];
  excludedOperations: ServiceOperation[];
  excluded: boolean;
  pricingMode: 'fixed' | 'from' | 'inspection';
};

export type BookingQuote = {
  preliminary: true;
  vehicleClass: string;
  lines: QuoteLine[];
  totalAmountMinor: number;
  totalDurationMinutes: number;
  warnings: Array<{ code: string; message: string; itemId: string }>;
};

export type Booking = {
  id: string;
  customerId: string;
  vehicleId: string;
  channel: string;
  startAt: string;
  timezone: string;
  estimatedDurationMinutes: number;
  status: 'CONFIRMED';
  preliminaryAmountMinor: number;
  resourceId: string | null;
  lines: QuoteLine[];
};

export type BookingAvailability = {
  date: string;
  durationMinutes: number;
  slots: Array<{ time: string; startAt: string; available: boolean }>;
};
