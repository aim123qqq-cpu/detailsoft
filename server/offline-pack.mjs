/**
 * Everything a phone needs to make or move a booking without the server: the schedule, prices
 * per vehicle class (the '*' row is the default for any class), the busy time ahead and, for staff
 * who manage customers, the customers with their vehicles for search. The phone runs the same rules
 * (src/shared/bookingRules.ts) on this data; the server re-checks every queued change.
 */
export function buildBookingPack(repository, tenantId, { includeCustomers }) {
  const db = repository.db;
  const schedule = repository.getCenterSettings(tenantId);
  const pricesOf = (rows) => Object.fromEntries(rows.map((row) => [row.tenant_class, { amountMinor: row.amount_minor, durationMinutes: row.duration_minutes }]));

  const packages = db.prepare(`SELECT id, category, name, description FROM service_packages
    WHERE tenant_id = ? AND active = 1 ORDER BY category, name`).all(tenantId).map((item) => ({
      id: item.id, category: item.category, name: item.name, description: item.description,
      prices: pricesOf(db.prepare('SELECT tenant_class, amount_minor, duration_minutes FROM service_package_prices WHERE package_id = ?').all(item.id)),
      operations: db.prepare(`SELECT o.id, o.name FROM service_package_operations po
        JOIN service_operations o ON o.id = po.operation_id WHERE po.package_id = ? ORDER BY po.sequence`).all(item.id)
    }));

  const services = db.prepare(`SELECT id, category, name, description, pricing_mode FROM tenant_services
    WHERE tenant_id = ? AND active = 1 ORDER BY category, name`).all(tenantId).map((item) => {
      const operations = db.prepare(`SELECT o.id, o.name FROM tenant_service_operations so
        JOIN service_operations o ON o.id = so.operation_id WHERE so.service_id = ? ORDER BY so.sequence`).all(item.id);
      return {
        id: item.id, category: item.category, name: item.name, description: item.description, pricingMode: item.pricing_mode,
        operations: operations.map((operation) => ({
          ...operation,
          prices: pricesOf(db.prepare(`SELECT tenant_class, amount_minor, duration_minutes FROM service_operation_prices
            WHERE service_id = ? AND operation_id = ?`).all(item.id, operation.id))
        }))
      };
    });

  // Busy time from yesterday on: enough to check any slot a phone may offer.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const busy = repository.busyBookings(tenantId).filter((booking) => Date.parse(booking.startAt) + booking.durationMinutes * 60_000 >= Date.parse(since));

  let customers = [];
  const vehicleClasses = {};
  if (includeCustomers) {
    customers = db.prepare(`SELECT c.id, c.name, c.phone_display, c.phone_normalized,
        (SELECT COUNT(*) FROM orders o WHERE o.tenant_id = c.tenant_id AND o.customer_id = c.id AND o.status = 'CLOSED') visits
      FROM customers c WHERE c.tenant_id = ? AND c.archived_at IS NULL ORDER BY c.name`).all(tenantId).map((customer) => ({
        id: customer.id,
        name: customer.name,
        phoneDisplay: customer.phone_display,
        phoneNormalized: customer.phone_normalized,
        visitCount: customer.visits,
        archived: false,
        vehicles: repository.listCustomerVehicles(tenantId, customer.id, false)
      }));
    for (const vehicle of customers.flatMap((customer) => customer.vehicles)) {
      vehicleClasses[vehicle.id] = repository.getVehiclePricingContext(tenantId, vehicle.id)?.tenant_class ?? '*';
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    schedule,
    sectionOrder: repository.catalog.listSections(tenantId).map((section) => section.name),
    packages,
    services,
    busy,
    customers,
    vehicleClasses
  };
}
