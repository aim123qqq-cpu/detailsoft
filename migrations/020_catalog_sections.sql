PRAGMA foreign_keys = ON;

-- Catalog sections ("Мойка и уход", "Салон"...). Services and packages keep their existing
-- category text as the link to a section, so no data migration is needed: sections missing for
-- existing categories are created on first read, and a rename updates the category of the items.
CREATE TABLE IF NOT EXISTS catalog_sections (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, name)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_catalog_sections_tenant_position
  ON catalog_sections(tenant_id, position);

-- Prices with tenant_class = '*' are the default for any vehicle class without its own price
-- (service_operation_prices / service_package_prices keep their schema).
