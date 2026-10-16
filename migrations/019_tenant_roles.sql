PRAGMA foreign_keys = ON;

-- Roles of a center. System roles (owner, admin, intake, master) live in code with default
-- permissions; a row here overrides their permissions. Custom roles use keys role_<uuid>.
-- tenant_members.roles_json keeps role keys, so existing members need no data migration.
CREATE TABLE IF NOT EXISTS tenant_roles (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  permissions_json TEXT NOT NULL,
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, key)
) STRICT;

CREATE TABLE IF NOT EXISTS tenant_role_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  role_key TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('ROLE_CREATED', 'ROLE_UPDATED', 'ROLE_ARCHIVED', 'ROLE_RESTORED')),
  actor_name TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE INDEX IF NOT EXISTS idx_tenant_role_events_role
  ON tenant_role_events(tenant_id, role_key, created_at);
