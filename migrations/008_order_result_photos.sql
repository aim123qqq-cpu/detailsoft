PRAGMA foreign_keys = ON;

-- Marks an existing PhotoAsset as proof of completed work without duplicating
-- the image payload stored in order_photos.
CREATE TABLE IF NOT EXISTS order_result_photos (
  photo_id TEXT PRIMARY KEY REFERENCES order_photos(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE INDEX IF NOT EXISTS idx_order_result_photos_order
  ON order_result_photos(tenant_id, order_id, created_at);
