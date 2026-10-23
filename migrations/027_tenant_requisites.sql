PRAGMA foreign_keys = ON;

-- The center as the contractor in its documents: the rules for car service (Government Decree No. 780
-- of 29.05.2025) and consumer law want the contractor's name, registration numbers and address on
-- the papers a customer gets. Filled in by the owner; empty fields are simply not printed.
CREATE TABLE IF NOT EXISTS tenant_requisites (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
  legal_name TEXT NOT NULL DEFAULT '',
  inn TEXT NOT NULL DEFAULT '',
  ogrn TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  warranty TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
