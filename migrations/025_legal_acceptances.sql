PRAGMA foreign_keys = ON;

-- Who accepted the user agreement and gave consent to the processing of personal data, which edition
-- and when (152-FZ art. 9: the operator proves consent). Two documents, two rows: consent is a separate
-- document since 1 September 2025. A new edition of the documents asks everyone again.
CREATE TABLE IF NOT EXISTS legal_acceptances (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  member_id TEXT NOT NULL REFERENCES tenant_members(id),
  document TEXT NOT NULL CHECK(document IN ('terms', 'consent')),
  version TEXT NOT NULL,
  accepted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  method TEXT NOT NULL CHECK(method IN ('signup', 'sign_in')),
  PRIMARY KEY (member_id, document, version)
) STRICT;
