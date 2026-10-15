CREATE TABLE IF NOT EXISTS vehicle_pricing_overrides (
  vehicle_id TEXT PRIMARY KEY REFERENCES vehicles(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  tenant_class TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE INDEX IF NOT EXISTS idx_vehicle_pricing_overrides_tenant
  ON vehicle_pricing_overrides(tenant_id, tenant_class);
