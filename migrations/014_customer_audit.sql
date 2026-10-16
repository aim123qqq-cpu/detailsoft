-- Customer profile maintenance: contact edits and explicit archive/reactivation are
-- audited here. Rows are append-only; customers, vehicle links, bookings and orders
-- are never rewritten by these events.
CREATE TABLE IF NOT EXISTS customer_audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  event_type TEXT NOT NULL
    CHECK(event_type IN ('CUSTOMER_UPDATED', 'CUSTOMER_ARCHIVED', 'CUSTOMER_REACTIVATED')),
  details_json TEXT NOT NULL DEFAULT '{}',
  actor_name TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE INDEX IF NOT EXISTS idx_customer_audit_events_customer
  ON customer_audit_events(tenant_id, customer_id, created_at DESC);
