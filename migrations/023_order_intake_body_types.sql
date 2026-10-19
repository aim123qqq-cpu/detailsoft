PRAGMA foreign_keys = ON;

-- Body type chosen at intake: it selects the inspection diagram, and findings refer to its
-- numbered elements (src/shared/carLayouts.ts). Kept with the intake, not on the vehicle, so a
-- correction at intake does not rewrite the vehicle card.
CREATE TABLE IF NOT EXISTS order_intake_body_types (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  body_type TEXT NOT NULL CHECK(body_type IN ('sedan', 'hatchback', 'wagon', 'suv', 'coupe', 'van', 'pickup'))
) STRICT;
