PRAGMA foreign_keys = ON;

-- Responses to mutating requests sent with an Idempotency-Key. A phone that synchronizes its
-- offline queue may resend a request whose answer it never received; the stored answer is
-- returned instead of running the change twice. Rows older than 7 days are purged.
CREATE TABLE IF NOT EXISTS api_idempotent_requests (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  key TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, key)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_api_idempotent_requests_created
  ON api_idempotent_requests(created_at);
