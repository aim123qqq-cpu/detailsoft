-- Issued order documents (intake act, handover act). Each row is an immutable snapshot:
-- re-issuing creates a new numbered document, a signature is never added to an
-- existing row, and nothing here records payments.
CREATE TABLE IF NOT EXISTS order_documents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  document_type TEXT NOT NULL CHECK(document_type IN ('intake_act', 'handover_act')),
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  number TEXT NOT NULL,
  content_json TEXT NOT NULL,
  signer_name TEXT,
  signature_data_url TEXT,
  actor_name TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, document_type, sequence),
  CHECK ((signer_name IS NULL) = (signature_data_url IS NULL))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_order_documents_order
  ON order_documents(tenant_id, order_id, created_at);
