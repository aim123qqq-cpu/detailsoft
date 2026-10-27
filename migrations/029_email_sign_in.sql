-- Sign-in by email: a sign-in request (login_requests, provider 'email') whose confirmation is a 6-digit
-- code sent to the address instead of a button in a bot. The code is stored only as a SHA-256 hash; a few
-- wrong tries close the request. The address itself is the request's external_user_id, as a messenger id is.
-- (Allowing 'email' in the provider checks of the sign-in tables is done in server/db.mjs: SQLite cannot
-- change a CHECK in place.)
CREATE TABLE IF NOT EXISTS email_login_codes (
  login_request_id TEXT PRIMARY KEY REFERENCES login_requests(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
) STRICT;
