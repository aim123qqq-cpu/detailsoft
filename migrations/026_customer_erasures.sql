PRAGMA foreign_keys = ON;

-- A customer's request to destroy their personal data (152-FZ art. 21): the center erases them, the
-- orders stay as anonymous work records. This table proves the request was fulfilled — when and by
-- whom — and holds no personal data itself.
CREATE TABLE IF NOT EXISTS customer_erasures (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  erased_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actor_name TEXT,
  orders INTEGER NOT NULL,
  documents INTEGER NOT NULL,
  photos INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, customer_id)
) STRICT;
