PRAGMA foreign_keys = ON;

-- The service owner's journal (/admin): kept across restarts, deleted after 90 days (event-log.mjs).
-- Who acted is a role and a short tag, never a name; customers' data never comes here.
CREATE TABLE IF NOT EXISTS platform_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  level TEXT NOT NULL CHECK(level IN ('info', 'warn', 'error')),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  meaning TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  tenant_id TEXT,
  actor TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_platform_events_at ON platform_events(at);
CREATE INDEX IF NOT EXISTS idx_platform_events_tenant ON platform_events(tenant_id, seq);

-- Requests by kind in 10-minute buckets, for «какие запросы идут» over any period. Only counts.
CREATE TABLE IF NOT EXISTS platform_request_stats (
  bucket TEXT NOT NULL,
  route TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  client_errors INTEGER NOT NULL DEFAULT 0,
  server_errors INTEGER NOT NULL DEFAULT 0,
  slow INTEGER NOT NULL DEFAULT 0,
  total_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, route)
) STRICT;

-- Who really worked on a day. A session lives 30 days, so sign-ins alone say little about activity.
CREATE TABLE IF NOT EXISTS platform_member_days (
  day TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  changes INTEGER NOT NULL DEFAULT 0,
  last_at TEXT NOT NULL,
  last_change_at TEXT,
  PRIMARY KEY (day, tenant_id, member_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_platform_member_days_tenant ON platform_member_days(tenant_id, day);

-- Centers the owner does not count (their own tests): still listed, left out of the totals.
CREATE TABLE IF NOT EXISTS platform_excluded_centers (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  excluded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
