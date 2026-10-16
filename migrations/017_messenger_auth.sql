-- Staff sign-in through messenger bots (Telegram, MAX). Secrets are stored only as
-- SHA-256 hashes: invite codes, login deep-link tokens, poll secrets and sessions.
CREATE TABLE IF NOT EXISTS member_messenger_links (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  member_id TEXT NOT NULL REFERENCES tenant_members(id),
  provider TEXT NOT NULL CHECK(provider IN ('telegram', 'max')),
  external_user_id TEXT NOT NULL,
  external_name TEXT,
  linked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, provider, external_user_id),
  UNIQUE (member_id, provider)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_member_messenger_links_external
  ON member_messenger_links(provider, external_user_id);

CREATE TABLE IF NOT EXISTS messenger_invites (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  member_id TEXT NOT NULL REFERENCES tenant_members(id),
  provider TEXT NOT NULL CHECK(provider IN ('telegram', 'max')),
  code_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  used_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS login_requests (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider IN ('telegram', 'max')),
  start_token_hash TEXT NOT NULL UNIQUE,
  short_code TEXT NOT NULL,
  poll_secret_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK(status IN ('PENDING', 'AWAITING_CONFIRMATION', 'CONFIRMED', 'DENIED', 'CONSUMED')),
  external_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_login_requests_code
  ON login_requests(provider, short_code, status);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  member_id TEXT NOT NULL REFERENCES tenant_members(id),
  token_hash TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_auth_sessions_member
  ON auth_sessions(tenant_id, member_id);
