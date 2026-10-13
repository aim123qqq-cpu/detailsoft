PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Europe/Moscow'
) STRICT;

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  phone_display TEXT NOT NULL,
  phone_normalized TEXT NOT NULL,
  visit_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  archived_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_customers_tenant_phone
  ON customers(tenant_id, phone_normalized);

CREATE TABLE IF NOT EXISTS vehicle_catalog_variants (
  id TEXT PRIMARY KEY,
  make TEXT NOT NULL,
  model TEXT NOT NULL,
  generation TEXT,
  year_from INTEGER,
  year_to INTEGER,
  body_type TEXT NOT NULL,
  system_vehicle_class TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS vehicles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  catalog_variant_id TEXT REFERENCES vehicle_catalog_variants(id),
  make TEXT NOT NULL,
  model TEXT NOT NULL,
  generation TEXT,
  body_type TEXT,
  plate_display TEXT NOT NULL,
  plate_normalized TEXT NOT NULL,
  color TEXT NOT NULL,
  system_vehicle_class TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'inactive', 'sold')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  archived_at TEXT
) STRICT;

-- Intentionally non-unique: plates can be reissued or changed. The API performs
-- tenant-scoped duplicate detection and requires an explicit user decision.
CREATE INDEX IF NOT EXISTS idx_vehicles_tenant_plate
  ON vehicles(tenant_id, plate_normalized);

CREATE TABLE IF NOT EXISTS customer_vehicles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  relation_type TEXT NOT NULL DEFAULT 'owner'
    CHECK(relation_type IN ('owner', 'driver', 'contact', 'other')),
  valid_from TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  valid_to TEXT,
  is_primary INTEGER NOT NULL DEFAULT 1 CHECK(is_primary IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE INDEX IF NOT EXISTS idx_customer_vehicles_active_customer
  ON customer_vehicles(tenant_id, customer_id, valid_to);
CREATE INDEX IF NOT EXISTS idx_customer_vehicles_active_vehicle
  ON customer_vehicles(tenant_id, vehicle_id, valid_to);

CREATE TABLE IF NOT EXISTS tenant_vehicle_class_rules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  variant_id TEXT REFERENCES vehicle_catalog_variants(id),
  class_match TEXT,
  tenant_class TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
