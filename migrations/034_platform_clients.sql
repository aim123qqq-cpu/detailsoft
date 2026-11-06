PRAGMA foreign_keys = ON;

-- Where people work: the app or the site, per person and day. Only counts, kept like platform_member_days.
CREATE TABLE IF NOT EXISTS platform_client_days (
  day TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  client TEXT NOT NULL CHECK(client IN ('app', 'site')),
  requests INTEGER NOT NULL DEFAULT 0,
  changes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, tenant_id, member_id, client)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_platform_client_days_tenant ON platform_client_days(tenant_id, day);

-- Where a center was created. Centers made before this table have no row: that was not recorded.
CREATE TABLE IF NOT EXISTS platform_center_origins (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  client TEXT NOT NULL CHECK(client IN ('app', 'site'))
) STRICT;
