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

function timeToMinutes(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value ?? ''));
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
}

function minutesToTime(value) {
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

function localDateTime(date, time, timezone) {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(utcGuess));
  const part = (type) => Number(parts.find((entry) => entry.type === type)?.value);
  const representedUtc = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'));
  const offsetMinutes = Math.round((representedUtc - utcGuess) / 60_000);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
  return `${date}T${time}:00${offset}`;
}

function localBookingParts(startAt, timezone) {
  const date = new Date(startAt);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const part = (type) => Number(parts.find((entry) => entry.type === type)?.value);
  const year = part('year');
  const month = part('month');
  const day = part('day');
  return {
    dayOfWeek: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
    minuteOfDay: part('hour') * 60 + part('minute')
  };
}

function mapLead(row) {
  if (!row) return null;
  return {
    id: row.id,
    channel: row.channel,
    status: row.status,
    contactName: row.contact_name,
    phoneDisplay: row.phone_display,
    note: row.note,
    createdAt: apiTimestamp(row.created_at),
    updatedAt: apiTimestamp(row.updated_at),
    bookingId: row.booking_id ?? null,
    customer: row.customer_id ? { id: row.customer_id, name: row.customer_name } : null
  };
}

export class DetailFlowRepository {
  constructor(db) {
    this.db = db;
  }

  getTenant(tenantId) {
    const tenant = this.db.prepare('SELECT id, name, timezone FROM tenants WHERE id = ?').get(tenantId);
    return tenant ? { id: tenant.id, name: tenant.name, timezone: tenant.timezone } : null;
  }

  getCenterSettings(tenantId) {
    const row = this.db.prepare(`SELECT tenant.timezone, settings.working_days_json, settings.open_time,
        settings.close_time, settings.slot_step_minutes,
        COALESCE(settings.simultaneous_capacity, legacy.simultaneous_capacity, 1) simultaneous_capacity
      FROM tenants tenant
      LEFT JOIN tenant_operating_settings settings ON settings.tenant_id = tenant.id
      LEFT JOIN tenant_booking_settings legacy ON legacy.tenant_id = tenant.id
      WHERE tenant.id = ?`).get(tenantId);
    if (!row) return null;
    return {
      timezone: row.timezone,
      workingDays: row.working_days_json ? JSON.parse(row.working_days_json) : [0, 1, 2, 3, 4, 5, 6],
      openTime: row.open_time ?? '09:00',
      closeTime: row.close_time ?? '20:00',
      slotStepMinutes: row.slot_step_minutes ?? 30,
      simultaneousCapacity: row.simultaneous_capacity ?? 1
    };
  }

  updateCenterSettings(tenantId, input) {
    const tenant = this.db.prepare('SELECT id FROM tenants WHERE id = ?').get(tenantId);
    if (!tenant || typeof input !== 'object' || !input) return { kind: tenant ? 'invalid' : 'not_found' };
    const workingDays = Array.isArray(input.workingDays) ? [...new Set(input.workingDays)].sort((left, right) => left - right) : [];
    const openTime = String(input.openTime ?? '');
    const closeTime = String(input.closeTime ?? '');
    const openMinutes = timeToMinutes(openTime);
    const closeMinutes = timeToMinutes(closeTime);
    const slotStepMinutes = Number(input.slotStepMinutes);
    const simultaneousCapacity = Number(input.simultaneousCapacity);
    if (!workingDays.length || workingDays.some((day) => !Number.isInteger(day) || day < 0 || day > 6) ||
      openMinutes === null || closeMinutes === null || closeMinutes - openMinutes < 60 ||
      ![15, 30, 60, 90, 120].includes(slotStepMinutes) ||
      !Number.isInteger(simultaneousCapacity) || simultaneousCapacity < 1 || simultaneousCapacity > 20) {
      return { kind: 'invalid' };
    }
    this.db.prepare(`INSERT INTO tenant_operating_settings
      (tenant_id, working_days_json, open_time, close_time, slot_step_minutes, simultaneous_capacity, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(tenant_id) DO UPDATE SET working_days_json = excluded.working_days_json,
        open_time = excluded.open_time, close_time = excluded.close_time,
        slot_step_minutes = excluded.slot_step_minutes, simultaneous_capacity = excluded.simultaneous_capacity,
        updated_at = CURRENT_TIMESTAMP`).run(
          tenantId, JSON.stringify(workingDays), openTime, closeTime, slotStepMinutes, simultaneousCapacity
        );
    return { kind: 'updated', settings: this.getCenterSettings(tenantId) };
  }

  listLeads(tenantId, limit = 50) {
    const requestedLimit = Number(limit);
    const boundedLimit = Number.isInteger(requestedLimit) ? Math.min(100, Math.max(1, requestedLimit)) : 50;
    return this.db.prepare(`SELECT lead.id, lead.channel, lead.status, lead.contact_name, lead.phone_display,
        lead.note, lead.created_at, lead.updated_at, customer.id customer_id, customer.name customer_name,
        booking.booking_id
      FROM leads lead
      LEFT JOIN customers customer ON customer.id = lead.customer_id AND customer.tenant_id = lead.tenant_id
      LEFT JOIN lead_bookings booking ON booking.lead_id = lead.id AND booking.tenant_id = lead.tenant_id
      WHERE lead.tenant_id = ?
      ORDER BY CASE lead.status WHEN 'NEW' THEN 0 WHEN 'CONTACTED' THEN 1 WHEN 'CONVERTED' THEN 2 ELSE 3 END,
        lead.updated_at DESC, lead.rowid DESC LIMIT ?`).all(tenantId, boundedLimit).map(mapLead);
  }

  getLead(tenantId, leadId) {
    return mapLead(this.db.prepare(`SELECT lead.id, lead.channel, lead.status, lead.contact_name, lead.phone_display,
        lead.note, lead.created_at, lead.updated_at, customer.id customer_id, customer.name customer_name,
        booking.booking_id
      FROM leads lead
      LEFT JOIN customers customer ON customer.id = lead.customer_id AND customer.tenant_id = lead.tenant_id
      LEFT JOIN lead_bookings booking ON booking.lead_id = lead.id AND booking.tenant_id = lead.tenant_id
      WHERE lead.id = ? AND lead.tenant_id = ?`).get(leadId, tenantId));
  }

  createLead(tenantId, input) {
    const channel = String(input.channel ?? '');
    const contactName = String(input.contactName ?? '').trim();
    const phoneDisplay = String(input.phone ?? '').trim();
    const phoneNormalized = normalizePhone(phoneDisplay);
    const note = String(input.note ?? '').trim();
    const customerId = typeof input.customerId === 'string' && input.customerId ? input.customerId : null;
    if (!['telegram', 'vk', 'instagram', 'call', 'in_person'].includes(channel) || contactName.length < 2 ||
      contactName.length > 120 || phoneNormalized.length < 7 || note.length > 500) return { kind: 'invalid' };
    if (customerId) {
      const customer = this.db.prepare(`SELECT id FROM customers
        WHERE id = ? AND tenant_id = ? AND archived_at IS NULL`).get(customerId, tenantId);
      if (!customer) return { kind: 'not_found', resource: 'customer' };
    }
    const id = `lead_${randomUUID()}`;
    this.db.prepare(`INSERT INTO leads
      (id, tenant_id, customer_id, channel, contact_name, phone_display, phone_normalized, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, tenantId, customerId, channel, contactName, phoneDisplay, phoneNormalized, note
      );
    return { kind: 'created', lead: this.getLead(tenantId, id) };
  }

  updateLeadStatus(tenantId, leadId, status) {
    const lead = this.db.prepare(`SELECT id, status FROM leads WHERE id = ? AND tenant_id = ?`).get(leadId, tenantId);
    if (!lead) return { kind: 'not_found' };
    if (!['CONTACTED', 'LOST'].includes(status)) return { kind: 'invalid' };
    if (lead.status === status) return { kind: 'updated', lead: this.getLead(tenantId, leadId) };
    const allowed = lead.status === 'NEW' ? ['CONTACTED', 'LOST'] : lead.status === 'CONTACTED' ? ['LOST'] : [];
    if (!allowed.includes(status)) return {
      kind: 'conflict', code: 'invalid_lead_state', message: 'Статус обращения уже нельзя изменить'
    };
    this.db.prepare(`UPDATE leads SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND tenant_id = ?`).run(status, leadId, tenantId);
    return { kind: 'updated', lead: this.getLead(tenantId, leadId) };
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

  getManagedCatalog(tenantId) {
    const vehicleClasses = this.db.prepare(`SELECT DISTINCT tenant_class
      FROM tenant_vehicle_class_rules WHERE tenant_id = ?`).all(tenantId)
      .map((row) => row.tenant_class)
      .sort((left, right) => {
        const leftLatin = /^[A-Za-z]/.test(left);
        const rightLatin = /^[A-Za-z]/.test(right);
        return leftLatin === rightLatin ? left.localeCompare(right, 'ru') : leftLatin ? 1 : -1;
      });
    const services = this.db.prepare(`SELECT id, category, name, description, pricing_mode, active
      FROM tenant_services WHERE tenant_id = ? ORDER BY active DESC, category, name`).all(tenantId).map((service) => ({
        id: service.id,
        type: 'service',
        category: service.category,
        name: service.name,
        description: service.description,
        pricingMode: service.pricing_mode,
        active: Boolean(service.active),
        operations: this.db.prepare(`SELECT operation.id, operation.name
          FROM tenant_service_operations relation
          JOIN service_operations operation ON operation.id = relation.operation_id
          WHERE relation.service_id = ? AND operation.tenant_id = ?
          ORDER BY relation.sequence`).all(service.id, tenantId).map((operation) => ({
            id: operation.id,
            name: operation.name,
            prices: this.db.prepare(`SELECT tenant_class, amount_minor, duration_minutes
              FROM service_operation_prices
              WHERE service_id = ? AND operation_id = ? ORDER BY tenant_class`).all(service.id, operation.id).map((price) => ({
                tenantClass: price.tenant_class,
                amountMinor: price.amount_minor,
                durationMinutes: price.duration_minutes
              }))
          }))
      }));
    const packages = this.db.prepare(`SELECT id, category, name, description, active
      FROM service_packages WHERE tenant_id = ? ORDER BY active DESC, category, name`).all(tenantId).map((servicePackage) => ({
        id: servicePackage.id,
        type: 'package',
        category: servicePackage.category,
        name: servicePackage.name,
        description: servicePackage.description,
        pricingMode: 'fixed',
        active: Boolean(servicePackage.active),
        operations: this.db.prepare(`SELECT operation.id, operation.name
          FROM service_package_operations relation
          JOIN service_operations operation ON operation.id = relation.operation_id
          WHERE relation.package_id = ? AND operation.tenant_id = ?
          ORDER BY relation.sequence`).all(servicePackage.id, tenantId),
        prices: this.db.prepare(`SELECT tenant_class, amount_minor, duration_minutes
          FROM service_package_prices WHERE package_id = ? ORDER BY tenant_class`).all(servicePackage.id).map((price) => ({
            tenantClass: price.tenant_class,
            amountMinor: price.amount_minor,
            durationMinutes: price.duration_minutes
          }))
      }));
    return { vehicleClasses, items: [...packages, ...services] };
  }

  updateManagedCatalogItem(tenantId, type, itemId, input) {
    if (!['service', 'package'].includes(type) || typeof input !== 'object' || !input) return { kind: 'invalid' };
    const name = String(input.name ?? '').trim();
    const category = String(input.category ?? '').trim();
    const description = String(input.description ?? '').trim();
    const active = input.active;
    const prices = input.prices;
    const pricingMode = type === 'service' ? String(input.pricingMode ?? '') : 'fixed';
    if (name.length < 2 || name.length > 120 || category.length < 2 || category.length > 80 ||
      description.length > 500 || typeof active !== 'boolean' || !Array.isArray(prices) || prices.length > 100 ||
      (type === 'service' && !['fixed', 'from', 'inspection'].includes(pricingMode))) return { kind: 'invalid' };

    const table = type === 'service' ? 'tenant_services' : 'service_packages';
    const item = this.db.prepare(`SELECT id FROM ${table} WHERE id = ? AND tenant_id = ?`).get(itemId, tenantId);
    if (!item) return { kind: 'not_found' };
    const allowedClasses = new Set(this.db.prepare(`SELECT DISTINCT tenant_class
      FROM tenant_vehicle_class_rules WHERE tenant_id = ?`).all(tenantId).map((row) => row.tenant_class));
    const normalizedPrices = [];
    for (const price of prices) {
      const tenantClass = String(price?.tenantClass ?? '');
      const amountMinor = Number(price?.amountMinor);
      const durationMinutes = Number(price?.durationMinutes);
      if (!allowedClasses.has(tenantClass) || !Number.isInteger(amountMinor) || amountMinor < 0 || amountMinor > 100_000_000 ||
        !Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 1440) return { kind: 'invalid' };
      if (type === 'service') {
        const operationId = String(price?.operationId ?? '');
        const relation = this.db.prepare(`SELECT 1 FROM tenant_service_operations relation
          JOIN service_operations operation ON operation.id = relation.operation_id
          WHERE relation.service_id = ? AND relation.operation_id = ? AND operation.tenant_id = ?`).get(itemId, operationId, tenantId);
        if (!relation) return { kind: 'invalid' };
        normalizedPrices.push({ operationId, tenantClass, amountMinor, durationMinutes });
      } else {
        normalizedPrices.push({ tenantClass, amountMinor, durationMinutes });
      }
    }

    this.db.exec('BEGIN');
    try {
      if (type === 'service') {
        this.db.prepare(`UPDATE tenant_services SET category = ?, name = ?, description = ?, pricing_mode = ?, active = ?
          WHERE id = ? AND tenant_id = ?`).run(category, name, description, pricingMode, Number(active), itemId, tenantId);
        const updatePrice = this.db.prepare(`INSERT INTO service_operation_prices
          (service_id, operation_id, tenant_class, amount_minor, duration_minutes) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(service_id, operation_id, tenant_class) DO UPDATE SET
            amount_minor = excluded.amount_minor, duration_minutes = excluded.duration_minutes`);
        for (const price of normalizedPrices) updatePrice.run(
          itemId, price.operationId, price.tenantClass, price.amountMinor, price.durationMinutes
        );
      } else {
        this.db.prepare(`UPDATE service_packages SET category = ?, name = ?, description = ?, active = ?
          WHERE id = ? AND tenant_id = ?`).run(category, name, description, Number(active), itemId, tenantId);
        const updatePrice = this.db.prepare(`INSERT INTO service_package_prices
          (package_id, tenant_class, amount_minor, duration_minutes) VALUES (?, ?, ?, ?)
          ON CONFLICT(package_id, tenant_class) DO UPDATE SET
            amount_minor = excluded.amount_minor, duration_minutes = excluded.duration_minutes`);
        for (const price of normalizedPrices) updatePrice.run(
          itemId, price.tenantClass, price.amountMinor, price.durationMinutes
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return {
      kind: 'updated',
      item: this.getManagedCatalog(tenantId).items.find((catalogItem) => catalogItem.id === itemId)
    };
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
      if (leadId) {
        this.db.prepare(`INSERT INTO lead_bookings (lead_id, tenant_id, booking_id)
          VALUES (?, ?, ?)`).run(leadId, tenantId, bookingId);
        this.db.prepare(`UPDATE leads SET status = 'CONVERTED', updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND tenant_id = ?`).run(leadId, tenantId);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { kind: 'created', booking: this.getBooking(tenantId, bookingId) };
  }

  isBookingSlotAvailable(tenantId, startAt, durationMinutes, excludeBookingId = null, centerSettings = null) {
    const start = Date.parse(startAt);
    if (!Number.isFinite(start) || !Number.isInteger(durationMinutes) || durationMinutes <= 0) return false;
    const settings = centerSettings ?? this.getCenterSettings(tenantId);
    if (!settings) return false;
    const local = localBookingParts(startAt, settings.timezone);
    const openMinutes = timeToMinutes(settings.openTime);
    const closeMinutes = timeToMinutes(settings.closeTime);
    if (!local || openMinutes === null || closeMinutes === null || !settings.workingDays.includes(local.dayOfWeek) ||
      local.minuteOfDay < openMinutes || local.minuteOfDay + durationMinutes > closeMinutes ||
      (local.minuteOfDay - openMinutes) % settings.slotStepMinutes !== 0) return false;
    const end = start + durationMinutes * 60_000;
    const capacity = settings.simultaneousCapacity;
    const bookings = this.db.prepare(`SELECT id, start_at, estimated_duration_minutes
      FROM bookings WHERE tenant_id = ? AND status = 'CONFIRMED'`).all(tenantId);
    const overlapping = bookings.filter((booking) => {
      if (booking.id === excludeBookingId) return false;
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
    const settings = this.getCenterSettings(tenantId);
    if (!settings) return { kind: 'invalid' };
    const [year, month, day] = date.split('-').map(Number);
    const calendarDate = new Date(Date.UTC(year, month - 1, day));
    if (calendarDate.toISOString().slice(0, 10) !== date) return { kind: 'invalid' };
    if (!settings.workingDays.includes(calendarDate.getUTCDay())) {
      return { kind: 'available', date, durationMinutes, closed: true, slots: [] };
    }
    const openMinutes = timeToMinutes(settings.openTime);
    const closeMinutes = timeToMinutes(settings.closeTime);
    const slots = [];
    for (let minute = openMinutes; minute + durationMinutes <= closeMinutes; minute += settings.slotStepMinutes) {
      const time = minutesToTime(minute);
      const startAt = localDateTime(date, time, settings.timezone);
      slots.push({ time, startAt, available: this.isBookingSlotAvailable(tenantId, startAt, durationMinutes, null, settings) });
    }
    return { kind: 'available', date, durationMinutes, closed: false, slots };
  }

  listBookings(tenantId, limit = 20) {
    const requestedLimit = Number(limit);
    const boundedLimit = Number.isInteger(requestedLimit) ? Math.min(50, Math.max(1, requestedLimit)) : 20;
    return this.db.prepare(`SELECT b.id, b.channel, b.start_at, b.estimated_duration_minutes,
        b.status, b.preliminary_amount_minor,
        c.id customer_id, c.name customer_name, c.phone_display customer_phone,
        v.id vehicle_id, v.make, v.model, v.generation, v.plate_display, v.color,
        w.order_id
      FROM bookings b
      JOIN customers c ON c.id = b.customer_id AND c.tenant_id = b.tenant_id
      JOIN vehicles v ON v.id = b.vehicle_id AND v.tenant_id = b.tenant_id
      LEFT JOIN order_workflows w ON w.booking_id = b.id AND w.tenant_id = b.tenant_id
      WHERE b.tenant_id = ?
      ORDER BY b.start_at DESC, b.rowid DESC
      LIMIT ?`).all(tenantId, boundedLimit).map((row) => ({
        id: row.id,
        channel: row.channel,
        startAt: row.start_at,
        estimatedDurationMinutes: row.estimated_duration_minutes,
        status: row.status,
        preliminaryAmountMinor: row.preliminary_amount_minor,
        orderId: row.order_id ?? null,
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
  }

  updateBooking(tenantId, bookingId, input) {
    const booking = this.db.prepare(`SELECT id, status, estimated_duration_minutes
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
      if (input.status !== 'CANCELLED') return { kind: 'invalid' };
      this.db.prepare(`UPDATE bookings SET status = 'CANCELLED'
        WHERE id = ? AND tenant_id = ?`).run(bookingId, tenantId);
      return { kind: 'updated', booking: this.getBooking(tenantId, bookingId) };
    }

    if (typeof input.startAt !== 'string' || Number.isNaN(Date.parse(input.startAt))) return { kind: 'invalid' };
    if (!this.isBookingSlotAvailable(tenantId, input.startAt, booking.estimated_duration_minutes, bookingId)) {
      return { kind: 'conflict', code: 'slot_unavailable', message: 'Это время уже занято' };
    }
    this.db.prepare(`UPDATE bookings SET start_at = ? WHERE id = ? AND tenant_id = ?`)
      .run(input.startAt, bookingId, tenantId);
    return { kind: 'updated', booking: this.getBooking(tenantId, bookingId) };
  }

  getBooking(tenantId, bookingId) {
    const row = this.db.prepare(`SELECT b.id, b.customer_id, b.vehicle_id, b.channel, b.start_at,
        b.estimated_duration_minutes, b.status, b.preliminary_amount_minor, b.resource_id,
        t.timezone, lead.lead_id
      FROM bookings b
      JOIN tenants t ON t.id = b.tenant_id
      LEFT JOIN lead_bookings lead ON lead.booking_id = b.id AND lead.tenant_id = b.tenant_id
      WHERE b.id = ? AND b.tenant_id = ?`).get(bookingId, tenantId);
    if (!row) return null;
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

  addOrderPhoto(tenantId, orderId, input) {
    const order = this.db.prepare(`SELECT id, status FROM orders WHERE id = ? AND tenant_id = ?`)
      .get(orderId, tenantId);
    if (!order) return { kind: 'not_found' };
    const phase = input.phase === 'result' ? 'result' : 'intake';
    const allowedStatus = phase === 'result' ? order.status === 'READY' : ['INTAKE', 'ESTIMATE_DRAFT'].includes(order.status);
    if (!allowedStatus) return { kind: 'conflict', code: 'invalid_order_state', message: phase === 'result'
      ? 'Фото результата можно добавить только перед выдачей'
      : 'В закрытую приёмку нельзя добавлять фото' };
    const kind = String(input.kind ?? 'intake');
    const zone = String(input.zone ?? '').trim();
    const dataUrl = String(input.dataUrl ?? '');
    const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
    const bytes = match ? Buffer.from(match[2], 'base64') : null;
    const currentCount = this.db.prepare(`SELECT COUNT(*) AS count FROM order_photos
      WHERE tenant_id = ? AND order_id = ?`).get(tenantId, orderId).count;
    if (!['intake', 'defect'].includes(kind) || (phase === 'result' && kind !== 'intake') || !zone || zone.length > 80 || !bytes ||
      bytes.length < 1 || bytes.length > 700 * 1024 || currentCount >= 20 || (phase === 'intake' && currentCount >= 19)) return { kind: 'invalid' };

    const id = `photo_${randomUUID()}`;
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO order_photos
        (id, tenant_id, order_id, kind, zone, mime_type, data_url)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, tenantId, orderId, kind, zone, match[1], dataUrl);
      if (phase === 'result') this.db.prepare(`INSERT INTO order_result_photos
        (photo_id, tenant_id, order_id) VALUES (?, ?, ?)`).run(id, tenantId, orderId);
      this.insertOrderAudit(tenantId, orderId, phase === 'result' ? 'RESULT_PHOTO_ADDED' : 'INTAKE_PHOTO_ADDED', {
        photoId: id, kind, zone
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    const photo = this.db.prepare(`SELECT id, kind, zone, mime_type, data_url, created_at
      FROM order_photos WHERE id = ? AND tenant_id = ?`).get(id, tenantId);
    return { kind: 'created', photo: {
      id: photo.id,
      phase,
      kind: photo.kind,
      zone: photo.zone,
      mimeType: photo.mime_type,
      dataUrl: photo.data_url,
      createdAt: apiTimestamp(photo.created_at)
    } };
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

  assignOrderMaster(tenantId, orderId, input) {
    const masterName = String(input?.masterName ?? '').trim();
    if (masterName.length < 2 || masterName.length > 120) return { kind: 'invalid' };
    const order = this.db.prepare(`SELECT id, status FROM orders WHERE id = ? AND tenant_id = ?`)
      .get(orderId, tenantId);
    if (!order) return { kind: 'not_found' };
    if (order.status !== 'APPROVED') {
      return { kind: 'conflict', code: 'invalid_order_state', message: 'Мастера можно назначить после согласования сметы' };
    }
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO order_assignments (order_id, tenant_id, master_name, assigned_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(order_id) DO UPDATE SET master_name = excluded.master_name, assigned_at = CURRENT_TIMESTAMP`)
        .run(orderId, tenantId, masterName);
      this.insertOrderAudit(tenantId, orderId, 'MASTER_ASSIGNED', { masterName });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { kind: 'updated', order: this.getOrder(tenantId, orderId) };
  }

  startOrderWork(tenantId, orderId) {
    const order = this.db.prepare(`SELECT o.status, w.current_estimate_version_id, a.master_name
      FROM orders o
      JOIN order_workflows w ON w.order_id = o.id AND w.tenant_id = o.tenant_id
      LEFT JOIN order_assignments a ON a.order_id = o.id AND a.tenant_id = o.tenant_id
      WHERE o.id = ? AND o.tenant_id = ?`).get(orderId, tenantId);
    if (!order) return { kind: 'not_found' };
    if (order.status !== 'APPROVED' || !order.master_name || !order.current_estimate_version_id) {
      return { kind: 'conflict', code: 'invalid_order_state', message: 'Нужны согласованная смета и назначенный мастер' };
    }
    if (this.db.prepare('SELECT order_id FROM order_work_runs WHERE order_id = ?').get(orderId)) {
      return { kind: 'conflict', code: 'work_already_started', message: 'Работы уже начаты' };
    }
    const lines = this.db.prepare(`SELECT id, name, amount_minor FROM estimate_lines
      WHERE estimate_version_id = ? ORDER BY sequence`).all(order.current_estimate_version_id);
    if (!lines.length) return { kind: 'conflict', code: 'estimate_empty', message: 'В согласованной смете нет операций' };

    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO order_work_runs (order_id, tenant_id, status) VALUES (?, ?, 'ACTIVE')`)
        .run(orderId, tenantId);
      const insertOperation = this.db.prepare(`INSERT INTO order_work_operations
        (id, tenant_id, order_id, estimate_line_id, source, sequence, name, amount_minor)
        VALUES (?, ?, ?, ?, 'estimate', ?, ?, ?)`);
      lines.forEach((line, index) => insertOperation.run(
        `work_operation_${randomUUID()}`, tenantId, orderId, line.id, index + 1, line.name, line.amount_minor
      ));
      this.db.prepare(`UPDATE orders SET status = 'IN_PROGRESS' WHERE id = ? AND tenant_id = ?`).run(orderId, tenantId);
      this.insertOrderAudit(tenantId, orderId, 'WORK_STARTED', { masterName: order.master_name });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { kind: 'updated', order: this.getOrder(tenantId, orderId) };
  }

  updateWorkOperation(tenantId, orderId, operationId, input) {
    const status = input?.status;
    const note = String(input?.note ?? '').trim();
    if (!['PENDING', 'DONE', 'BLOCKED'].includes(status) || note.length > 500) return { kind: 'invalid' };
    const order = this.db.prepare(`SELECT o.status, r.status work_status FROM orders o
      JOIN order_work_runs r ON r.order_id = o.id AND r.tenant_id = o.tenant_id
      WHERE o.id = ? AND o.tenant_id = ?`).get(orderId, tenantId);
    if (!order) return { kind: 'not_found' };
    if (order.status !== 'IN_PROGRESS' || order.work_status !== 'ACTIVE') {
      return { kind: 'conflict', code: 'invalid_order_state', message: 'Операции доступны только во время работ' };
    }
    const result = this.db.prepare(`UPDATE order_work_operations
      SET status = ?, note = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND order_id = ? AND tenant_id = ?`).run(status, note || null, operationId, orderId, tenantId);
    if (!result.changes) return { kind: 'not_found' };
    this.insertOrderAudit(tenantId, orderId, 'WORK_OPERATION_UPDATED', { operationId, status });
    return { kind: 'updated', order: this.getOrder(tenantId, orderId) };
  }

  setWorkPause(tenantId, orderId, paused, input = {}) {
    const note = String(input?.note ?? '').trim();
    if (paused && (note.length < 3 || note.length > 500)) return { kind: 'invalid' };
    const order = this.db.prepare(`SELECT o.status, r.status work_status FROM orders o
      JOIN order_work_runs r ON r.order_id = o.id AND r.tenant_id = o.tenant_id
      WHERE o.id = ? AND o.tenant_id = ?`).get(orderId, tenantId);
    if (!order) return { kind: 'not_found' };
    const expected = paused ? 'ACTIVE' : 'PAUSED';
    if (order.status !== 'IN_PROGRESS' || order.work_status !== expected) {
      return { kind: 'conflict', code: 'invalid_order_state', message: paused ? 'Работы нельзя поставить на паузу' : 'Работы не находятся на паузе' };
    }
    this.db.prepare(`UPDATE order_work_runs SET status = ?, pause_note = ?, updated_at = CURRENT_TIMESTAMP
      WHERE order_id = ? AND tenant_id = ?`).run(paused ? 'PAUSED' : 'ACTIVE', paused ? note : null, orderId, tenantId);
    this.insertOrderAudit(tenantId, orderId, paused ? 'WORK_PAUSED' : 'WORK_RESUMED', paused ? { note } : {});
    return { kind: 'updated', order: this.getOrder(tenantId, orderId) };
  }

  completeOrderWork(tenantId, orderId, { qualityControlEnabled = false } = {}) {
    const order = this.db.prepare(`SELECT o.status, r.status work_status FROM orders o
      JOIN order_work_runs r ON r.order_id = o.id AND r.tenant_id = o.tenant_id
      WHERE o.id = ? AND o.tenant_id = ?`).get(orderId, tenantId);
    if (!order) return { kind: 'not_found' };
    if (order.status !== 'IN_PROGRESS' || order.work_status !== 'ACTIVE') {
      return { kind: 'conflict', code: 'invalid_order_state', message: 'Активные работы не найдены' };
    }
    const incomplete = this.db.prepare(`SELECT COUNT(*) count FROM order_work_operations
      WHERE order_id = ? AND tenant_id = ? AND status != 'DONE'`).get(orderId, tenantId).count;
    if (incomplete) return { kind: 'conflict', code: 'operations_incomplete', message: 'Завершите все согласованные операции' };
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`UPDATE order_work_runs SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP WHERE order_id = ? AND tenant_id = ?`).run(orderId, tenantId);
      const nextStatus = qualityControlEnabled ? 'QC' : 'READY';
      this.db.prepare(`UPDATE orders SET status = ? WHERE id = ? AND tenant_id = ?`).run(nextStatus, orderId, tenantId);
      this.insertOrderAudit(tenantId, orderId, 'WORK_COMPLETED', { nextStatus });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { kind: 'updated', order: this.getOrder(tenantId, orderId) };
  }

  releaseDeprecatedQualityControlOrders() {
    const orders = this.db.prepare(`SELECT id, tenant_id FROM orders WHERE status = 'QC'`).all();
    if (!orders.length) return 0;
    this.db.exec('BEGIN');
    try {
      for (const order of orders) {
        this.db.prepare(`UPDATE orders SET status = 'READY' WHERE id = ? AND tenant_id = ?`).run(order.id, order.tenant_id);
        this.insertOrderAudit(order.tenant_id, order.id, 'QC_DEPRECATED_BYPASS', { nextStatus: 'READY' });
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return orders.length;
  }

  submitQualityControl(tenantId, orderId, input) {
    const decision = input?.decision;
    const responsible = String(input?.responsible ?? '').trim();
    const note = String(input?.note ?? '').trim();
    const checks = Array.isArray(input?.checks) ? input.checks : null;
    const validCheck = (check) => check && typeof check.code === 'string' && check.code.trim() &&
      typeof check.label === 'string' && check.label.trim() && typeof check.passed === 'boolean';
    if (!['PASSED', 'REWORK'].includes(decision) || responsible.length < 2 || note.length < 2 ||
      !checks || checks.length < 1 || checks.length > 20 || checks.some((check) => !validCheck(check))) return { kind: 'invalid' };
    if (decision === 'PASSED' && checks.some((check) => !check.passed)) {
      return { kind: 'conflict', code: 'qc_checks_failed', message: 'Нельзя допустить к выдаче с непройденными проверками' };
    }
    if (decision === 'REWORK' && checks.every((check) => check.passed)) {
      return { kind: 'conflict', code: 'qc_rework_without_failure', message: 'Укажите замечание для доработки' };
    }
    const order = this.db.prepare(`SELECT status FROM orders WHERE id = ? AND tenant_id = ?`).get(orderId, tenantId);
    if (!order) return { kind: 'not_found' };
    if (order.status !== 'QC') return { kind: 'conflict', code: 'invalid_order_state', message: 'Заказ не находится на контроле качества' };

    const inspectionId = `qc_${randomUUID()}`;
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO qc_inspections
        (id, tenant_id, order_id, decision, responsible, note) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(inspectionId, tenantId, orderId, decision, responsible, note);
      const insertCheck = this.db.prepare(`INSERT INTO qc_check_items
        (id, inspection_id, code, label, passed) VALUES (?, ?, ?, ?, ?)`);
      for (const check of checks) insertCheck.run(
        `qc_check_${randomUUID()}`, inspectionId, check.code.trim(), check.label.trim(), check.passed ? 1 : 0
      );
      if (decision === 'PASSED') {
        this.db.prepare(`UPDATE orders SET status = 'READY' WHERE id = ? AND tenant_id = ?`).run(orderId, tenantId);
      } else {
        let sequence = this.db.prepare(`SELECT COALESCE(MAX(sequence), 0) max_sequence
          FROM order_work_operations WHERE order_id = ? AND tenant_id = ?`).get(orderId, tenantId).max_sequence;
        const insertRework = this.db.prepare(`INSERT INTO order_work_operations
          (id, tenant_id, order_id, source, sequence, name, amount_minor, status, note)
          VALUES (?, ?, ?, 'qc_rework', ?, ?, 0, 'PENDING', ?)`);
        for (const check of checks.filter((item) => !item.passed)) {
          sequence += 1;
          insertRework.run(`work_operation_${randomUUID()}`, tenantId, orderId, sequence, `Доработка: ${check.label.trim()}`, note);
        }
        this.db.prepare(`UPDATE order_work_runs SET status = 'ACTIVE', completed_at = NULL,
          updated_at = CURRENT_TIMESTAMP WHERE order_id = ? AND tenant_id = ?`).run(orderId, tenantId);
        this.db.prepare(`UPDATE orders SET status = 'IN_PROGRESS' WHERE id = ? AND tenant_id = ?`).run(orderId, tenantId);
      }
      this.insertOrderAudit(tenantId, orderId, decision === 'PASSED' ? 'QC_PASSED' : 'QC_REWORK', {
        inspectionId, responsible, failedChecks: checks.filter((check) => !check.passed).map((check) => check.code)
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { kind: 'updated', order: this.getOrder(tenantId, orderId) };
  }

  closeOrderHandover(tenantId, orderId, input) {
    const responsible = String(input?.responsible ?? '').trim();
    const note = String(input?.note ?? '').trim();
    if (responsible.length < 2 || note.length < 2) return { kind: 'invalid' };
    const order = this.db.prepare(`SELECT status FROM orders WHERE id = ? AND tenant_id = ?`).get(orderId, tenantId);
    if (!order) return { kind: 'not_found' };
    if (order.status !== 'READY') return { kind: 'conflict', code: 'invalid_order_state', message: 'Заказ не готов к выдаче' };
    const photos = this.db.prepare(`SELECT
        SUM(CASE WHEN result.photo_id IS NULL THEN 1 ELSE 0 END) AS intake_count,
        SUM(CASE WHEN result.photo_id IS NOT NULL THEN 1 ELSE 0 END) AS result_count
      FROM order_photos photo
      LEFT JOIN order_result_photos result ON result.photo_id = photo.id AND result.tenant_id = photo.tenant_id
      WHERE photo.order_id = ? AND photo.tenant_id = ?`).get(orderId, tenantId);
    if (!photos.intake_count || !photos.result_count) return {
      kind: 'conflict', code: 'handover_photos_required', message: 'Добавьте фото автомобиля до и после работ'
    };
    const customerAccepted = input?.customerAccepted === true;
    const completenessChecked = input?.completenessChecked === true;
    if (!customerAccepted || !completenessChecked) return { kind: 'invalid' };

    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO order_handovers (order_id, tenant_id, responsible, note)
        VALUES (?, ?, ?, ?)`).run(orderId, tenantId, responsible, note);
      this.db.prepare(`UPDATE orders SET status = 'CLOSED' WHERE id = ? AND tenant_id = ?`).run(orderId, tenantId);
      this.insertOrderAudit(tenantId, orderId, 'ORDER_CLOSED', {
        responsible, note, customerAccepted, completenessChecked
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { kind: 'updated', order: this.getOrder(tenantId, orderId) };
  }

  listOrders(tenantId, limit = 20) {
    const requestedLimit = Number(limit);
    const boundedLimit = Number.isInteger(requestedLimit) ? Math.min(50, Math.max(1, requestedLimit)) : 20;
    return this.db.prepare(`SELECT o.id, o.status, o.created_at,
        c.id customer_id, c.name customer_name, c.phone_display customer_phone,
        v.id vehicle_id, v.make, v.model, v.generation, v.plate_display, v.color,
        e.total_amount_minor, a.master_name
      FROM orders o
      JOIN customers c ON c.id = o.customer_id AND c.tenant_id = o.tenant_id
      JOIN vehicles v ON v.id = o.vehicle_id AND v.tenant_id = o.tenant_id
      LEFT JOIN order_workflows w ON w.order_id = o.id AND w.tenant_id = o.tenant_id
      LEFT JOIN estimate_versions e ON e.id = w.current_estimate_version_id AND e.tenant_id = o.tenant_id
      LEFT JOIN order_assignments a ON a.order_id = o.id AND a.tenant_id = o.tenant_id
      WHERE o.tenant_id = ?
      ORDER BY o.created_at DESC, o.rowid DESC
      LIMIT ?`).all(tenantId, boundedLimit).map((row) => ({
        id: row.id,
        status: row.status,
        createdAt: apiTimestamp(row.created_at),
        totalAmountMinor: row.total_amount_minor ?? null,
        masterName: row.master_name ?? null,
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
  }

  getAnalyticsOverview(tenantId, from, to) {
    const bookingRows = this.db.prepare(`SELECT status, COUNT(*) count
      FROM bookings
      WHERE tenant_id = ? AND substr(start_at, 1, 10) BETWEEN ? AND ?
      GROUP BY status`).all(tenantId, from, to);
    const bookingCounts = Object.fromEntries(bookingRows.map((row) => [row.status, Number(row.count)]));

    const orderRows = this.db.prepare(`SELECT status, COUNT(*) count
      FROM orders
      WHERE tenant_id = ? AND date(created_at) BETWEEN ? AND ?
      GROUP BY status ORDER BY status`).all(tenantId, from, to);
    const orderStatuses = orderRows.map((row) => ({ status: row.status, count: Number(row.count) }));
    const ordersTotal = orderStatuses.reduce((sum, item) => sum + item.count, 0);
    const statusCount = (status) => orderStatuses.find((item) => item.status === status)?.count ?? 0;

    const approvedEstimates = this.db.prepare(`SELECT
        COALESCE(SUM(e.total_amount_minor), 0) amount,
        COUNT(e.id) count
      FROM orders o
      JOIN order_workflows w ON w.order_id = o.id AND w.tenant_id = o.tenant_id
      JOIN estimate_versions e ON e.id = w.current_estimate_version_id AND e.tenant_id = o.tenant_id
      WHERE o.tenant_id = ? AND date(o.created_at) BETWEEN ? AND ?
        AND EXISTS (
          SELECT 1 FROM estimate_approvals a
          WHERE a.order_id = o.id AND a.tenant_id = o.tenant_id
            AND a.estimate_version_id = e.id AND a.decision = 'APPROVED'
        )`).get(tenantId, from, to);

    const operationRows = this.db.prepare(`SELECT op.status, COUNT(*) count
      FROM order_work_operations op
      JOIN orders o ON o.id = op.order_id AND o.tenant_id = op.tenant_id
      WHERE op.tenant_id = ? AND date(o.created_at) BETWEEN ? AND ?
      GROUP BY op.status`).all(tenantId, from, to);
    const operationCounts = Object.fromEntries(operationRows.map((row) => [row.status, Number(row.count)]));
    const operationsTotal = operationRows.reduce((sum, row) => sum + Number(row.count), 0);
    const operationsDone = operationCounts.DONE ?? 0;

    const dailyBookings = this.db.prepare(`SELECT substr(start_at, 1, 10) date, COUNT(*) count
      FROM bookings WHERE tenant_id = ? AND substr(start_at, 1, 10) BETWEEN ? AND ?
      GROUP BY substr(start_at, 1, 10)`).all(tenantId, from, to);
    const dailyOrders = this.db.prepare(`SELECT date(created_at) date,
        COUNT(*) count, SUM(CASE WHEN status = 'CLOSED' THEN 1 ELSE 0 END) closed
      FROM orders WHERE tenant_id = ? AND date(created_at) BETWEEN ? AND ?
      GROUP BY date(created_at)`).all(tenantId, from, to);
    const bookingDays = new Map(dailyBookings.map((row) => [row.date, Number(row.count)]));
    const orderDays = new Map(dailyOrders.map((row) => [row.date, {
      orders: Number(row.count), closed: Number(row.closed)
    }]));
    const daily = [];
    for (let cursor = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`); cursor <= end; cursor += 86_400_000) {
      const date = new Date(cursor).toISOString().slice(0, 10);
      daily.push({
        date,
        bookings: bookingDays.get(date) ?? 0,
        orders: orderDays.get(date)?.orders ?? 0,
        closed: orderDays.get(date)?.closed ?? 0
      });
    }

    const approvedAmount = Number(approvedEstimates.amount);
    const approvedCount = Number(approvedEstimates.count);
    return {
      period: { from, to },
      bookings: {
        total: bookingRows.reduce((sum, row) => sum + Number(row.count), 0),
        confirmed: bookingCounts.CONFIRMED ?? 0,
        cancelled: bookingCounts.CANCELLED ?? 0
      },
      orders: {
        total: ordersTotal,
        active: ordersTotal - statusCount('READY') - statusCount('CLOSED'),
        ready: statusCount('READY'),
        closed: statusCount('CLOSED'),
        approvedEstimateAmountMinor: approvedAmount,
        averageApprovedEstimateAmountMinor: approvedCount ? Math.round(approvedAmount / approvedCount) : 0
      },
      operations: {
        total: operationsTotal,
        done: operationsDone,
        blocked: operationCounts.BLOCKED ?? 0,
        completionPercent: operationsTotal ? Math.round(operationsDone / operationsTotal * 100) : 0
      },
      orderStatuses,
      daily
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
    const assignment = this.db.prepare(`SELECT master_name, assigned_at FROM order_assignments
      WHERE order_id = ? AND tenant_id = ?`).get(orderId, tenantId);
    const workRun = this.db.prepare(`SELECT status, pause_note, started_at, updated_at, completed_at
      FROM order_work_runs WHERE order_id = ? AND tenant_id = ?`).get(orderId, tenantId);
    const handover = this.db.prepare(`SELECT responsible, note, handed_over_at FROM order_handovers
      WHERE order_id = ? AND tenant_id = ?`).get(orderId, tenantId);
    return {
      id: row.id,
      customerId: row.customer_id,
      vehicleId: row.vehicle_id,
      status: row.status,
      createdAt: apiTimestamp(row.created_at),
      bookingId: row.booking_id ?? null,
      currentEstimateVersionId: row.current_estimate_version_id ?? null,
      photos: this.db.prepare(`SELECT photo.id, photo.kind, photo.zone, photo.mime_type, photo.data_url, photo.created_at,
          CASE WHEN result.photo_id IS NULL THEN 'intake' ELSE 'result' END AS phase
        FROM order_photos photo
        LEFT JOIN order_result_photos result ON result.photo_id = photo.id AND result.tenant_id = photo.tenant_id
        WHERE photo.order_id = ? AND photo.tenant_id = ? ORDER BY photo.created_at, photo.rowid`).all(orderId, tenantId)
        .map((photo) => ({
          id: photo.id,
          phase: photo.phase,
          kind: photo.kind,
          zone: photo.zone,
          mimeType: photo.mime_type,
          dataUrl: photo.data_url,
          createdAt: apiTimestamp(photo.created_at)
        })),
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
      assignment: assignment ? {
        masterName: assignment.master_name,
        assignedAt: apiTimestamp(assignment.assigned_at)
      } : null,
      work: workRun ? {
        status: workRun.status,
        pauseNote: workRun.pause_note,
        startedAt: apiTimestamp(workRun.started_at),
        updatedAt: apiTimestamp(workRun.updated_at),
        completedAt: apiTimestamp(workRun.completed_at),
        operations: this.db.prepare(`SELECT id, source, name, amount_minor, status, note, updated_at
          FROM order_work_operations WHERE order_id = ? AND tenant_id = ? ORDER BY sequence`).all(orderId, tenantId).map((operation) => ({
            id: operation.id,
            source: operation.source,
            name: operation.name,
            amountMinor: operation.amount_minor,
            status: operation.status,
            note: operation.note,
            updatedAt: apiTimestamp(operation.updated_at)
          }))
      } : null,
      qualityControl: this.db.prepare(`SELECT id, decision, responsible, note, created_at
        FROM qc_inspections WHERE order_id = ? AND tenant_id = ? ORDER BY created_at, rowid`).all(orderId, tenantId).map((inspection) => ({
          id: inspection.id,
          decision: inspection.decision,
          responsible: inspection.responsible,
          note: inspection.note,
          createdAt: apiTimestamp(inspection.created_at),
          checks: this.db.prepare(`SELECT code, label, passed FROM qc_check_items
            WHERE inspection_id = ? ORDER BY rowid`).all(inspection.id).map((check) => ({
              code: check.code, label: check.label, passed: Boolean(check.passed)
            }))
        })),
      handover: handover ? {
        responsible: handover.responsible,
        note: handover.note,
        handedOverAt: apiTimestamp(handover.handed_over_at)
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
