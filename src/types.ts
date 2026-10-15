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

export type LeadStatus = 'NEW' | 'CONTACTED' | 'CONVERTED' | 'LOST';

export type Lead = {
  id: string;
  channel: 'telegram' | 'vk' | 'instagram' | 'call' | 'in_person';
  status: LeadStatus;
  contactName: string;
  phoneDisplay: string;
  note: string;
  createdAt: string;
  updatedAt: string;
  bookingId: string | null;
  customer: null | { id: string; name: string };
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

export type SessionContext = {
  actor: { displayName: string; roles: string[] };
  tenant: { id: string; name: string; timezone: string };
  preferences: { locale: string; currency: string };
  features: { qualityControl: boolean };
  capabilities: {
    manageCustomers: boolean;
    manageBookings: boolean;
    manageIntake: boolean;
    approveEstimates: boolean;
    assignMasters: boolean;
    performWork: boolean;
    performQualityControl: boolean;
    closeOrders: boolean;
    manageCatalog: boolean;
    manageSettings: boolean;
    viewAnalytics: boolean;
  };
};

export type CenterSettings = {
  timezone: string;
  workingDays: number[];
  openTime: string;
  closeTime: string;
  slotStepMinutes: 15 | 30 | 60 | 90 | 120;
  simultaneousCapacity: number;
};

export type CatalogPrice = {
  tenantClass: string;
  amountMinor: number;
  durationMinutes: number;
};

export type ManagedCatalogItem = {
  id: string;
  type: 'service' | 'package';
  category: string;
  name: string;
  description: string;
  pricingMode: 'fixed' | 'from' | 'inspection';
  active: boolean;
  operations: Array<{ id: string; name: string; prices?: CatalogPrice[] }>;
  prices?: CatalogPrice[];
};

export type ManagedCatalog = {
  vehicleClasses: string[];
  items: ManagedCatalogItem[];
};

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

export type BookingStatus = 'DRAFT' | 'CONFIRMED' | 'ARRIVED' | 'CANCELLED' | 'NO_SHOW';

export type Booking = {
  id: string;
  leadId: string | null;
  customerId: string;
  vehicleId: string;
  channel: string;
  startAt: string;
  timezone: string;
  estimatedDurationMinutes: number;
  status: BookingStatus;
  preliminaryAmountMinor: number;
  resourceId: string | null;
  lines: QuoteLine[];
};

export type BookingAvailability = {
  date: string;
  durationMinutes: number;
  closed: boolean;
  slots: Array<{ time: string; startAt: string; available: boolean }>;
};

export type BookingListItem = {
  id: string;
  channel: string;
  startAt: string;
  estimatedDurationMinutes: number;
  status: Booking['status'];
  preliminaryAmountMinor: number;
  orderId: string | null;
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

export type PhotoAsset = {
  id: string;
  phase: 'intake' | 'result';
  kind: 'intake' | 'defect';
  zone: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  dataUrl: string;
  createdAt: string;
};

export type WorkOrder = {
  id: string;
  createdAt: string;
  bookingId: string | null;
  customerId: string;
  vehicleId: string;
  status: 'INTAKE' | 'ESTIMATE_DRAFT' | 'APPROVED' | 'IN_PROGRESS' | 'QC' | 'READY' | 'CLOSED';
  currentEstimateVersionId: string | null;
  photos: PhotoAsset[];
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

export type AnalyticsOverview = {
  period: { from: string; to: string };
  bookings: { total: number; confirmed: number; cancelled: number };
  orders: {
    total: number;
    active: number;
    ready: number;
    closed: number;
    approvedEstimateAmountMinor: number;
    averageApprovedEstimateAmountMinor: number;
  };
  operations: { total: number; done: number; blocked: number; completionPercent: number };
  orderStatuses: Array<{ status: WorkOrder['status']; count: number }>;
  daily: Array<{ date: string; bookings: number; orders: number; closed: number }>;
};
