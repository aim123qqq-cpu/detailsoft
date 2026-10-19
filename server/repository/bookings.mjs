import { createHash, randomUUID, availabilityForDate, computeQuote, isSlotAvailable, localDateTime, OPERATION_PRICE_CLASS, PACKAGE_PRICE_CLASS, clientId, apiTimestamp, calendarDateTimestamp } from './shared.mjs';

/** Bookings: quote, free time, creation, moves and quote versions. Mixed into DetailFlowRepository (server/repository.mjs). */
export const bookingsMethods = {
  /** Prices for the vehicle's class (or the '*' default) feed the shared quote rule. */
  pricedPackage(tenantId, vehicleClass, packageId) {
    const row = this.db.prepare(`SELECT p.id, p.name, pp.amount_minor, pp.duration_minutes
      FROM service_packages p
      JOIN service_package_prices pp ON pp.package_id = p.id AND pp.tenant_class = ${PACKAGE_PRICE_CLASS}
      WHERE p.id = ? AND p.tenant_id = ? AND p.active = 1`).get(vehicleClass, packageId, tenantId);
    if (!row) return null;
    return {
      id: row.id, name: row.name, amountMinor: row.amount_minor, durationMinutes: row.duration_minutes,
      operations: this.db.prepare(`SELECT o.id, o.name FROM service_package_operations po
        JOIN service_operations o ON o.id = po.operation_id WHERE po.package_id = ? ORDER BY po.sequence`).all(row.id)
    };
  },

  pricedService(tenantId, vehicleClass, serviceId) {
    const service = this.db.prepare(`SELECT id, name, pricing_mode FROM tenant_services
      WHERE id = ? AND tenant_id = ? AND active = 1`).get(serviceId, tenantId);
    if (!service) return null;
    const operations = this.db.prepare(`SELECT o.id, o.name, p.amount_minor, p.duration_minutes
      FROM tenant_service_operations so
      JOIN service_operations o ON o.id = so.operation_id
      JOIN service_operation_prices p
        ON p.service_id = so.service_id AND p.operation_id = so.operation_id AND p.tenant_class = ${OPERATION_PRICE_CLASS}
      WHERE so.service_id = ? ORDER BY so.sequence`).all(vehicleClass, service.id);
    return {
      id: service.id, name: service.name, pricingMode: service.pricing_mode,
      operationCount: this.db.prepare('SELECT COUNT(*) count FROM tenant_service_operations WHERE service_id = ?').get(service.id).count,
      operations: operations.map((row) => ({ id: row.id, name: row.name, amountMinor: row.amount_minor, durationMinutes: row.duration_minutes }))
    };
  },

  previewBookingQuote(tenantId, input) {
    const vehicle = this.getVehiclePricingContext(tenantId, input.vehicleId);
    if (!vehicle) return { kind: 'not_found', resource: 'vehicle' };
    const result = computeQuote(input.selections,
      (id) => this.pricedPackage(tenantId, vehicle.tenant_class, id),
      (id) => this.pricedService(tenantId, vehicle.tenant_class, id));
    if (result.kind !== 'quoted') return result;
    const { kind, ...quote } = result;
    return { kind, quote: { preliminary: true, vehicleClass: vehicle.tenant_class, ...quote } };
  },

  createBooking(tenantId, input, idempotencyKey) {
    if (!idempotencyKey || idempotencyKey.length > 120) return { kind: 'idempotency_required' };
    const normalizedSelections = Array.isArray(input.selections)
      ? [...input.selections].map(({ type, id }) => ({ type, id })).sort((left, right) => `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`))
      : input.selections;
    const requestHash = createHash('sha256').update(JSON.stringify({
      customerId: input.customerId,
      vehicleId: input.vehicleId,
      leadId: input.leadId ?? null,
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
    const leadId = typeof input.leadId === 'string' && input.leadId ? input.leadId : null;
    if (leadId) {
      const lead = this.db.prepare(`SELECT id, status, customer_id FROM leads WHERE id = ? AND tenant_id = ?`).get(leadId, tenantId);
      if (!lead) return { kind: 'not_found', resource: 'lead' };
      if (!['NEW', 'CONTACTED'].includes(lead.status)) return {
        kind: 'conflict', code: 'lead_already_converted', message: 'Обращение уже закрыто или преобразовано в запись'
      };
      if (lead.customer_id && lead.customer_id !== input.customerId) return {
        kind: 'conflict', code: 'lead_customer_mismatch', message: 'Обращение связано с другим клиентом'
      };
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
    // A booking queued on a phone without the server keeps its place in the schedule even if the
    // time was taken meanwhile: it is saved with a conflict mark and must be moved.
    const slotConflict = !this.isBookingSlotAvailable(tenantId, input.startAt, quote.totalDurationMinutes);
    if (slotConflict && input.allowSlotConflict !== true) {
      return { kind: 'conflict', code: 'slot_unavailable', message: 'Это время уже занято' };
    }
    // The phone may choose the id itself so it can refer to the booking before it is sent.
    const clientId = typeof input.id === 'string' && /^booking_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.id) ? input.id : null;
    if (input.id !== undefined && !clientId) return { kind: 'invalid' };
    if (clientId && this.db.prepare('SELECT 1 FROM bookings WHERE id = ?').get(clientId)) {
      return { kind: 'conflict', code: 'booking_exists', message: 'Запись с таким номером уже есть' };
    }
    const bookingId = clientId ?? `booking_${randomUUID()}`;
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
      if (leadId) {
        this.db.prepare(`INSERT INTO lead_bookings (lead_id, tenant_id, booking_id)
          VALUES (?, ?, ?)`).run(leadId, tenantId, bookingId);
        this.db.prepare(`UPDATE leads SET status = 'CONVERTED', updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND tenant_id = ?`).run(leadId, tenantId);
      }
      if (slotConflict) this.db.prepare('INSERT INTO booking_slot_conflicts (booking_id, tenant_id) VALUES (?, ?)').run(bookingId, tenantId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { kind: 'created', booking: this.getBooking(tenantId, bookingId) };
  },

  /** Confirmed bookings occupy capacity; see src/shared/bookingRules.ts for the rule itself. */
  busyBookings(tenantId) {
    return this.db.prepare(`SELECT id, start_at, estimated_duration_minutes FROM bookings
      WHERE tenant_id = ? AND status = 'CONFIRMED'`).all(tenantId)
      .map((row) => ({ id: row.id, startAt: row.start_at, durationMinutes: row.estimated_duration_minutes }));
  },

  isBookingSlotAvailable(tenantId, startAt, durationMinutes, excludeBookingId = null, centerSettings = null) {
    const settings = centerSettings ?? this.getCenterSettings(tenantId);
    if (!settings) return false;
    return isSlotAvailable(settings, this.busyBookings(tenantId), startAt, durationMinutes, excludeBookingId);
  },

  /** excludeBookingId: the booking being moved does not block its own new time. */
  getBookingAvailability(tenantId, date, durationMinutes = 60, excludeBookingId = null) {
    const settings = this.getCenterSettings(tenantId);
    if (!settings) return { kind: 'invalid' };
    return availabilityForDate(settings, this.busyBookings(tenantId).filter((booking) => booking.id !== excludeBookingId), date, durationMinutes);
  },

  listBookings(tenantId, limit = 20, from = null, to = null, view = null) {
    const requestedLimit = Number(limit);
    const boundedLimit = Number.isInteger(requestedLimit) ? Math.min(50, Math.max(1, requestedLimit)) : 20;
    if (view !== null) return this.listBookingsView(tenantId, view, boundedLimit);
    const hasRange = from !== null || to !== null;
    const fromTimestamp = hasRange ? calendarDateTimestamp(from) : null;
    const toTimestamp = hasRange ? calendarDateTimestamp(to) : null;
    if (hasRange && (fromTimestamp === null || toTimestamp === null || toTimestamp < fromTimestamp ||
      toTimestamp - fromTimestamp > 30 * 24 * 60 * 60 * 1000)) return { kind: 'invalid' };
    const settings = hasRange ? this.getCenterSettings(tenantId) : null;
    const nextDate = hasRange ? new Date(toTimestamp + 24 * 60 * 60 * 1000).toISOString().slice(0, 10) : null;
    const fromStart = hasRange ? localDateTime(from, '00:00', settings.timezone) : null;
    const toExclusive = hasRange ? localDateTime(nextDate, '00:00', settings.timezone) : null;
    const rangeFilter = hasRange ? 'AND datetime(b.start_at) >= datetime(?) AND datetime(b.start_at) < datetime(?)' : '';
    const order = hasRange ? 'datetime(b.start_at) ASC, b.rowid ASC' : 'b.start_at DESC, b.rowid DESC';
    const parameters = hasRange ? [tenantId, fromStart, toExclusive, boundedLimit] : [tenantId, boundedLimit];
    const items = this.db.prepare(`SELECT b.id, b.channel, b.start_at, b.estimated_duration_minutes,
        b.status, b.preliminary_amount_minor,
        c.id customer_id, c.name customer_name, c.phone_display customer_phone,
        v.id vehicle_id, v.make, v.model, v.generation, v.plate_display, v.color,
        w.order_id,
        EXISTS (SELECT 1 FROM booking_slot_conflicts sc WHERE sc.booking_id = b.id AND sc.resolved_at IS NULL) slot_conflict
      FROM bookings b
      JOIN customers c ON c.id = b.customer_id AND c.tenant_id = b.tenant_id
      JOIN vehicles v ON v.id = b.vehicle_id AND v.tenant_id = b.tenant_id
      LEFT JOIN order_workflows w ON w.booking_id = b.id AND w.tenant_id = b.tenant_id
      WHERE b.tenant_id = ?
      ${rangeFilter}
      ORDER BY ${order}
      LIMIT ?`).all(...parameters).map((row) => ({
        id: row.id,
        channel: row.channel,
        startAt: row.start_at,
        estimatedDurationMinutes: row.estimated_duration_minutes,
        status: row.status,
        preliminaryAmountMinor: row.preliminary_amount_minor,
        orderId: row.order_id ?? null,
        slotConflict: row.slot_conflict === 1,
        customer: {
          id: row.customer_id,
          name: row.customer_name,
          phoneDisplay: row.customer_phone
        },
        vehicle: {
          id: row.vehicle_id,
          make: row.make,
          model: row.model,
          generation: row.generation,
          plate: row.plate_display,
          color: row.color
        }
      }));
    return { kind: 'listed', items };
  },

  /**
   * upcoming — from the start of today in the center's timezone, soonest first;
   * overdue — past CONFIRMED bookings with no order yet (arrival or no-show not recorded).
   */
  listBookingsView(tenantId, view, limit) {
    if (!['upcoming', 'overdue'].includes(view)) return { kind: 'invalid' };
    const timezone = this.getTenant(tenantId)?.timezone ?? 'Europe/Moscow';
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const startOfToday = localDateTime(today, '00:00', timezone);
    const filter = view === 'upcoming'
      ? 'AND datetime(b.start_at) >= datetime(?)'
      : `AND b.status = 'CONFIRMED' AND w.order_id IS NULL AND datetime(b.start_at) < datetime(?)`;
    const order = view === 'upcoming' ? 'datetime(b.start_at) ASC, b.rowid ASC' : 'datetime(b.start_at) DESC, b.rowid DESC';
    const boundary = view === 'upcoming' ? startOfToday : new Date().toISOString();
    const items = this.db.prepare(`SELECT b.id, b.channel, b.start_at, b.estimated_duration_minutes,
        b.status, b.preliminary_amount_minor,
        c.id customer_id, c.name customer_name, c.phone_display customer_phone,
        v.id vehicle_id, v.make, v.model, v.generation, v.plate_display, v.color,
        w.order_id,
        EXISTS (SELECT 1 FROM booking_slot_conflicts sc WHERE sc.booking_id = b.id AND sc.resolved_at IS NULL) slot_conflict
      FROM bookings b
      JOIN customers c ON c.id = b.customer_id AND c.tenant_id = b.tenant_id
      JOIN vehicles v ON v.id = b.vehicle_id AND v.tenant_id = b.tenant_id
      LEFT JOIN order_workflows w ON w.booking_id = b.id AND w.tenant_id = b.tenant_id
      WHERE b.tenant_id = ? ${filter}
      ORDER BY ${order}
      LIMIT ?`).all(tenantId, boundary, limit).map((row) => ({
        id: row.id,
        channel: row.channel,
        startAt: row.start_at,
        estimatedDurationMinutes: row.estimated_duration_minutes,
        status: row.status,
        preliminaryAmountMinor: row.preliminary_amount_minor,
        orderId: row.order_id ?? null,
        slotConflict: row.slot_conflict === 1,
        customer: { id: row.customer_id, name: row.customer_name, phoneDisplay: row.customer_phone },
        vehicle: { id: row.vehicle_id, make: row.make, model: row.model, generation: row.generation, plate: row.plate_display, color: row.color }
      }));
    return { kind: 'listed', items };
  },

  updateBooking(tenantId, bookingId, input) {
    const booking = this.db.prepare(`SELECT id, status, start_at, estimated_duration_minutes
      FROM bookings WHERE id = ? AND tenant_id = ?`).get(bookingId, tenantId);
    if (!booking) return { kind: 'not_found' };
    const order = this.db.prepare(`SELECT order_id FROM order_workflows
      WHERE booking_id = ? AND tenant_id = ?`).get(bookingId, tenantId);
    if (order) return { kind: 'conflict', code: 'booking_has_order', message: 'По записи уже создан заказ' };
    if (booking.status !== 'CONFIRMED') {
      return { kind: 'conflict', code: 'invalid_booking_state', message: 'Изменить можно только подтверждённую запись' };
    }

    const hasStartAt = Object.prototype.hasOwnProperty.call(input, 'startAt');
    const hasStatus = Object.prototype.hasOwnProperty.call(input, 'status');
    if (hasStartAt === hasStatus) return { kind: 'invalid' };

    if (hasStatus) {
      if (!['CANCELLED', 'NO_SHOW'].includes(input.status)) return { kind: 'invalid' };
      // A no-show is a fact, not a plan: it can be recorded only once the booked time has come.
      if (input.status === 'NO_SHOW' && Date.parse(booking.start_at) > Date.now()) return {
        kind: 'conflict', code: 'booking_not_started', message: 'Отметить неявку можно после времени начала записи'
      };
      // Only CONFIRMED bookings occupy capacity, so both statuses free the slot.
      this.db.prepare(`UPDATE bookings SET status = ?
        WHERE id = ? AND tenant_id = ?`).run(input.status, bookingId, tenantId);
      this.resolveSlotConflict(tenantId, bookingId);
      return { kind: 'updated', booking: this.getBooking(tenantId, bookingId) };
    }

    if (typeof input.startAt !== 'string' || Number.isNaN(Date.parse(input.startAt))) return { kind: 'invalid' };
    if (!this.isBookingSlotAvailable(tenantId, input.startAt, booking.estimated_duration_minutes, bookingId)) {
      return { kind: 'conflict', code: 'slot_unavailable', message: 'Это время уже занято' };
    }
    this.db.prepare(`UPDATE bookings SET start_at = ? WHERE id = ? AND tenant_id = ?`)
      .run(input.startAt, bookingId, tenantId);
    this.resolveSlotConflict(tenantId, bookingId);
    return { kind: 'updated', booking: this.getBooking(tenantId, bookingId) };
  },

  /** A conflict mark ends when the booking moves to a free time or stops occupying one. */
  resolveSlotConflict(tenantId, bookingId) {
    this.db.prepare(`UPDATE booking_slot_conflicts SET resolved_at = CURRENT_TIMESTAMP
      WHERE booking_id = ? AND tenant_id = ? AND resolved_at IS NULL`).run(bookingId, tenantId);
  },

  getBooking(tenantId, bookingId) {
    const row = this.db.prepare(`SELECT b.id, b.customer_id, b.vehicle_id, b.channel, b.start_at,
        b.estimated_duration_minutes, b.status, b.preliminary_amount_minor, b.resource_id, b.created_at,
        t.timezone, lead.lead_id,
        EXISTS (SELECT 1 FROM booking_slot_conflicts sc WHERE sc.booking_id = b.id AND sc.resolved_at IS NULL) slot_conflict
      FROM bookings b
      JOIN tenants t ON t.id = b.tenant_id
      LEFT JOIN lead_bookings lead ON lead.booking_id = b.id AND lead.tenant_id = b.tenant_id
      WHERE b.id = ? AND b.tenant_id = ?`).get(bookingId, tenantId);
    if (!row) return null;
    const quoteVersions = this.getBookingQuoteVersions(tenantId, row);
    const current = quoteVersions.at(-1);
    return {
      id: row.id,
      leadId: row.lead_id ?? null,
      customerId: row.customer_id,
      vehicleId: row.vehicle_id,
      channel: row.channel,
      startAt: row.start_at,
      timezone: row.timezone,
      estimatedDurationMinutes: row.estimated_duration_minutes,
      status: row.status,
      preliminaryAmountMinor: row.preliminary_amount_minor,
      resourceId: row.resource_id,
      slotConflict: row.slot_conflict === 1,
      quoteVersion: current.version,
      lines: current.lines,
      quoteVersions
    };
  },

  // Version 1 is the original booking_quote_lines snapshot until the first revision
  // materialises it in booking_quote_versions; later versions are append-only.
  getBookingQuoteVersions(tenantId, bookingRow) {
    const stored = this.db.prepare(`SELECT version, vehicle_class, total_amount_minor, total_duration_minutes,
        lines_json, reason, actor_name, created_at
      FROM booking_quote_versions WHERE tenant_id = ? AND booking_id = ? ORDER BY version`).all(tenantId, bookingRow.id);
    if (stored.length) return stored.map((version) => ({
      version: version.version,
      vehicleClass: version.vehicle_class,
      totalAmountMinor: version.total_amount_minor,
      totalDurationMinutes: version.total_duration_minutes,
      reason: version.reason,
      actorName: version.actor_name,
      createdAt: apiTimestamp(version.created_at),
      lines: JSON.parse(version.lines_json)
    }));
    return [{
      version: 1,
      vehicleClass: null,
      totalAmountMinor: bookingRow.preliminary_amount_minor,
      totalDurationMinutes: bookingRow.estimated_duration_minutes,
      reason: null,
      actorName: null,
      createdAt: apiTimestamp(bookingRow.created_at),
      lines: this.db.prepare(`SELECT item_type type, item_id id, name, amount_minor amountMinor,
          duration_minutes durationMinutes, operations_json operationsJson,
          excluded_operations_json excludedOperationsJson
        FROM booking_quote_lines WHERE booking_id = ? ORDER BY rowid`).all(bookingRow.id).map((line) => ({
          type: line.type,
          id: line.id,
          name: line.name,
          amountMinor: line.amountMinor,
          durationMinutes: line.durationMinutes,
          operations: JSON.parse(line.operationsJson),
          excludedOperations: JSON.parse(line.excludedOperationsJson)
        }))
    }];
  },

  reviseBookingQuote(tenantId, bookingId, input, actorName = null) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { kind: 'invalid' };
    if (Object.keys(input).some((key) => !['selections', 'expectedQuoteVersion', 'reason', 'startAt'].includes(key))) return { kind: 'invalid' };
    // Optional new start: the composition and the time change together, or not at all.
    if (input.startAt !== undefined && (typeof input.startAt !== 'string' || Number.isNaN(Date.parse(input.startAt)))) return { kind: 'invalid' };
    if (!Number.isInteger(input.expectedQuoteVersion) || input.expectedQuoteVersion < 1) return { kind: 'invalid' };
    if (input.reason !== undefined && input.reason !== null && typeof input.reason !== 'string') return { kind: 'invalid' };
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (reason.length > 200) return { kind: 'invalid' };

    const booking = this.db.prepare(`SELECT b.id, b.vehicle_id, b.start_at, b.status, v.status vehicle_status
      FROM bookings b JOIN vehicles v ON v.id = b.vehicle_id AND v.tenant_id = b.tenant_id
      WHERE b.id = ? AND b.tenant_id = ?`).get(bookingId, tenantId);
    if (!booking) return { kind: 'not_found', resource: 'booking' };
    if (this.db.prepare('SELECT 1 FROM order_workflows WHERE booking_id = ? AND tenant_id = ?').get(bookingId, tenantId)) {
      return { kind: 'conflict', code: 'booking_has_order', message: 'По записи уже создан заказ: состав меняется через смету' };
    }
    if (booking.status !== 'CONFIRMED') {
      return { kind: 'conflict', code: 'invalid_booking_state', message: 'Изменить можно только подтверждённую запись' };
    }
    const current = this.getBooking(tenantId, bookingId);
    if (current.quoteVersion !== input.expectedQuoteVersion) return {
      kind: 'conflict', code: 'stale_quote_version', message: 'Состав записи уже изменён. Обновите запись и повторите'
    };
    if (booking.vehicle_status !== 'active') return {
      kind: 'conflict', code: 'vehicle_inactive', message: 'Автомобиль не активен: состав записи изменить нельзя'
    };

    const quoteResult = this.previewBookingQuote(tenantId, { vehicleId: booking.vehicle_id, selections: input.selections });
    if (quoteResult.kind !== 'quoted') return quoteResult;
    const quote = quoteResult.quote;
    const compositionKey = (lines) => lines.map((line) => `${line.type}:${line.id}`).sort().join('|');
    if (compositionKey(quote.lines) === compositionKey(current.lines)) return {
      kind: 'conflict', code: 'quote_unchanged', message: 'Состав записи не изменился'
    };
    const startAt = input.startAt ?? booking.start_at;
    if (!this.isBookingSlotAvailable(tenantId, startAt, quote.totalDurationMinutes, bookingId)) return {
      kind: 'conflict', code: 'slot_unavailable', message: input.startAt
        ? 'Новый состав не помещается и в это время. Выберите другое'
        : 'Новый состав не помещается в выбранное время. Выберите другое время или сократите состав'
    };

    const insertVersion = this.db.prepare(`INSERT INTO booking_quote_versions
      (id, tenant_id, booking_id, version, vehicle_class, total_amount_minor, total_duration_minutes,
       lines_json, reason, actor_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`);
    this.db.exec('BEGIN');
    try {
      if (current.quoteVersions.length === 1 && !this.db.prepare(`SELECT 1 FROM booking_quote_versions
        WHERE tenant_id = ? AND booking_id = ?`).get(tenantId, bookingId)) {
        const original = current.quoteVersions[0];
        const originalCreatedAt = this.db.prepare('SELECT created_at FROM bookings WHERE id = ?').get(bookingId).created_at;
        insertVersion.run(
          `bqv_${randomUUID()}`, tenantId, bookingId, 1, null, original.totalAmountMinor, original.totalDurationMinutes,
          JSON.stringify(original.lines), null, null, originalCreatedAt
        );
      }
      insertVersion.run(
        `bqv_${randomUUID()}`, tenantId, bookingId, current.quoteVersion + 1, quote.vehicleClass,
        quote.totalAmountMinor, quote.totalDurationMinutes,
        JSON.stringify(quote.lines.map((line) => ({
          type: line.type, id: line.id, name: line.name, amountMinor: line.amountMinor, durationMinutes: line.durationMinutes,
          operations: line.operations, excludedOperations: line.excludedOperations, excluded: line.excluded, pricingMode: line.pricingMode
        }))),
        reason || null, actorName, null
      );
      this.db.prepare(`UPDATE bookings SET preliminary_amount_minor = ?, estimated_duration_minutes = ?, start_at = ?
        WHERE id = ? AND tenant_id = ?`).run(quote.totalAmountMinor, quote.totalDurationMinutes, startAt, bookingId, tenantId);
      if (input.startAt) this.resolveSlotConflict(tenantId, bookingId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { kind: 'updated', booking: this.getBooking(tenantId, bookingId) };
  }
};
