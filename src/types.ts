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

export type BookingListItem = {
  id: string;
  channel: string;
  startAt: string;
  estimatedDurationMinutes: number;
  status: Booking['status'];
  preliminaryAmountMinor: number;
  customer: Pick<Customer, 'id' | 'name' | 'phoneDisplay'>;
  vehicle: Pick<Vehicle, 'id' | 'make' | 'model' | 'generation' | 'plate' | 'color'>;
};

export type IntakeFinding = {
  id?: string;
  zone: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  note: string;
};

export type OrderRecommendation = {
  id?: string;
  title: string;
  reason: string;
  priority: 'OPTIONAL' | 'RECOMMENDED' | 'URGENT';
};

export type EstimateLineInput = {
  sourceType: 'service' | 'package' | 'recommendation' | 'custom';
  sourceId?: string | null;
  name: string;
  amountMinor: number;
  durationMinutes: number;
  reason?: string | null;
};

export type EstimateVersion = {
  id: string;
  orderId: string;
  version: number;
  totalAmountMinor: number;
  totalDurationMinutes: number;
  createdAt: string;
  lines: Array<EstimateLineInput & { id: string }>;
};

export type WorkOrder = {
  id: string;
  bookingId: string | null;
  customerId: string;
  vehicleId: string;
  status: 'INTAKE' | 'ESTIMATE_DRAFT' | 'APPROVED' | 'IN_PROGRESS' | 'QC' | 'READY' | 'CLOSED';
  currentEstimateVersionId: string | null;
  intake: null | {
    conditionSummary: string;
    completedAt: string;
    findings: IntakeFinding[];
    recommendations: OrderRecommendation[];
  };
  estimateVersions: EstimateVersion[];
  approval: null | {
    estimateVersionId: string;
    decision: 'APPROVED' | 'REJECTED';
    method: 'in_person' | 'phone' | 'messenger';
    source: string;
    responsible: string;
    decidedAt: string;
  };
  assignment: null | { masterName: string; assignedAt: string };
  work: null | {
    status: 'ACTIVE' | 'PAUSED' | 'COMPLETED';
    pauseNote: string | null;
    startedAt: string;
    updatedAt: string;
    completedAt: string | null;
    operations: Array<{
      id: string;
      source: 'estimate' | 'qc_rework';
      name: string;
      amountMinor: number;
      status: 'PENDING' | 'DONE' | 'BLOCKED';
      note: string | null;
      updatedAt: string;
    }>;
  };
  qualityControl: Array<{
    id: string;
    decision: 'PASSED' | 'REWORK';
    responsible: string;
    note: string;
    createdAt: string;
    checks: Array<{ code: string; label: string; passed: boolean }>;
  }>;
  handover: null | {
    responsible: string;
    note: string;
    handedOverAt: string;
  };
  auditTrail: Array<{ eventType: string; occurredAt: string; metadata: Record<string, unknown> }>;
};

export type OrderListItem = {
  id: string;
  status: WorkOrder['status'];
  createdAt: string;
  totalAmountMinor: number | null;
  masterName: string | null;
  customer: Pick<Customer, 'id' | 'name' | 'phoneDisplay'>;
  vehicle: Pick<Vehicle, 'id' | 'make' | 'model' | 'generation' | 'plate' | 'color'>;
};
