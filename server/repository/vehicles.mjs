import { randomUUID, normalizePlate, normalizeSearch, mapVehicle, clientId, apiTimestamp } from './shared.mjs';

/** Vehicles, ownership history and the pricing class of a vehicle. Mixed into DetailFlowRepository (server/repository.mjs). */
export const vehiclesMethods = {
  listCustomerVehicles(tenantId, customerId, includeArchived) {
    const rows = this.db.prepare(`SELECT v.*, COALESCE(o.tenant_class, r.tenant_class) tenant_class
      FROM customer_vehicles cv
      JOIN vehicles v ON v.id = cv.vehicle_id AND v.tenant_id = cv.tenant_id
      LEFT JOIN vehicle_pricing_overrides o ON o.vehicle_id = v.id AND o.tenant_id = v.tenant_id
      LEFT JOIN tenant_vehicle_class_rules r
        ON r.tenant_id = v.tenant_id
       AND (r.variant_id = v.catalog_variant_id OR (r.variant_id IS NULL AND r.class_match = v.system_vehicle_class))
      WHERE cv.tenant_id = ? AND cv.customer_id = ? AND cv.valid_to IS NULL
        AND (? = 1 OR v.status = 'active')
      ORDER BY CASE v.status WHEN 'active' THEN 0 ELSE 1 END, v.created_at`).all(
        tenantId, customerId, includeArchived ? 1 : 0
      );
    return rows.map(mapVehicle);
  },

  searchVehicles(tenantId, plate) {
    const normalized = normalizePlate(plate);
    if (normalized.length < 2) return [];
    const rows = this.db.prepare(`SELECT v.*, COALESCE(o.tenant_class, r.tenant_class) tenant_class,
        c.id customer_id, c.name customer_name, c.phone_display customer_phone
      FROM vehicles v
      LEFT JOIN vehicle_pricing_overrides o ON o.vehicle_id = v.id AND o.tenant_id = v.tenant_id
      LEFT JOIN customer_vehicles cv
        ON cv.tenant_id = v.tenant_id AND cv.vehicle_id = v.id
       AND cv.valid_to IS NULL AND cv.relation_type = 'owner'
      LEFT JOIN customers c ON c.tenant_id = cv.tenant_id AND c.id = cv.customer_id
      LEFT JOIN tenant_vehicle_class_rules r
        ON r.tenant_id = v.tenant_id
       AND (r.variant_id = v.catalog_variant_id OR (r.variant_id IS NULL AND r.class_match = v.system_vehicle_class))
      WHERE v.tenant_id = ? AND instr(v.plate_normalized, ?) > 0
      ORDER BY v.status = 'active' DESC, v.created_at DESC LIMIT 10`).all(tenantId, normalized);
    return rows.map((row) => ({
      ...mapVehicle(row),
      customer: row.customer_id ? {
        id: row.customer_id,
        name: row.customer_name,
        phoneDisplay: row.customer_phone
      } : null
    }));
  },

  searchCatalog(query) {
    const terms = normalizeSearch(query).split(' ').filter(Boolean);
    if (!terms.length) return [];
    const rows = this.db.prepare(`SELECT * FROM vehicle_catalog_variants
      ORDER BY make, model, generation, body_type`).all();
    return rows.filter((row) => {
      const haystack = normalizeSearch(`${row.make} ${row.model} ${row.generation ?? ''} ${row.body_type}`);
      return terms.every((term) => haystack.includes(term));
    }).map((row) => ({
      id: row.id,
      make: row.make,
      model: row.model,
      generation: row.generation,
      yearFrom: row.year_from,
      yearTo: row.year_to,
      bodyType: row.body_type,
      systemVehicleClass: row.system_vehicle_class
    }));
  },

  listVehicleClasses(tenantId) {
    return this.db.prepare(`SELECT DISTINCT tenant_class FROM tenant_vehicle_class_rules
      WHERE tenant_id = ? ORDER BY tenant_class`).all(tenantId).map((row) => row.tenant_class);
  },

  createVehicle(tenantId, input) {
    const customer = this.db.prepare('SELECT id FROM customers WHERE id = ? AND tenant_id = ? AND archived_at IS NULL')
      .get(input.customerId, tenantId);
    if (!customer) return { kind: 'not_found', resource: 'customer' };
    const catalogRequested = typeof input.catalogVariantId === 'string' && input.catalogVariantId.trim().length > 0;
    if (catalogRequested && input.manual) return { kind: 'invalid' };
    const variant = catalogRequested
      ? this.db.prepare('SELECT * FROM vehicle_catalog_variants WHERE id = ?').get(input.catalogVariantId)
      : null;
    const manual = input.manual && typeof input.manual === 'object' ? {
      make: String(input.manual.make ?? '').trim(),
      model: String(input.manual.model ?? '').trim(),
      generation: String(input.manual.generation ?? '').trim() || null,
      body_type: String(input.manual.bodyType ?? '').trim(),
      system_vehicle_class: String(input.manual.systemVehicleClass ?? '').trim() || null
    } : null;
    const allowedBodyTypes = new Set(['sedan', 'hatchback', 'suv', 'wagon', 'coupe', 'van', 'pickup', 'other']);
    if (catalogRequested && !variant) return { kind: 'not_found', resource: 'catalog_variant' };
    if (!variant && (!manual || manual.make.length < 2 || manual.model.length < 1 ||
      manual.make.length > 80 || manual.model.length > 80 || !allowedBodyTypes.has(manual.body_type))) {
      return { kind: 'invalid' };
    }
    const vehicleData = variant ?? manual;
    const tenantClass = String(input.tenantClass ?? '').trim() || null;
    if (tenantClass && !this.db.prepare(`SELECT 1 FROM tenant_vehicle_class_rules
      WHERE tenant_id = ? AND tenant_class = ? LIMIT 1`).get(tenantId, tenantClass)) return { kind: 'invalid' };
    const plateNormalized = normalizePlate(input.plateDisplay);
    if (plateNormalized.length < 3 || !String(input.color ?? '').trim()) return { kind: 'invalid' };

    const matches = this.searchVehicles(tenantId, plateNormalized)
      .filter((vehicle) => normalizePlate(vehicle.plate) === plateNormalized);
    if (matches.length) return { kind: 'duplicate', matches };

    const requestedId = clientId(input.id, 'veh');
    if (requestedId === null) return { kind: 'invalid' };
    if (requestedId && this.db.prepare('SELECT 1 FROM vehicles WHERE id = ?').get(requestedId)) return { kind: 'invalid' };
    const vehicleId = requestedId ?? `veh_${randomUUID()}`;
    const linkId = `link_${randomUUID()}`;
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO vehicles
        (id, tenant_id, catalog_variant_id, make, model, generation, body_type,
         plate_display, plate_normalized, color, system_vehicle_class)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          vehicleId, tenantId, variant?.id ?? null, vehicleData.make, vehicleData.model, vehicleData.generation,
          vehicleData.body_type, String(input.plateDisplay).trim(), plateNormalized,
          String(input.color).trim(), vehicleData.system_vehicle_class
        );
      this.db.prepare(`INSERT INTO customer_vehicles
        (id, tenant_id, customer_id, vehicle_id, relation_type, is_primary)
        VALUES (?, ?, ?, ?, 'owner', 1)`).run(linkId, tenantId, input.customerId, vehicleId);
      if (tenantClass) this.db.prepare(`INSERT INTO vehicle_pricing_overrides
        (vehicle_id, tenant_id, tenant_class) VALUES (?, ?, ?)`).run(vehicleId, tenantId, tenantClass);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    const vehicle = this.searchVehicles(tenantId, plateNormalized).find((item) => item.id === vehicleId);
    return { kind: 'created', vehicle, link: { id: linkId, customerId: input.customerId, vehicleId } };
  },

  updateVehicleStatus(tenantId, vehicleId, status) {
    if (!['active', 'inactive', 'sold'].includes(status)) return { kind: 'invalid' };
    const vehicle = this.db.prepare('SELECT id, status FROM vehicles WHERE id = ? AND tenant_id = ?').get(vehicleId, tenantId);
    if (!vehicle) return { kind: 'not_found' };
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`UPDATE vehicles
        SET status = ?, archived_at = CASE WHEN ? = 'active' THEN NULL ELSE CURRENT_TIMESTAMP END
        WHERE id = ? AND tenant_id = ?`).run(status, status, vehicleId, tenantId);
      if (vehicle.status !== status) {
        this.db.prepare(`INSERT INTO vehicle_audit_events
          (id, tenant_id, vehicle_id, event_type, details_json)
          VALUES (?, ?, ?, 'VEHICLE_STATUS_CHANGED', ?)`).run(
            `va_${randomUUID()}`, tenantId, vehicleId,
            JSON.stringify({ fromStatus: vehicle.status, toStatus: status })
          );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { kind: 'updated', vehicle: this.db.prepare('SELECT id, status, archived_at archivedAt FROM vehicles WHERE id = ?').get(vehicleId) };
  },

  updateVehicleDetails(tenantId, vehicleId, input) {
    if (!input || typeof input !== 'object') return { kind: 'invalid' };
    const vehicle = this.db.prepare('SELECT id, body_type FROM vehicles WHERE id = ? AND tenant_id = ?').get(vehicleId, tenantId);
    if (!vehicle) return { kind: 'not_found' };
    const allowedBodyTypes = new Set(['sedan', 'hatchback', 'suv', 'wagon', 'coupe', 'van', 'pickup', 'other']);
    const bodyType = input.bodyType === undefined ? vehicle.body_type : String(input.bodyType);
    if (!allowedBodyTypes.has(bodyType)) return { kind: 'invalid' };
    const tenantClass = input.tenantClass === undefined ? undefined : String(input.tenantClass).trim();
    if (tenantClass !== undefined && (!tenantClass || !this.db.prepare(`SELECT 1 FROM tenant_vehicle_class_rules
      WHERE tenant_id = ? AND tenant_class = ? LIMIT 1`).get(tenantId, tenantClass))) return { kind: 'invalid' };
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE vehicles SET body_type = ? WHERE id = ? AND tenant_id = ?').run(bodyType, vehicleId, tenantId);
      if (tenantClass !== undefined) this.db.prepare(`INSERT INTO vehicle_pricing_overrides
        (vehicle_id, tenant_id, tenant_class, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(vehicle_id) DO UPDATE SET tenant_class = excluded.tenant_class, updated_at = CURRENT_TIMESTAMP`)
        .run(vehicleId, tenantId, tenantClass);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { kind: 'updated', vehicle: this.getVehicleProfile(tenantId, vehicleId)?.vehicle };
  },

  getVehicleProfile(tenantId, vehicleId) {
    const vehicleRow = this.db.prepare(`SELECT v.*, COALESCE(o.tenant_class, r.tenant_class) tenant_class
      FROM vehicles v
      LEFT JOIN vehicle_pricing_overrides o ON o.vehicle_id = v.id AND o.tenant_id = v.tenant_id
      LEFT JOIN tenant_vehicle_class_rules r
        ON r.tenant_id = v.tenant_id
       AND (r.variant_id = v.catalog_variant_id OR (r.variant_id IS NULL AND r.class_match = v.system_vehicle_class))
      WHERE v.id = ? AND v.tenant_id = ?
      ORDER BY r.priority DESC LIMIT 1`).get(vehicleId, tenantId);
    if (!vehicleRow) return null;

    const ownership = this.db.prepare(`SELECT cv.id, cv.relation_type, cv.valid_from, cv.valid_to,
        c.id customer_id, c.name customer_name, c.phone_display
      FROM customer_vehicles cv
      JOIN customers c ON c.id = cv.customer_id AND c.tenant_id = cv.tenant_id
      WHERE cv.tenant_id = ? AND cv.vehicle_id = ? AND cv.relation_type = 'owner'
      ORDER BY cv.valid_to IS NULL DESC, cv.valid_from DESC, cv.created_at DESC`).all(tenantId, vehicleId).map((row) => ({
        linkId: row.id,
        relationType: row.relation_type,
        validFrom: apiTimestamp(row.valid_from),
        validTo: apiTimestamp(row.valid_to),
        active: row.valid_to === null,
        customer: { id: row.customer_id, name: row.customer_name, phoneDisplay: row.phone_display }
      }));
    const visits = this.db.prepare(`SELECT o.id, o.status, o.created_at,
        c.id customer_id, c.name customer_name
      FROM orders o
      JOIN customers c ON c.id = o.customer_id AND c.tenant_id = o.tenant_id
      WHERE o.tenant_id = ? AND o.vehicle_id = ?
      ORDER BY o.created_at DESC, o.id DESC`).all(tenantId, vehicleId).map((row) => ({
        id: row.id,
        status: row.status,
        createdAt: apiTimestamp(row.created_at),
        customer: { id: row.customer_id, name: row.customer_name }
      }));
    const audit = this.db.prepare(`SELECT id, event_type, details_json, created_at
      FROM vehicle_audit_events WHERE tenant_id = ? AND vehicle_id = ?
      ORDER BY created_at DESC, rowid DESC`).all(tenantId, vehicleId).map((row) => ({
        id: row.id,
        type: row.event_type,
        details: JSON.parse(row.details_json),
        createdAt: apiTimestamp(row.created_at)
      }));
    return {
      vehicle: mapVehicle(vehicleRow),
      currentOwner: ownership.find((link) => link.active)?.customer ?? null,
      ownership,
      visits,
      audit
    };
  },

  transferVehicleOwner(tenantId, vehicleId, customerId) {
    if (typeof customerId !== 'string' || !customerId.trim()) return { kind: 'invalid' };
    const vehicle = this.db.prepare('SELECT id FROM vehicles WHERE id = ? AND tenant_id = ?').get(vehicleId, tenantId);
    if (!vehicle) return { kind: 'not_found', resource: 'vehicle' };
    const customer = this.db.prepare(`SELECT id FROM customers
      WHERE id = ? AND tenant_id = ? AND archived_at IS NULL`).get(customerId, tenantId);
    if (!customer) return { kind: 'not_found', resource: 'customer' };
    const currentLinks = this.db.prepare(`SELECT id, customer_id FROM customer_vehicles
      WHERE tenant_id = ? AND vehicle_id = ? AND relation_type = 'owner' AND valid_to IS NULL`).all(tenantId, vehicleId);
    if (currentLinks.some((link) => link.customer_id === customerId)) return { kind: 'same_owner' };

    const newLinkId = `link_${randomUUID()}`;
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`UPDATE customer_vehicles
        SET valid_to = CURRENT_TIMESTAMP, is_primary = 0
        WHERE tenant_id = ? AND vehicle_id = ? AND relation_type = 'owner' AND valid_to IS NULL`).run(tenantId, vehicleId);
      this.db.prepare(`INSERT INTO customer_vehicles
        (id, tenant_id, customer_id, vehicle_id, relation_type, is_primary)
        VALUES (?, ?, ?, ?, 'owner', 1)`).run(newLinkId, tenantId, customerId, vehicleId);
      this.db.prepare(`INSERT INTO vehicle_audit_events
        (id, tenant_id, vehicle_id, event_type, details_json)
        VALUES (?, ?, ?, 'OWNER_TRANSFERRED', ?)`).run(
          `va_${randomUUID()}`, tenantId, vehicleId,
          JSON.stringify({ fromCustomerIds: currentLinks.map((link) => link.customer_id), toCustomerId: customerId, newLinkId })
        );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { kind: 'transferred', profile: this.getVehicleProfile(tenantId, vehicleId) };
  },

  getVehiclePricingContext(tenantId, vehicleId) {
    return this.db.prepare(`SELECT v.id, v.tenant_id, v.status,
        COALESCE(o.tenant_class, (
          SELECT r.tenant_class
          FROM tenant_vehicle_class_rules r
          WHERE r.tenant_id = v.tenant_id
            AND (r.variant_id = v.catalog_variant_id OR (r.variant_id IS NULL AND r.class_match = v.system_vehicle_class))
          ORDER BY r.priority DESC
          LIMIT 1
        ), v.system_vehicle_class, 'Стандарт') tenant_class
      FROM vehicles v
      LEFT JOIN vehicle_pricing_overrides o ON o.vehicle_id = v.id AND o.tenant_id = v.tenant_id
      WHERE v.id = ? AND v.tenant_id = ?`).get(vehicleId, tenantId);
  }
};
