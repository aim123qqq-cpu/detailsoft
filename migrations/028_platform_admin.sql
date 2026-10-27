PRAGMA foreign_keys = ON;

-- The owner of the DetailFlow service (not of a center): messenger accounts allowed into /admin, set on
-- the server with scripts/platform-admin.mjs. Admin sessions are separate from center sessions: they see
-- counts across centers and the server's health, never the centers' customers.
CREATE TABLE IF NOT EXISTS platform_admins (
  provider TEXT NOT NULL CHECK(provider IN ('telegram', 'max')),
  external_user_id TEXT NOT NULL,
  added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (provider, external_user_id)
) STRICT;

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
) STRICT;
