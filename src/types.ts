export type Vehicle = {
  id: string;
  catalogVariantId?: string | null;
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
  archived?: boolean;
  vehicles: Vehicle[];
};

export type CustomerMatch = { id: string; name: string; phoneDisplay: string; archived: boolean };

type VehicleSummary = Pick<Vehicle, 'id' | 'make' | 'model' | 'generation' | 'plate' | 'color'>;

export type CustomerProfile = {
  customer: { id: string; name: string; phoneDisplay: string; archived: boolean; archivedAt: string | null; createdAt: string };
  stats: { bookings: number; openBookings: number; orders: number; activeOrders: number; closedOrders: number; lastVisitAt: string | null };
  vehicles: Array<Vehicle & { relationType: string; ownedFrom: string }>;
  formerVehicles: Array<{
    linkId: string;
    relationType: string;
    validFrom: string;
    validTo: string;
    vehicle: Vehicle;
    currentOwner: null | { id: string; name: string };
  }>;
  bookings: Array<{
    id: string;
    status: BookingStatus;
    startAt: string;
    estimatedDurationMinutes: number;
    preliminaryAmountMinor: number;
    orderId: string | null;
    vehicle: VehicleSummary;
  }>;
  orders: Array<{
    id: string;
    status: WorkOrder['status'];
    createdAt: string;
    closedAt: string | null;
    totalAmountMinor: number | null;
    vehicle: VehicleSummary;
  }>;
  phoneDuplicates: CustomerMatch[];
  audit: Array<{
    id: string;
    type: 'CUSTOMER_UPDATED' | 'CUSTOMER_ARCHIVED' | 'CUSTOMER_REACTIVATED';
    details: {
      changes?: { name?: { from: string; to: string }; phone?: { from: string; to: string } };
      duplicateAcknowledged?: string[];
    };
    actorName: string | null;
    createdAt: string;
  }>;
};

export type VehicleProfile = {
  vehicle: Vehicle;
  currentOwner: null | { id: string; name: string; phoneDisplay: string };
  ownership: Array<{
    linkId: string;
    relationType: 'owner';
    validFrom: string;
    validTo: string | null;
    active: boolean;
    customer: { id: string; name: string; phoneDisplay: string };
  }>;
  visits: Array<{
    id: string;
    status: string;
    createdAt: string;
    customer: { id: string; name: string };
  }>;
  audit: Array<{
    id: string;
    type: 'OWNER_TRANSFERRED' | 'VEHICLE_STATUS_CHANGED';
    details: Record<string, unknown>;
    createdAt: string;
  }>;
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
  actor: { displayName: string; roles: string[]; roleNames: string[]; memberId: string | null; authMethod: 'demo' | 'messenger' | 'access_token' };
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
    acceptAssignments: boolean;
    performQualityControl: boolean;
    closeOrders: boolean;
    manageCatalog: boolean;
    manageSettings: boolean;
    manageTeam: boolean;
    viewAnalytics: boolean;
  };
};

/** System role key (owner, admin, intake, master) or a custom role key role_<uuid>. */
export type TeamRole = string;

export type Permission = { key: string; title: string; note: string };

export type CenterRole = {
  key: string;
  name: string;
  system: boolean;
  /** The owner role: full access, not editable. */
  locked: boolean;
  archived: boolean;
  permissions: string[];
  memberCount: number;
};

export type TeamMember = {
  id: string;
  displayName: string;
  roles: TeamRole[];
  status: 'active' | 'blocked';
  createdAt: string;
  updatedAt: string;
  messengerLinks?: MessengerLink[];
};

export type MessengerProvider = 'telegram' | 'max';
export type MessengerLink = { id: string; memberId: string; provider: MessengerProvider; externalName: string | null; linkedAt: string };
export type AuthProvider = { provider: MessengerProvider; title: string; botName: string | null };
export type LoginRequest = {
  id: string;
  provider: MessengerProvider;
  shortCode: string;
  pollSecret: string;
  expiresAt: string;
  botName: string | null;
  deepLink: string | null;
};
export type LoginMembership = { tenant: { id: string; name: string }; member: { id: string; displayName: string; roles: string[] } };
export type LoginStatus = {
  id: string;
  provider: MessengerProvider;
  status: 'PENDING' | 'AWAITING_CONFIRMATION' | 'CONFIRMED' | 'DENIED' | 'CONSUMED' | 'EXPIRED';
  expiresAt: string;
  memberships: LoginMembership[];
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

export type CatalogUsageItem = { id: string; name: string; active: boolean };
export type CatalogOperation = {
  id: string;
  name: string;
  active: boolean;
  usage: { services: CatalogUsageItem[]; packages: CatalogUsageItem[]; activeCount: number };
};

export type ManagedCatalog = {
  vehicleClasses: string[];
  operationLibrary: Array<{ id: string; name: string; active: boolean }>;
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
  quoteVersion: number;
  lines: QuoteLine[];
  quoteVersions: BookingQuoteVersion[];
};

export type BookingQuoteVersion = {
  version: number;
  vehicleClass: string | null;
  totalAmountMinor: number;
  totalDurationMinutes: number;
  reason: string | null;
  actorName: string | null;
  createdAt: string;
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
  assignment: null | { masterName: string; memberId: string | null; assignedAt: string };
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
  documents: OrderDocumentSummary[];
};

export type OrderDocumentType = 'intake_act' | 'handover_act';

export type OrderDocumentSummary = {
  id: string;
  type: OrderDocumentType;
  number: string;
  signed: boolean;
  signerName: string | null;
  signedAt: string | null;
  actorName: string | null;
  createdAt: string;
  current: boolean;
  outdated: boolean;
};

export type OrderDocumentContent = {
  title: string;
  center: { name: string };
  order: { id: string; number: string; createdAt: string };
  customer: { name: string; phoneDisplay: string };
  vehicle: { make: string; model: string; generation: string | null; plate: string; color: string };
  statement: string;
  intake?: {
    conditionSummary: string;
    completedAt: string;
    findings: Array<{ zone: string; severity: IntakeFinding['severity']; note: string }>;
    recommendations: Array<{ title: string; reason: string; priority: OrderRecommendation['priority'] }>;
    photoCount: number;
  };
  estimate?: null | { version: number; totalAmountMinor: number; approvedAt: string | null; approvalMethod: string | null; approvedBy: string | null };
  works?: Array<{ name: string; amountMinor: number; status: string }>;
  handover?: null | { responsible: string; note: string; handedOverAt: string };
  photos?: { intake: number; result: number };
};

export type OrderDocument = OrderDocumentSummary & { content: OrderDocumentContent; signatureDataUrl: string | null };

/** Opening the order workspace from Bookings or Orders: `id` is the booking; `orderId` is null for a new intake. */
export type OrderTarget = { id: string; orderId: string | null; customer: Customer; vehicle: Vehicle };

export type OrderListItem = {
  id: string;
  status: WorkOrder['status'];
  createdAt: string;
  totalAmountMinor: number | null;
  masterName: string | null;
  masterMemberId: string | null;
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
