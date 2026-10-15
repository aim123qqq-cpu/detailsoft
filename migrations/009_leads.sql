PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  customer_id TEXT REFERENCES customers(id),
  channel TEXT NOT NULL CHECK(channel IN ('telegram', 'vk', 'instagram', 'call', 'in_person')),
  status TEXT NOT NULL DEFAULT 'NEW' CHECK(status IN ('NEW', 'CONTACTED', 'CONVERTED', 'LOST')),
  contact_name TEXT NOT NULL,
  phone_display TEXT NOT NULL,
  phone_normalized TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE IF NOT EXISTS lead_bookings (
  lead_id TEXT PRIMARY KEY REFERENCES leads(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  booking_id TEXT NOT NULL UNIQUE REFERENCES bookings(id),
  converted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE INDEX IF NOT EXISTS idx_leads_tenant_status
  ON leads(tenant_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_leads_tenant_phone
  ON leads(tenant_id, phone_normalized);
