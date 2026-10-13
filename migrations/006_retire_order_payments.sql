PRAGMA foreign_keys = ON;

-- Payment handling was removed from the product. Preserve any rows written by
-- the short-lived prototype while removing the active table from the runtime.
CREATE TABLE IF NOT EXISTS retired_order_payments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  method TEXT NOT NULL,
  responsible TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

INSERT OR IGNORE INTO retired_order_payments
  (id, tenant_id, order_id, amount_minor, method, responsible, idempotency_key, created_at)
SELECT id, tenant_id, order_id, amount_minor, method, responsible, idempotency_key, created_at
FROM order_payments;

DROP TABLE IF EXISTS order_payments;
