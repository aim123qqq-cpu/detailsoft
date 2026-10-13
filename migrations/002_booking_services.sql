CREATE TABLE IF NOT EXISTS service_operations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1))
) STRICT;

CREATE TABLE IF NOT EXISTS tenant_services (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  pricing_mode TEXT NOT NULL DEFAULT 'fixed'
    CHECK(pricing_mode IN ('fixed', 'from', 'inspection')),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1))
) STRICT;

CREATE TABLE IF NOT EXISTS tenant_service_operations (
  service_id TEXT NOT NULL REFERENCES tenant_services(id),
  operation_id TEXT NOT NULL REFERENCES service_operations(id),
  sequence INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (service_id, operation_id)
) STRICT;

CREATE TABLE IF NOT EXISTS service_operation_prices (
  service_id TEXT NOT NULL REFERENCES tenant_services(id),
  operation_id TEXT NOT NULL REFERENCES service_operations(id),
  tenant_class TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK(amount_minor >= 0),
  duration_minutes INTEGER NOT NULL CHECK(duration_minutes > 0),
  PRIMARY KEY (service_id, operation_id, tenant_class)
) STRICT;

CREATE TABLE IF NOT EXISTS service_packages (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1))
) STRICT;

CREATE TABLE IF NOT EXISTS service_package_operations (
  package_id TEXT NOT NULL REFERENCES service_packages(id),
  operation_id TEXT NOT NULL REFERENCES service_operations(id),
  sequence INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (package_id, operation_id)
) STRICT;

CREATE TABLE IF NOT EXISTS service_package_prices (
  package_id TEXT NOT NULL REFERENCES service_packages(id),
  tenant_class TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK(amount_minor >= 0),
  duration_minutes INTEGER NOT NULL CHECK(duration_minutes > 0),
  PRIMARY KEY (package_id, tenant_class)
) STRICT;

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  channel TEXT NOT NULL CHECK(channel IN ('telegram', 'vk', 'instagram', 'call', 'in_person')),
  start_at TEXT NOT NULL,
  estimated_duration_minutes INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'CONFIRMED'
    CHECK(status IN ('DRAFT', 'CONFIRMED', 'ARRIVED', 'CANCELLED', 'NO_SHOW')),
  preliminary_amount_minor INTEGER NOT NULL,
  resource_id TEXT,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, idempotency_key)
) STRICT;

CREATE TABLE IF NOT EXISTS tenant_booking_settings (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
  simultaneous_capacity INTEGER NOT NULL DEFAULT 1 CHECK(simultaneous_capacity > 0)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_bookings_tenant_start
  ON bookings(tenant_id, start_at);

CREATE TABLE IF NOT EXISTS booking_quote_lines (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  item_type TEXT NOT NULL CHECK(item_type IN ('service', 'package')),
  item_id TEXT NOT NULL,
  name TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  duration_minutes INTEGER NOT NULL,
  operations_json TEXT NOT NULL,
  excluded_operations_json TEXT NOT NULL
) STRICT;
