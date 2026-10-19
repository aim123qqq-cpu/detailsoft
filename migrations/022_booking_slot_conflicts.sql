PRAGMA foreign_keys = ON;

-- A booking made offline whose time was taken on the server meanwhile is kept, not refused,
-- and marked here until it is moved to a free time or cancelled.
CREATE TABLE IF NOT EXISTS booking_slot_conflicts (
  booking_id TEXT PRIMARY KEY REFERENCES bookings(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  detected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_booking_slot_conflicts_open
  ON booking_slot_conflicts(tenant_id, resolved_at);
