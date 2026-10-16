-- Links an order assignment to a real team member. order_assignments.master_name stays as
-- the display snapshot, so renaming or blocking an employee never rewrites past orders.
CREATE TABLE IF NOT EXISTS order_assignment_members (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  member_id TEXT NOT NULL REFERENCES tenant_members(id),
  assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE INDEX IF NOT EXISTS idx_order_assignment_members_member
  ON order_assignment_members(tenant_id, member_id);
