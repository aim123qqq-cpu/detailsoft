PRAGMA foreign_keys = ON;

-- Kept beside the original orders table so existing installations and historic
-- orders remain readable without a destructive ALTER TABLE migration.
CREATE TABLE IF NOT EXISTS order_workflows (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  current_estimate_version_id TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, booking_id)
) STRICT;

CREATE TABLE IF NOT EXISTS order_intakes (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  condition_summary TEXT NOT NULL,
  completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE IF NOT EXISTS inspection_findings (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  zone TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('LOW', 'MEDIUM', 'HIGH')),
  note TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE IF NOT EXISTS order_recommendations (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  title TEXT NOT NULL,
  reason TEXT NOT NULL,
  priority TEXT NOT NULL CHECK(priority IN ('OPTIONAL', 'RECOMMENDED', 'URGENT')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE IF NOT EXISTS estimate_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  version INTEGER NOT NULL,
  total_amount_minor INTEGER NOT NULL CHECK(total_amount_minor >= 0),
  total_duration_minutes INTEGER NOT NULL CHECK(total_duration_minutes >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(order_id, version)
) STRICT;

CREATE TABLE IF NOT EXISTS estimate_lines (
  id TEXT PRIMARY KEY,
  estimate_version_id TEXT NOT NULL REFERENCES estimate_versions(id),
  sequence INTEGER NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('service', 'package', 'recommendation', 'custom')),
  source_id TEXT,
  name TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK(amount_minor >= 0),
  duration_minutes INTEGER NOT NULL CHECK(duration_minutes >= 0),
  reason TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS estimate_approvals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  estimate_version_id TEXT NOT NULL REFERENCES estimate_versions(id),
  decision TEXT NOT NULL CHECK(decision IN ('APPROVED', 'REJECTED')),
  method TEXT NOT NULL CHECK(method IN ('in_person', 'phone', 'messenger')),
  source TEXT NOT NULL,
  responsible TEXT NOT NULL,
  decided_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE IF NOT EXISTS order_audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  event_type TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE INDEX IF NOT EXISTS idx_order_workflows_tenant_booking
  ON order_workflows(tenant_id, booking_id);
CREATE INDEX IF NOT EXISTS idx_findings_order ON inspection_findings(order_id);
CREATE INDEX IF NOT EXISTS idx_recommendations_order ON order_recommendations(order_id);
CREATE INDEX IF NOT EXISTS idx_estimate_versions_order ON estimate_versions(order_id, version);
CREATE INDEX IF NOT EXISTS idx_order_audit ON order_audit_events(order_id, occurred_at);
