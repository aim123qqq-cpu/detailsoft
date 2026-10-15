CREATE TABLE IF NOT EXISTS vehicle_audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  event_type TEXT NOT NULL CHECK(event_type IN ('OWNER_TRANSFERRED', 'VEHICLE_STATUS_CHANGED')),
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE INDEX IF NOT EXISTS idx_vehicle_audit_events_vehicle
  ON vehicle_audit_events(tenant_id, vehicle_id, created_at DESC);
