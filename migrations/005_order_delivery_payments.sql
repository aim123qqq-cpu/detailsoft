PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS order_payments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
  method TEXT NOT NULL CHECK(method IN ('cash', 'card', 'transfer')),
  responsible TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, idempotency_key)
) STRICT;

CREATE TABLE IF NOT EXISTS order_handovers (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  responsible TEXT NOT NULL,
  note TEXT NOT NULL,
  handed_over_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE INDEX IF NOT EXISTS idx_order_payments_order
  ON order_payments(tenant_id, order_id, created_at);
