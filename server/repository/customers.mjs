import { randomUUID, normalizePhone, mapVehicle, clientId, apiTimestamp } from './shared.mjs';

/** Customer search, card, contact changes and archive. Mixed into DetailFlowRepository (server/repository.mjs). */
export const customersMethods = {
  searchCustomers(tenantId, phone, includeArchived = false) {
    const normalized = normalizePhone(phone);
    if (normalized.length < 4) return [];
    // Visits are closed orders, the same figure as in the customer profile. The legacy
    // customers.visit_count column was only seeded and is never maintained, so it is not used.
    const customers = this.db.prepare(`SELECT c.id, c.name, c.phone_display, c.archived_at,
        (SELECT COUNT(*) FROM orders o WHERE o.tenant_id = c.tenant_id AND o.customer_id = c.id AND o.status = 'CLOSED') visits
      FROM customers c
      WHERE c.tenant_id = ? AND (? = 1 OR c.archived_at IS NULL) AND instr(c.phone_normalized, ?) > 0
      ORDER BY c.archived_at IS NOT NULL, visits DESC, c.name LIMIT 10`).all(tenantId, includeArchived ? 1 : 0, normalized);
    return customers.map((customer) => ({
      id: customer.id,
      name: customer.name,
      phoneDisplay: customer.phone_display,
      visitCount: customer.visits,
      archived: customer.archived_at !== null,
      vehicles: this.listCustomerVehicles(tenantId, customer.id, false)
    }));
  },

  createCustomer(tenantId, input) {
    const name = String(input.name ?? '').trim();
    const phoneDisplay = String(input.phone ?? '').trim();
    const phoneNormalized = normalizePhone(phoneDisplay);
    if (name.length < 2 || phoneNormalized.length < 7) return { kind: 'invalid' };
    const tenant = this.db.prepare('SELECT id FROM tenants WHERE id = ?').get(tenantId);
    if (!tenant) return { kind: 'tenant_not_found' };
    // A customer made offline is named on the phone and must not silently duplicate a phone
    // registered meanwhile: the phone asks "same customer?" unless the duplicate is confirmed.
    const requestedId = clientId(input.id, 'cust');
    if (requestedId === null) return { kind: 'invalid' };
    if (requestedId && this.db.prepare('SELECT 1 FROM customers WHERE id = ?').get(requestedId)) {
      return { kind: 'conflict', code: 'customer_exists', message: 'Клиент с таким номером карточки уже есть' };
    }
    if (input.checkDuplicatePhone === true && input.confirmDuplicate !== true) {
      const existing = this.db.prepare(`SELECT id, name, phone_display FROM customers
        WHERE tenant_id = ? AND phone_normalized = ? AND archived_at IS NULL ORDER BY created_at LIMIT 3`).all(tenantId, phoneNormalized);
      if (existing.length) return {
        kind: 'conflict', code: 'customer_phone_exists', message: `Клиент с этим телефоном уже есть: ${existing[0].name}`,
        details: { customers: existing.map((row) => ({ id: row.id, name: row.name, phoneDisplay: row.phone_display })) }
      };
    }
    const id = requestedId ?? `cust_${randomUUID()}`;
    this.db.prepare(`INSERT INTO customers
      (id, tenant_id, name, phone_display, phone_normalized)
      VALUES (?, ?, ?, ?, ?)`).run(id, tenantId, name, phoneDisplay, phoneNormalized);
    return { kind: 'created', customer: {
      id, name, phoneDisplay, visitCount: 0, archived: false, vehicles: []
    } };
  },

  getCustomerProfile(tenantId, customerId) {
    const row = this.db.prepare(`SELECT id, name, phone_display, phone_normalized, created_at, archived_at
      FROM customers WHERE id = ? AND tenant_id = ?`).get(customerId, tenantId);
    if (!row) return null;

    const vehicles = this.db.prepare(`SELECT v.*, cv.valid_from owned_from, cv.relation_type,
        COALESCE(o.tenant_class, (
          SELECT r.tenant_class FROM tenant_vehicle_class_rules r
          WHERE r.tenant_id = v.tenant_id
            AND (r.variant_id = v.catalog_variant_id OR (r.variant_id IS NULL AND r.class_match = v.system_vehicle_class))
          ORDER BY r.priority DESC LIMIT 1
        )) tenant_class
      FROM customer_vehicles cv
      JOIN vehicles v ON v.id = cv.vehicle_id AND v.tenant_id = cv.tenant_id
      LEFT JOIN vehicle_pricing_overrides o ON o.vehicle_id = v.id AND o.tenant_id = v.tenant_id
      WHERE cv.tenant_id = ? AND cv.customer_id = ? AND cv.valid_to IS NULL
      ORDER BY CASE v.status WHEN 'active' THEN 0 ELSE 1 END, cv.valid_from, v.created_at`).all(tenantId, customerId)
      .map((vehicle) => ({ ...mapVehicle(vehicle), relationType: vehicle.relation_type, ownedFrom: apiTimestamp(vehicle.owned_from) }));

    const formerVehicles = this.db.prepare(`SELECT cv.id link_id, cv.relation_type, cv.valid_from, cv.valid_to, v.*,
        current_owner.id current_owner_id, current_owner.name current_owner_name
      FROM customer_vehicles cv
      JOIN vehicles v ON v.id = cv.vehicle_id AND v.tenant_id = cv.tenant_id
      LEFT JOIN customer_vehicles current_link
        ON current_link.tenant_id = cv.tenant_id AND current_link.vehicle_id = cv.vehicle_id
       AND current_link.relation_type = 'owner' AND current_link.valid_to IS NULL
      LEFT JOIN customers current_owner
        ON current_owner.id = current_link.customer_id AND current_owner.tenant_id = current_link.tenant_id
      WHERE cv.tenant_id = ? AND cv.customer_id = ? AND cv.valid_to IS NOT NULL
      ORDER BY cv.valid_to DESC, cv.rowid DESC`).all(tenantId, customerId).map((link) => ({
        linkId: link.link_id,
        relationType: link.relation_type,
        validFrom: apiTimestamp(link.valid_from),
        validTo: apiTimestamp(link.valid_to),
        vehicle: mapVehicle(link),
        currentOwner: link.current_owner_id ? { id: link.current_owner_id, name: link.current_owner_name } : null
      }));

    const vehicleSummary = (item) => ({
      id: item.vehicle_id, make: item.make, model: item.model, generation: item.generation, plate: item.plate_display, color: item.color
    });
    const bookings = this.db.prepare(`SELECT b.id, b.status, b.start_at, b.estimated_duration_minutes,
        b.preliminary_amount_minor, w.order_id,
        v.id vehicle_id, v.make, v.model, v.generation, v.plate_display, v.color
      FROM bookings b
      JOIN vehicles v ON v.id = b.vehicle_id AND v.tenant_id = b.tenant_id
      LEFT JOIN order_workflows w ON w.booking_id = b.id AND w.tenant_id = b.tenant_id
      WHERE b.tenant_id = ? AND b.customer_id = ?
      ORDER BY datetime(b.start_at) DESC, b.rowid DESC LIMIT 20`).all(tenantId, customerId).map((item) => ({
        id: item.id,
        status: item.status,
        startAt: item.start_at,
        estimatedDurationMinutes: item.estimated_duration_minutes,
        preliminaryAmountMinor: item.preliminary_amount_minor,
        orderId: item.order_id ?? null,
        vehicle: vehicleSummary(item)
      }));
    const orders = this.db.prepare(`SELECT o.id, o.status, o.created_at, e.total_amount_minor, h.handed_over_at,
        v.id vehicle_id, v.make, v.model, v.generation, v.plate_display, v.color
      FROM orders o
      JOIN vehicles v ON v.id = o.vehicle_id AND v.tenant_id = o.tenant_id
      LEFT JOIN order_workflows w ON w.order_id = o.id AND w.tenant_id = o.tenant_id
      LEFT JOIN estimate_versions e ON e.id = w.current_estimate_version_id AND e.tenant_id = o.tenant_id
      LEFT JOIN order_handovers h ON h.order_id = o.id AND h.tenant_id = o.tenant_id
      WHERE o.tenant_id = ? AND o.customer_id = ?
      ORDER BY o.created_at DESC, o.rowid DESC LIMIT 20`).all(tenantId, customerId).map((item) => ({
        id: item.id,
        status: item.status,
        createdAt: apiTimestamp(item.created_at),
        closedAt: apiTimestamp(item.handed_over_at),
        totalAmountMinor: item.total_amount_minor ?? null,
        vehicle: vehicleSummary(item)
      }));

    const stats = this.db.prepare(`SELECT
        (SELECT COUNT(*) FROM bookings WHERE tenant_id = ?1 AND customer_id = ?2) bookings,
        (SELECT COUNT(*) FROM bookings b WHERE b.tenant_id = ?1 AND b.customer_id = ?2 AND b.status = 'CONFIRMED'
          AND NOT EXISTS (SELECT 1 FROM order_workflows w WHERE w.booking_id = b.id AND w.tenant_id = b.tenant_id)) open_bookings,
        (SELECT COUNT(*) FROM orders WHERE tenant_id = ?1 AND customer_id = ?2) orders,
        (SELECT COUNT(*) FROM orders WHERE tenant_id = ?1 AND customer_id = ?2 AND status <> 'CLOSED') active_orders,
        (SELECT COUNT(*) FROM orders WHERE tenant_id = ?1 AND customer_id = ?2 AND status = 'CLOSED') closed_orders,
        (SELECT MAX(created_at) FROM orders WHERE tenant_id = ?1 AND customer_id = ?2) last_visit_at`).get(tenantId, customerId);

    const phoneDuplicates = this.db.prepare(`SELECT id, name, phone_display, archived_at FROM customers
      WHERE tenant_id = ? AND phone_normalized = ? AND id <> ?
      ORDER BY archived_at IS NOT NULL, name`).all(tenantId, row.phone_normalized, customerId).map((item) => ({
        id: item.id, name: item.name, phoneDisplay: item.phone_display, archived: item.archived_at !== null
      }));
    const audit = this.db.prepare(`SELECT id, event_type, details_json, actor_name, created_at
      FROM customer_audit_events WHERE tenant_id = ? AND customer_id = ?
      ORDER BY created_at DESC, rowid DESC`).all(tenantId, customerId).map((event) => ({
        id: event.id,
        type: event.event_type,
        details: JSON.parse(event.details_json),
        actorName: event.actor_name,
        createdAt: apiTimestamp(event.created_at)
      }));

    return {
      customer: {
        id: row.id,
        name: row.name,
        phoneDisplay: row.phone_display,
        archived: row.archived_at !== null,
        archivedAt: apiTimestamp(row.archived_at),
        createdAt: apiTimestamp(row.created_at)
      },
      stats: {
        bookings: stats.bookings,
        openBookings: stats.open_bookings,
        orders: stats.orders,
        activeOrders: stats.active_orders,
        closedOrders: stats.closed_orders,
        lastVisitAt: apiTimestamp(stats.last_visit_at)
      },
      vehicles,
      formerVehicles,
      bookings,
      orders,
      phoneDuplicates,
      audit
    };
  },

  insertCustomerAudit(tenantId, customerId, eventType, details, actorName) {
    this.db.prepare(`INSERT INTO customer_audit_events
      (id, tenant_id, customer_id, event_type, details_json, actor_name)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
        `ca_${randomUUID()}`, tenantId, customerId, eventType, JSON.stringify(details), actorName ?? null
      );
  },

  updateCustomer(tenantId, customerId, input, actorName = null) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { kind: 'invalid' };
    if (Object.keys(input).some((key) => !['name', 'phone', 'confirmDuplicate'].includes(key))) return { kind: 'invalid' };
    const hasName = Object.hasOwn(input, 'name');
    const hasPhone = Object.hasOwn(input, 'phone');
    if (!hasName && !hasPhone) return { kind: 'invalid' };
    if (Object.hasOwn(input, 'confirmDuplicate') && typeof input.confirmDuplicate !== 'boolean') return { kind: 'invalid' };
    if ((hasName && typeof input.name !== 'string') || (hasPhone && typeof input.phone !== 'string')) return { kind: 'invalid' };
    const name = hasName ? input.name.trim() : null;
    const phoneDisplay = hasPhone ? input.phone.trim() : null;
    const phoneNormalized = hasPhone ? normalizePhone(phoneDisplay) : null;
    if (hasName && (name.length < 2 || name.length > 120)) return { kind: 'invalid' };
    if (hasPhone && (phoneNormalized.length < 7 || phoneNormalized.length > 15 || phoneDisplay.length > 40)) return { kind: 'invalid' };

    const customer = this.db.prepare(`SELECT id, name, phone_display, phone_normalized, archived_at
      FROM customers WHERE id = ? AND tenant_id = ?`).get(customerId, tenantId);
    if (!customer) return { kind: 'not_found' };
    if (customer.archived_at !== null) return { kind: 'archived' };

    const changes = {};
    if (hasName && name !== customer.name) changes.name = { from: customer.name, to: name };
    if (hasPhone && phoneDisplay !== customer.phone_display) changes.phone = { from: customer.phone_display, to: phoneDisplay };
    // Possible duplicates are checked only when the normalized number really changes,
    // and they are never merged: the user has to acknowledge them explicitly.
    const duplicates = hasPhone && phoneNormalized !== customer.phone_normalized
      ? this.db.prepare(`SELECT id, name, phone_display, archived_at FROM customers
          WHERE tenant_id = ? AND phone_normalized = ? AND id <> ?
          ORDER BY archived_at IS NOT NULL, name`).all(tenantId, phoneNormalized, customerId).map((item) => ({
            id: item.id, name: item.name, phoneDisplay: item.phone_display, archived: item.archived_at !== null
          }))
      : [];
    if (duplicates.length && input.confirmDuplicate !== true) return { kind: 'duplicate', matches: duplicates };
    if (!Object.keys(changes).length) return { kind: 'updated', profile: this.getCustomerProfile(tenantId, customerId) };

    this.db.exec('BEGIN');
    try {
      this.db.prepare(`UPDATE customers SET name = ?, phone_display = ?, phone_normalized = ?
        WHERE id = ? AND tenant_id = ?`).run(
          changes.name ? name : customer.name,
          changes.phone ? phoneDisplay : customer.phone_display,
          changes.phone ? phoneNormalized : customer.phone_normalized,
          customerId, tenantId
        );
      this.insertCustomerAudit(tenantId, customerId, 'CUSTOMER_UPDATED', {
        changes,
        ...(duplicates.length ? { duplicateAcknowledged: duplicates.map((item) => item.id) } : {})
      }, actorName);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { kind: 'updated', profile: this.getCustomerProfile(tenantId, customerId) };
  },

  getCustomerActiveWork(tenantId, customerId) {
    const row = this.db.prepare(`SELECT
        (SELECT COUNT(*) FROM bookings b WHERE b.tenant_id = ?1 AND b.customer_id = ?2 AND b.status = 'CONFIRMED'
          AND NOT EXISTS (SELECT 1 FROM order_workflows w WHERE w.booking_id = b.id AND w.tenant_id = b.tenant_id)) confirmed_bookings,
        (SELECT COUNT(*) FROM orders WHERE tenant_id = ?1 AND customer_id = ?2 AND status <> 'CLOSED') open_orders,
        (SELECT COUNT(*) FROM leads WHERE tenant_id = ?1 AND customer_id = ?2 AND status IN ('NEW', 'CONTACTED')) active_leads`)
      .get(tenantId, customerId);
    return { confirmedBookings: row.confirmed_bookings, openOrders: row.open_orders, activeLeads: row.active_leads };
  },

  archiveCustomer(tenantId, customerId, actorName = null) {
    const customer = this.db.prepare('SELECT id, archived_at FROM customers WHERE id = ? AND tenant_id = ?').get(customerId, tenantId);
    if (!customer) return { kind: 'not_found' };
    if (customer.archived_at !== null) return { kind: 'updated', profile: this.getCustomerProfile(tenantId, customerId) };
    const activeWork = this.getCustomerActiveWork(tenantId, customerId);
    if (activeWork.confirmedBookings || activeWork.openOrders || activeWork.activeLeads) {
      return { kind: 'active_work', details: activeWork };
    }
    // Archiving only hides the customer from new work. Vehicle links, bookings and
    // orders stay untouched so history and temporal ownership remain intact.
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`UPDATE customers SET archived_at = CURRENT_TIMESTAMP
        WHERE id = ? AND tenant_id = ? AND archived_at IS NULL`).run(customerId, tenantId);
      this.insertCustomerAudit(tenantId, customerId, 'CUSTOMER_ARCHIVED', {}, actorName);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { kind: 'updated', profile: this.getCustomerProfile(tenantId, customerId) };
  },

  reactivateCustomer(tenantId, customerId, actorName = null) {
    const customer = this.db.prepare('SELECT id, archived_at FROM customers WHERE id = ? AND tenant_id = ?').get(customerId, tenantId);
    if (!customer) return { kind: 'not_found' };
    if (customer.archived_at === null) return { kind: 'updated', profile: this.getCustomerProfile(tenantId, customerId) };
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`UPDATE customers SET archived_at = NULL WHERE id = ? AND tenant_id = ?`).run(customerId, tenantId);
      this.insertCustomerAudit(tenantId, customerId, 'CUSTOMER_REACTIVATED', {
        archivedAt: apiTimestamp(customer.archived_at)
      }, actorName);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { kind: 'updated', profile: this.getCustomerProfile(tenantId, customerId) };
  }
};
