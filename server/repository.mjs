import { createHash, randomUUID } from 'node:crypto';
import { normalizePhone, normalizePlate, normalizeSearch } from './domain/normalize.mjs';

function mapVehicle(row) {
  return {
    id: row.id,
    make: row.make,
    model: row.model,
    generation: row.generation,
    bodyType: row.body_type,
    plate: row.plate_display,
    color: row.color,
    status: row.status,
    active: row.status === 'active',
    systemVehicleClass: row.system_vehicle_class,
    tenantClass: row.tenant_class ?? null
  };
}

function formatMoney(amountMinor, prefix = '') {
  const rubles = String(Math.round(amountMinor / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${prefix}${rubles} ₽`;
}

function apiTimestamp(value) {
  if (!value) return null;
  return new Date(value.endsWith?.('Z') ? value : `${value.replace(' ', 'T')}Z`).toISOString();
}

export class DetailFlowRepository {
  constructor(db) {
    this.db = db;
  }

  searchCustomers(tenantId, phone) {
    const normalized = normalizePhone(phone);
    if (normalized.length < 4) return [];
    const customers = this.db.prepare(`SELECT id, name, phone_display, visit_count
      FROM customers
      WHERE tenant_id = ? AND archived_at IS NULL AND instr(phone_normalized, ?) > 0
      ORDER BY visit_count DESC, name LIMIT 10`).all(tenantId, normalized);
    return customers.map((customer) => ({
      id: customer.id,
      name: customer.name,
      phoneDisplay: customer.phone_display,
      visitCount: customer.visit_count,
      vehicles: this.listCustomerVehicles(tenantId, customer.id, false)
    }));
  }

  createCustomer(tenantId, input) {
    const name = String(input.name ?? '').trim();
    const phoneDisplay = String(input.phone ?? '').trim();
    const phoneNormalized = normalizePhone(phoneDisplay);
    if (name.length < 2 || phoneNormalized.length < 7) return { kind: 'invalid' };
    const tenant = this.db.prepare('SELECT id FROM tenants WHERE id = ?').get(tenantId);
    if (!tenant) return { kind: 'tenant_not_found' };
    const id = `cust_${randomUUID()}`;
    this.db.prepare(`INSERT INTO customers
      (id, tenant_id, name, phone_display, phone_normalized)
      VALUES (?, ?, ?, ?, ?)`).run(id, tenantId, name, phoneDisplay, phoneNormalized);
    return { kind: 'created', customer: {
      id, name, phoneDisplay, visitCount: 0, vehicles: []
    } };
  }

  listCustomerVehicles(tenantId, customerId, includeArchived) {
    const rows = this.db.prepare(`SELECT v.*, r.tenant_class
      FROM customer_vehicles cv
      JOIN vehicles v ON v.id = cv.vehicle_id AND v.tenant_id = cv.tenant_id
      LEFT JOIN tenant_vehicle_class_rules r
        ON r.tenant_id = v.tenant_id
       AND (r.variant_id = v.catalog_variant_id OR (r.variant_id IS NULL AND r.class_match = v.system_vehicle_class))
      WHERE cv.tenant_id = ? AND cv.customer_id = ? AND cv.valid_to IS NULL
        AND (? = 1 OR v.status = 'active')
      ORDER BY CASE v.status WHEN 'active' THEN 0 ELSE 1 END, v.created_at`).all(
        tenantId, customerId, includeArchived ? 1 : 0
      );
    return rows.map(mapVehicle);
  }

  searchVehicles(tenantId, plate) {
    const normalized = normalizePlate(plate);
    if (normalized.length < 2) return [];
    const rows = this.db.prepare(`SELECT v.*, r.tenant_class,
        c.id customer_id, c.name customer_name, c.phone_display customer_phone
      FROM vehicles v
      LEFT JOIN customer_vehicles cv
        ON cv.tenant_id = v.tenant_id AND cv.vehicle_id = v.id AND cv.valid_to IS NULL
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
  }

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
  }

  createVehicle(tenantId, input) {
    const customer = this.db.prepare('SELECT id FROM customers WHERE id = ? AND tenant_id = ? AND archived_at IS NULL')
      .get(input.customerId, tenantId);
    if (!customer) return { kind: 'not_found', resource: 'customer' };
    const variant = this.db.prepare('SELECT * FROM vehicle_catalog_variants WHERE id = ?')
      .get(input.catalogVariantId);
    if (!variant) return { kind: 'not_found', resource: 'catalog_variant' };
    const plateNormalized = normalizePlate(input.plateDisplay);
    if (plateNormalized.length < 3 || !String(input.color ?? '').trim()) return { kind: 'invalid' };

    const matches = this.searchVehicles(tenantId, plateNormalized)
      .filter((vehicle) => normalizePlate(vehicle.plate) === plateNormalized);
    if (matches.length) return { kind: 'duplicate', matches };

    const vehicleId = `veh_${randomUUID()}`;
    const linkId = `link_${randomUUID()}`;
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO vehicles
        (id, tenant_id, catalog_variant_id, make, model, generation, body_type,
         plate_display, plate_normalized, color, system_vehicle_class)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          vehicleId, tenantId, variant.id, variant.make, variant.model, variant.generation,
          variant.body_type, String(input.plateDisplay).trim(), plateNormalized,
          String(input.color).trim(), variant.system_vehicle_class
        );
      this.db.prepare(`INSERT INTO customer_vehicles
        (id, tenant_id, customer_id, vehicle_id, relation_type, is_primary)
        VALUES (?, ?, ?, ?, 'owner', 1)`).run(linkId, tenantId, input.customerId, vehicleId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    const vehicle = this.searchVehicles(tenantId, plateNormalized).find((item) => item.id === vehicleId);
    return { kind: 'created', vehicle, link: { id: linkId, customerId: input.customerId, vehicleId } };
  }

  updateVehicleStatus(tenantId, vehicleId, status) {
    if (!['active', 'inactive', 'sold'].includes(status)) return { kind: 'invalid' };
    const result = this.db.prepare(`UPDATE vehicles
      SET status = ?, archived_at = CASE WHEN ? = 'active' THEN NULL ELSE CURRENT_TIMESTAMP END
      WHERE id = ? AND tenant_id = ?`).run(status, status, vehicleId, tenantId);
    if (!result.changes) return { kind: 'not_found' };
    return { kind: 'updated', vehicle: this.db.prepare('SELECT id, status, archived_at archivedAt FROM vehicles WHERE id = ?').get(vehicleId) };
  }

  getVehiclePricingContext(tenantId, vehicleId) {
    return this.db.prepare(`SELECT v.id, v.tenant_id, v.status,
        COALESCE((
          SELECT r.tenant_class
          FROM tenant_vehicle_class_rules r
          WHERE r.tenant_id = v.tenant_id
            AND (r.variant_id = v.catalog_variant_id OR (r.variant_id IS NULL AND r.class_match = v.system_vehicle_class))
          ORDER BY r.priority DESC
          LIMIT 1
        ), v.system_vehicle_class, 'Стандарт') tenant_class
      FROM vehicles v
      WHERE v.id = ? AND v.tenant_id = ?`).get(vehicleId, tenantId);
  }

  getServicesCatalog(tenantId, vehicleId) {
    const vehicle = this.getVehiclePricingContext(tenantId, vehicleId);
    if (!vehicle) return { kind: 'not_found' };

    const services = this.db.prepare(`SELECT s.id, s.category, s.name, s.description, s.pricing_mode,
        COALESCE(SUM(p.amount_minor), 0) amount_minor,
        COALESCE(SUM(p.duration_minutes), 0) duration_minutes
      FROM tenant_services s
      LEFT JOIN tenant_service_operations so ON so.service_id = s.id
      LEFT JOIN service_operation_prices p
        ON p.service_id = so.service_id AND p.operation_id = so.operation_id AND p.tenant_class = ?
      WHERE s.tenant_id = ? AND s.active = 1
      GROUP BY s.id
      HAVING COUNT(so.operation_id) = COUNT(p.operation_id)
      ORDER BY s.category, s.name`).all(vehicle.tenant_class, tenantId).map((row) => ({
        id: row.id,
        type: 'service',
        category: row.category,
        name: row.name,
        description: row.description,
        pricingMode: row.pricing_mode,
        price: {
          amountMinor: row.amount_minor,
          label: row.pricing_mode === 'inspection' ? 'После осмотра' : formatMoney(row.amount_minor, row.pricing_mode === 'from' ? 'от ' : '')
        },
        durationMinutes: row.duration_minutes,
        operations: this.db.prepare(`SELECT o.id, o.name
          FROM tenant_service_operations so
          JOIN service_operations o ON o.id = so.operation_id
          WHERE so.service_id = ? ORDER BY so.sequence`).all(row.id)
      }));

    const packages = this.db.prepare(`SELECT p.id, p.category, p.name, p.description,
        pp.amount_minor, pp.duration_minutes
      FROM service_packages p
      JOIN service_package_prices pp ON pp.package_id = p.id AND pp.tenant_class = ?
      WHERE p.tenant_id = ? AND p.active = 1
      ORDER BY p.category, p.name`).all(vehicle.tenant_class, tenantId).map((row) => ({
        id: row.id,
        type: 'package',
        category: row.category,
        name: row.name,
        description: row.description,
        pricingMode: 'fixed',
        price: { amountMinor: row.amount_minor, label: formatMoney(row.amount_minor) },
        durationMinutes: row.duration_minutes,
        operations: this.db.prepare(`SELECT o.id, o.name
          FROM service_package_operations po
          JOIN service_operations o ON o.id = po.operation_id
          WHERE po.package_id = ? ORDER BY po.sequence`).all(row.id)
      }));

    const categories = [];
    for (const item of [...packages, ...services]) {
      let category = categories.find((entry) => entry.name === item.category);
      if (!category) {
        category = { name: item.category, items: [] };
        categories.push(category);
      }
      category.items.push(item);
    }
    return { kind: 'found', vehicleClass: vehicle.tenant_class, categories };
  }

  previewBookingQuote(tenantId, input) {
    const vehicle = this.getVehiclePricingContext(tenantId, input.vehicleId);
    if (!vehicle) return { kind: 'not_found', resource: 'vehicle' };
    if (!Array.isArray(input.selections) || input.selections.length === 0 || input.selections.length > 20) {
      return { kind: 'invalid' };
    }
    const selections = [...new Map(input.selections.map((selection) => [`${selection.type}:${selection.id}`, selection])).values()];
    if (selections.some((selection) => !['service', 'package'].includes(selection.type) || typeof selection.id !== 'string')) {
      return { kind: 'invalid' };
    }

    const lines = [];
    const warnings = [];
    const packageOperations = new Set();
    for (const selection of selections.filter((item) => item.type === 'package')) {
      const packageRow = this.db.prepare(`SELECT p.id, p.name, pp.amount_minor, pp.duration_minutes
        FROM service_packages p
        JOIN service_package_prices pp ON pp.package_id = p.id AND pp.tenant_class = ?
        WHERE p.id = ? AND p.tenant_id = ? AND p.active = 1`).get(vehicle.tenant_class, selection.id, tenantId);
      if (!packageRow) return { kind: 'not_found', resource: 'offering' };
      const operations = this.db.prepare(`SELECT o.id, o.name
        FROM service_package_operations po
        JOIN service_operations o ON o.id = po.operation_id
        WHERE po.package_id = ? ORDER BY po.sequence`).all(packageRow.id);
      const overlapsExistingPackage = operations.some((operation) => packageOperations.has(operation.id));
      if (overlapsExistingPackage) {
        return { kind: 'conflict', code: 'package_overlap', message: 'Выбранные пакеты содержат одинаковые операции' };
      }
      for (const operation of operations) packageOperations.add(operation.id);
      lines.push({
        id: packageRow.id,
        type: 'package',
        name: packageRow.name,
        amountMinor: packageRow.amount_minor,
        durationMinutes: packageRow.duration_minutes,
        operations,
        excludedOperations: [],
        excluded: false,
        pricingMode: 'fixed'
      });
    }

    for (const selection of selections.filter((item) => item.type === 'service')) {
      const service = this.db.prepare(`SELECT id, name, pricing_mode
        FROM tenant_services WHERE id = ? AND tenant_id = ? AND active = 1`).get(selection.id, tenantId);
      if (!service) return { kind: 'not_found', resource: 'offering' };
      const pricedOperations = this.db.prepare(`SELECT o.id, o.name, p.amount_minor, p.duration_minutes
        FROM tenant_service_operations so
        JOIN service_operations o ON o.id = so.operation_id
        JOIN service_operation_prices p
          ON p.service_id = so.service_id AND p.operation_id = so.operation_id AND p.tenant_class = ?
        WHERE so.service_id = ? ORDER BY so.sequence`).all(vehicle.tenant_class, service.id);
      const expectedOperationCount = this.db.prepare('SELECT COUNT(*) count FROM tenant_service_operations WHERE service_id = ?')
        .get(service.id).count;
      if (!pricedOperations.length || pricedOperations.length !== expectedOperationCount) {
        return { kind: 'not_found', resource: 'price' };
      }
      const excludedOperations = pricedOperations.filter((operation) => packageOperations.has(operation.id));
      const billableOperations = pricedOperations.filter((operation) => !packageOperations.has(operation.id));
      if (excludedOperations.length) {
        warnings.push({
          code: 'package_overlap',
          message: `${service.name}: операции из пакета исключены из повторной оплаты`,
          itemId: service.id
        });
      }
      if (service.pricing_mode !== 'fixed') {
        warnings.push({
          code: 'price_requires_inspection',
          message: `${service.name}: окончательная цена определяется после осмотра`,
          itemId: service.id
        });
      }
      lines.push({
        id: service.id,
        type: 'service',
        name: service.name,
        amountMinor: billableOperations.reduce((sum, operation) => sum + operation.amount_minor, 0),
        durationMinutes: billableOperations.reduce((sum, operation) => sum + operation.duration_minutes, 0),
        operations: pricedOperations.map(({ id, name }) => ({ id, name })),
        excludedOperations: excludedOperations.map(({ id, name }) => ({ id, name })),
        excluded: billableOperations.length === 0,
        pricingMode: service.pricing_mode
      });
    }

    return {
      kind: 'quoted',
      quote: {
        preliminary: true,
        vehicleClass: vehicle.tenant_class,
        lines,
        totalAmountMinor: lines.reduce((sum, line) => sum + line.amountMinor, 0),
        totalDurationMinutes: lines.reduce((sum, line) => sum + line.durationMinutes, 0),
        warnings
      }
    };
  }

  createBooking(tenantId, input, idempotencyKey) {
    if (!idempotencyKey || idempotencyKey.length > 120) return { kind: 'idempotency_required' };
    const normalizedSelections = Array.isArray(input.selections)
      ? [...input.selections].map(({ type, id }) => ({ type, id })).sort((left, right) => `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`))
      : input.selections;
    const requestHash = createHash('sha256').update(JSON.stringify({
      customerId: input.customerId,
      vehicleId: input.vehicleId,
      channel: input.channel,
      startAt: input.startAt,
      selections: normalizedSelections
    })).digest('hex');
    const existing = this.db.prepare('SELECT id, request_hash FROM bookings WHERE tenant_id = ? AND idempotency_key = ?')
      .get(tenantId, idempotencyKey);
    if (existing) {
      if (existing.request_hash !== requestHash) return { kind: 'conflict', code: 'idempotency_conflict', message: 'Ключ уже использован для другой записи' };
      return { kind: 'replayed', booking: this.getBooking(tenantId, existing.id) };
    }
    if (!['telegram', 'vk', 'instagram', 'call', 'in_person'].includes(input.channel)) return { kind: 'invalid' };
    if (!input.startAt || Number.isNaN(Date.parse(input.startAt))) return { kind: 'invalid' };
    const relation = this.db.prepare(`SELECT cv.id
      FROM customer_vehicles cv
      JOIN customers c ON c.id = cv.customer_id AND c.tenant_id = cv.tenant_id
      JOIN vehicles v ON v.id = cv.vehicle_id AND v.tenant_id = cv.tenant_id
      WHERE cv.tenant_id = ? AND cv.customer_id = ? AND cv.vehicle_id = ?
        AND cv.valid_to IS NULL AND c.archived_at IS NULL AND v.status = 'active'`).get(
          tenantId, input.customerId, input.vehicleId
        );
    if (!relation) return { kind: 'not_found', resource: 'customer_vehicle' };
    const quoteResult = this.previewBookingQuote(tenantId, input);
    if (quoteResult.kind !== 'quoted') return quoteResult;
    const quote = quoteResult.quote;
    if (!this.isBookingSlotAvailable(tenantId, input.startAt, quote.totalDurationMinutes)) {
      return { kind: 'conflict', code: 'slot_unavailable', message: 'Это время уже занято' };
    }
    const bookingId = `booking_${randomUUID()}`;
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO bookings
        (id, tenant_id, customer_id, vehicle_id, channel, start_at,
         estimated_duration_minutes, status, preliminary_amount_minor, resource_id, idempotency_key, request_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'CONFIRMED', ?, NULL, ?, ?)`).run(
          bookingId, tenantId, input.customerId, input.vehicleId, input.channel, input.startAt,
          quote.totalDurationMinutes, quote.totalAmountMinor, idempotencyKey, requestHash
        );
      const insertLine = this.db.prepare(`INSERT INTO booking_quote_lines
        (id, booking_id, item_type, item_id, name, amount_minor, duration_minutes,
         operations_json, excluded_operations_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const line of quote.lines) {
        insertLine.run(
          `booking_line_${randomUUID()}`, bookingId, line.type, line.id, line.name,
          line.amountMinor, line.durationMinutes, JSON.stringify(line.operations),
          JSON.stringify(line.excludedOperations)
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { kind: 'created', booking: this.getBooking(tenantId, bookingId) };
  }

  isBookingSlotAvailable(tenantId, startAt, durationMinutes) {
    const start = Date.parse(startAt);
    if (!Number.isFinite(start) || !Number.isInteger(durationMinutes) || durationMinutes <= 0) return false;
    const end = start + durationMinutes * 60_000;
    const settings = this.db.prepare('SELECT simultaneous_capacity FROM tenant_booking_settings WHERE tenant_id = ?')
      .get(tenantId);
    const capacity = settings?.simultaneous_capacity ?? 1;
    const bookings = this.db.prepare(`SELECT start_at, estimated_duration_minutes
      FROM bookings WHERE tenant_id = ? AND status = 'CONFIRMED'`).all(tenantId);
    const overlapping = bookings.filter((booking) => {
      const bookingStart = Date.parse(booking.start_at);
      const bookingEnd = bookingStart + booking.estimated_duration_minutes * 60_000;
      return bookingStart < end && bookingEnd > start;
    }).length;
    return overlapping < capacity;
  }

  getBookingAvailability(tenantId, date, durationMinutes = 60) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 720) {
      return { kind: 'invalid' };
    }
    const slots = ['09:00', '10:30', '12:00', '14:30', '16:00', '18:00'].map((time) => {
      const startAt = `${date}T${time}:00+03:00`;
      return { time, startAt, available: this.isBookingSlotAvailable(tenantId, startAt, durationMinutes) };
    });
    return { kind: 'available', date, durationMinutes, slots };
  }

  getBooking(tenantId, bookingId) {
    const row = this.db.prepare(`SELECT b.id, b.customer_id, b.vehicle_id, b.channel, b.start_at,
        b.estimated_duration_minutes, b.status, b.preliminary_amount_minor, b.resource_id,
        t.timezone
      FROM bookings b
      JOIN tenants t ON t.id = b.tenant_id
      WHERE b.id = ? AND b.tenant_id = ?`).get(bookingId, tenantId);
    if (!row) return null;
    return {
      id: row.id,
      customerId: row.customer_id,
      vehicleId: row.vehicle_id,
      channel: row.channel,
      startAt: row.start_at,
      timezone: row.timezone,
      estimatedDurationMinutes: row.estimated_duration_minutes,
      status: row.status,
      preliminaryAmountMinor: row.preliminary_amount_minor,
      resourceId: row.resource_id,
      lines: this.db.prepare(`SELECT item_type type, item_id id, name, amount_minor amountMinor,
          duration_minutes durationMinutes, operations_json operationsJson,
          excluded_operations_json excludedOperationsJson
        FROM booking_quote_lines WHERE booking_id = ? ORDER BY rowid`).all(bookingId).map((line) => ({
          type: line.type,
          id: line.id,
          name: line.name,
          amountMinor: line.amountMinor,
          durationMinutes: line.durationMinutes,
          operations: JSON.parse(line.operationsJson),
          excludedOperations: JSON.parse(line.excludedOperationsJson)
        }))
    };
  }

  createOrderFromBooking(tenantId, input) {
    const bookingId = typeof input.bookingId === 'string' ? input.bookingId : '';
    if (!bookingId) return { kind: 'invalid' };
    const existing = this.db.prepare(`SELECT order_id FROM order_workflows
      WHERE tenant_id = ? AND booking_id = ?`).get(tenantId, bookingId);
    if (existing) return { kind: 'replayed', order: this.getOrder(tenantId, existing.order_id) };
    const booking = this.db.prepare(`SELECT id, customer_id, vehicle_id, status
      FROM bookings WHERE id = ? AND tenant_id = ?`).get(bookingId, tenantId);
    if (!booking || booking.status !== 'CONFIRMED') return { kind: 'not_found', resource: 'booking' };

    const orderId = `order_${randomUUID()}`;
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO orders (id, tenant_id, customer_id, vehicle_id, status)
        VALUES (?, ?, ?, ?, 'INTAKE')`).run(orderId, tenantId, booking.customer_id, booking.vehicle_id);
      this.db.prepare(`INSERT INTO order_workflows (order_id, tenant_id, booking_id)
        VALUES (?, ?, ?)`).run(orderId, tenantId, bookingId);
      this.insertOrderAudit(tenantId, orderId, 'ORDER_CREATED', { bookingId });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { kind: 'created', order: this.getOrder(tenantId, orderId) };
  }

  saveOrderIntake(tenantId, orderId, input) {
    const order = this.db.prepare(`SELECT o.id, o.status FROM orders o
      JOIN order_workflows w ON w.order_id = o.id AND w.tenant_id = o.tenant_id
      WHERE o.id = ? AND o.tenant_id = ?`).get(orderId, tenantId);
    if (!order) return { kind: 'not_found' };
    if (order.status === 'APPROVED') {
      return { kind: 'conflict', code: 'invalid_order_state', message: 'Согласованный заказ нельзя вернуть к приёмке' };
    }
    const conditionSummary = String(input.conditionSummary ?? '').trim();
    const findings = Array.isArray(input.findings) ? input.findings : null;
    const recommendations = Array.isArray(input.recommendations) ? input.recommendations : null;
    const validFinding = (item) => item && String(item.zone ?? '').trim() &&
      ['LOW', 'MEDIUM', 'HIGH'].includes(item.severity) && String(item.note ?? '').trim();
    const validRecommendation = (item) => item && String(item.title ?? '').trim() &&
      String(item.reason ?? '').trim() && ['OPTIONAL', 'RECOMMENDED', 'URGENT'].includes(item.priority);
    if (conditionSummary.length < 3 || !findings || !recommendations || findings.length > 20 || recommendations.length > 20 ||
      findings.some((item) => !validFinding(item)) || recommendations.some((item) => !validRecommendation(item))) {
      return { kind: 'invalid' };
    }

    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO order_intakes (order_id, condition_summary, completed_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(order_id) DO UPDATE SET condition_summary = excluded.condition_summary, completed_at = CURRENT_TIMESTAMP`)
        .run(orderId, conditionSummary);
      this.db.prepare('DELETE FROM inspection_findings WHERE order_id = ?').run(orderId);
      this.db.prepare('DELETE FROM order_recommendations WHERE order_id = ?').run(orderId);
      const insertFinding = this.db.prepare(`INSERT INTO inspection_findings
        (id, order_id, zone, severity, note) VALUES (?, ?, ?, ?, ?)`);
      for (const finding of findings) insertFinding.run(
        `finding_${randomUUID()}`, orderId, String(finding.zone).trim(), finding.severity, String(finding.note).trim()
      );
      const insertRecommendation = this.db.prepare(`INSERT INTO order_recommendations
        (id, order_id, title, reason, priority) VALUES (?, ?, ?, ?, ?)`);
      for (const recommendation of recommendations) insertRecommendation.run(
        `recommendation_${randomUUID()}`, orderId, String(recommendation.title).trim(),
        String(recommendation.reason).trim(), recommendation.priority
      );
      this.db.prepare(`UPDATE orders SET status = 'ESTIMATE_DRAFT' WHERE id = ? AND tenant_id = ?`)
        .run(orderId, tenantId);
      this.db.prepare('UPDATE order_workflows SET updated_at = CURRENT_TIMESTAMP WHERE order_id = ?').run(orderId);
      this.insertOrderAudit(tenantId, orderId, 'INTAKE_COMPLETED', {
        findings: findings.length, recommendations: recommendations.length
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { kind: 'updated', order: this.getOrder(tenantId, orderId) };
  }

  createEstimateVersion(tenantId, orderId, input) {
    const order = this.db.prepare(`SELECT o.id, o.status FROM orders o
      JOIN order_workflows w ON w.order_id = o.id AND w.tenant_id = o.tenant_id
      WHERE o.id = ? AND o.tenant_id = ?`).get(orderId, tenantId);
    if (!order) return { kind: 'not_found' };
    if (order.status !== 'ESTIMATE_DRAFT') return { kind: 'conflict', code: 'invalid_order_state', message: 'Сначала завершите приёмку' };
    const lines = Array.isArray(input.lines) ? input.lines : null;
    const validLine = (line) => line && ['service', 'package', 'recommendation', 'custom'].includes(line.sourceType) &&
      String(line.name ?? '').trim() && Number.isInteger(line.amountMinor) && line.amountMinor >= 0 &&
      Number.isInteger(line.durationMinutes) && line.durationMinutes >= 0;
    if (!lines || lines.length < 1 || lines.length > 30 || lines.some((line) => !validLine(line))) return { kind: 'invalid' };

    const version = this.db.prepare('SELECT COALESCE(MAX(version), 0) + 1 version FROM estimate_versions WHERE order_id = ?')
      .get(orderId).version;
    const estimateVersionId = `estimate_${randomUUID()}`;
    const totalAmountMinor = lines.reduce((sum, line) => sum + line.amountMinor, 0);
    const totalDurationMinutes = lines.reduce((sum, line) => sum + line.durationMinutes, 0);
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO estimate_versions
        (id, tenant_id, order_id, version, total_amount_minor, total_duration_minutes)
        VALUES (?, ?, ?, ?, ?, ?)`).run(
          estimateVersionId, tenantId, orderId, version, totalAmountMinor, totalDurationMinutes
        );
      const insertLine = this.db.prepare(`INSERT INTO estimate_lines
        (id, estimate_version_id, sequence, source_type, source_id, name, amount_minor, duration_minutes, reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      lines.forEach((line, index) => insertLine.run(
        `estimate_line_${randomUUID()}`, estimateVersionId, index + 1, line.sourceType,
        line.sourceId ?? null, String(line.name).trim(), line.amountMinor, line.durationMinutes,
        String(line.reason ?? '').trim() || null
      ));
      this.db.prepare(`UPDATE order_workflows
        SET current_estimate_version_id = ?, updated_at = CURRENT_TIMESTAMP WHERE order_id = ?`)
        .run(estimateVersionId, orderId);
      this.insertOrderAudit(tenantId, orderId, 'ESTIMATE_VERSION_CREATED', { estimateVersionId, version });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { kind: 'created', estimate: this.getEstimateVersion(tenantId, estimateVersionId) };
  }

  decideEstimate(tenantId, orderId, input) {
    if (!['APPROVED', 'REJECTED'].includes(input.decision) ||
      !['in_person', 'phone', 'messenger'].includes(input.method) ||
      !String(input.estimateVersionId ?? '').trim() || !String(input.source ?? '').trim() || !String(input.responsible ?? '').trim()) {
      return { kind: 'invalid' };
    }
    const order = this.db.prepare(`SELECT o.status, w.current_estimate_version_id
      FROM orders o JOIN order_workflows w ON w.order_id = o.id AND w.tenant_id = o.tenant_id
      WHERE o.id = ? AND o.tenant_id = ?`).get(orderId, tenantId);
    if (!order) return { kind: 'not_found' };
    if (order.current_estimate_version_id !== input.estimateVersionId) {
      return { kind: 'conflict', code: 'stale_estimate', message: 'Можно согласовать только актуальную версию сметы' };
    }
    const existing = this.db.prepare(`SELECT id FROM estimate_approvals
      WHERE order_id = ? AND estimate_version_id = ?`).get(orderId, input.estimateVersionId);
    if (existing) return { kind: 'conflict', code: 'estimate_already_decided', message: 'Решение по этой версии уже сохранено' };

    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO estimate_approvals
        (id, tenant_id, order_id, estimate_version_id, decision, method, source, responsible)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          `approval_${randomUUID()}`, tenantId, orderId, input.estimateVersionId, input.decision,
          input.method, String(input.source).trim(), String(input.responsible).trim()
        );
      const nextStatus = input.decision === 'APPROVED' ? 'APPROVED' : 'ESTIMATE_DRAFT';
      this.db.prepare('UPDATE orders SET status = ? WHERE id = ? AND tenant_id = ?').run(nextStatus, orderId, tenantId);
      this.db.prepare('UPDATE order_workflows SET updated_at = CURRENT_TIMESTAMP WHERE order_id = ?').run(orderId);
      this.insertOrderAudit(tenantId, orderId, `ESTIMATE_${input.decision}`, {
        estimateVersionId: input.estimateVersionId, method: input.method, source: input.source, responsible: input.responsible
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { kind: 'updated', order: this.getOrder(tenantId, orderId) };
  }

  insertOrderAudit(tenantId, orderId, eventType, metadata = {}) {
    this.db.prepare(`INSERT INTO order_audit_events
      (id, tenant_id, order_id, event_type, metadata_json) VALUES (?, ?, ?, ?, ?)`)
      .run(`audit_${randomUUID()}`, tenantId, orderId, eventType, JSON.stringify(metadata));
  }

  getEstimateVersion(tenantId, estimateVersionId) {
    const row = this.db.prepare(`SELECT id, order_id, version, total_amount_minor, total_duration_minutes, created_at
      FROM estimate_versions WHERE id = ? AND tenant_id = ?`).get(estimateVersionId, tenantId);
    if (!row) return null;
    return {
      id: row.id,
      orderId: row.order_id,
      version: row.version,
      totalAmountMinor: row.total_amount_minor,
      totalDurationMinutes: row.total_duration_minutes,
      createdAt: apiTimestamp(row.created_at),
      lines: this.db.prepare(`SELECT id, source_type, source_id, name, amount_minor, duration_minutes, reason
        FROM estimate_lines WHERE estimate_version_id = ? ORDER BY sequence`).all(row.id).map((line) => ({
          id: line.id,
          sourceType: line.source_type,
          sourceId: line.source_id,
          name: line.name,
          amountMinor: line.amount_minor,
          durationMinutes: line.duration_minutes,
          reason: line.reason
        }))
    };
  }

  getOrder(tenantId, orderId) {
    const row = this.db.prepare(`SELECT o.id, o.customer_id, o.vehicle_id, o.status, o.created_at,
        w.booking_id, w.current_estimate_version_id
      FROM orders o LEFT JOIN order_workflows w ON w.order_id = o.id AND w.tenant_id = o.tenant_id
      WHERE o.id = ? AND o.tenant_id = ?`)
      .get(orderId, tenantId);
    if (!row) return null;
    const intake = this.db.prepare(`SELECT condition_summary, completed_at FROM order_intakes WHERE order_id = ?`).get(orderId);
    const approval = this.db.prepare(`SELECT estimate_version_id, decision, method, source, responsible, decided_at
      FROM estimate_approvals WHERE order_id = ? ORDER BY decided_at DESC, rowid DESC LIMIT 1`).get(orderId);
    return {
      id: row.id,
      customerId: row.customer_id,
      vehicleId: row.vehicle_id,
      status: row.status,
      createdAt: apiTimestamp(row.created_at),
      bookingId: row.booking_id ?? null,
      currentEstimateVersionId: row.current_estimate_version_id ?? null,
      intake: intake ? {
        conditionSummary: intake.condition_summary,
        completedAt: apiTimestamp(intake.completed_at),
        findings: this.db.prepare(`SELECT id, zone, severity, note FROM inspection_findings
          WHERE order_id = ? ORDER BY created_at, rowid`).all(orderId),
        recommendations: this.db.prepare(`SELECT id, title, reason, priority FROM order_recommendations
          WHERE order_id = ? ORDER BY created_at, rowid`).all(orderId)
      } : null,
      estimateVersions: this.db.prepare(`SELECT id FROM estimate_versions
        WHERE order_id = ? AND tenant_id = ? ORDER BY version`).all(orderId, tenantId)
        .map((estimate) => this.getEstimateVersion(tenantId, estimate.id)),
      approval: approval ? {
        estimateVersionId: approval.estimate_version_id,
        decision: approval.decision,
        method: approval.method,
        source: approval.source,
        responsible: approval.responsible,
        decidedAt: apiTimestamp(approval.decided_at)
      } : null,
      auditTrail: this.db.prepare(`SELECT event_type, metadata_json, occurred_at FROM order_audit_events
        WHERE order_id = ? AND tenant_id = ? ORDER BY occurred_at, rowid`).all(orderId, tenantId).map((event) => ({
          eventType: event.event_type,
          metadata: JSON.parse(event.metadata_json),
          occurredAt: apiTimestamp(event.occurred_at)
        }))
    };
  }
}
