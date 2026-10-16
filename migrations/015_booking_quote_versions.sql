-- Versioned booking composition. booking_quote_lines stays the untouched original
-- snapshot; the first revision copies it here as version 1, and every later change
-- appends a new immutable version. bookings keeps only the current totals.
CREATE TABLE IF NOT EXISTS booking_quote_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  version INTEGER NOT NULL CHECK(version > 0),
  vehicle_class TEXT,
  total_amount_minor INTEGER NOT NULL,
  total_duration_minutes INTEGER NOT NULL,
  lines_json TEXT NOT NULL,
  reason TEXT,
  actor_name TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (booking_id, version)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_booking_quote_versions_booking
  ON booking_quote_versions(tenant_id, booking_id, version);
