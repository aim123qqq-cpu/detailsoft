PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS order_assignments (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  master_name TEXT NOT NULL,
  assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE IF NOT EXISTS order_work_runs (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  status TEXT NOT NULL CHECK(status IN ('ACTIVE', 'PAUSED', 'COMPLETED')),
  pause_note TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS order_work_operations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  estimate_line_id TEXT REFERENCES estimate_lines(id),
  source TEXT NOT NULL CHECK(source IN ('estimate', 'qc_rework')),
  sequence INTEGER NOT NULL,
  name TEXT NOT NULL,
  amount_minor INTEGER NOT NULL DEFAULT 0 CHECK(amount_minor >= 0),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'DONE', 'BLOCKED')),
  note TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE IF NOT EXISTS qc_inspections (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  decision TEXT NOT NULL CHECK(decision IN ('PASSED', 'REWORK')),
  responsible TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE IF NOT EXISTS qc_check_items (
  id TEXT PRIMARY KEY,
  inspection_id TEXT NOT NULL REFERENCES qc_inspections(id),
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  passed INTEGER NOT NULL CHECK(passed IN (0, 1))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_work_operations_order
  ON order_work_operations(tenant_id, order_id, sequence);
CREATE INDEX IF NOT EXISTS idx_qc_inspections_order
  ON qc_inspections(tenant_id, order_id, created_at);
