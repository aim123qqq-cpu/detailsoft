PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tenant_operating_settings (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
  working_days_json TEXT NOT NULL DEFAULT '[0,1,2,3,4,5,6]',
  open_time TEXT NOT NULL DEFAULT '09:00',
  close_time TEXT NOT NULL DEFAULT '20:00',
  slot_step_minutes INTEGER NOT NULL DEFAULT 30 CHECK(slot_step_minutes IN (15, 30, 60, 90, 120)),
  simultaneous_capacity INTEGER NOT NULL DEFAULT 1 CHECK(simultaneous_capacity BETWEEN 1 AND 20),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
