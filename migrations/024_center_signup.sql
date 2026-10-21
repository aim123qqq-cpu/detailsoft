PRAGMA foreign_keys = ON;

-- Self-service centers: a person confirms a sign-in request in Telegram or MAX that was opened for
-- creating a center, then names the center and becomes its owner. A regular sign-in request has no
-- row here; a sign-up request has one, with the messenger name to show in the team list.
CREATE TABLE IF NOT EXISTS login_request_purposes (
  login_request_id TEXT PRIMARY KEY REFERENCES login_requests(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK(purpose IN ('signup')),
  external_name TEXT
) STRICT;

-- Who created which center through the app: limits how many centers one messenger account can make.
CREATE TABLE IF NOT EXISTS center_signups (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
  provider TEXT NOT NULL CHECK(provider IN ('telegram', 'max')),
  external_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE INDEX IF NOT EXISTS idx_center_signups_account ON center_signups(provider, external_user_id);
