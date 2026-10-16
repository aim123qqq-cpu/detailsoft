import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { normalizePhone, normalizePlate, normalizeSearch } from './domain/normalize.mjs';

function mapVehicle(row) {
  return {
    id: row.id,
    catalogVariantId: row.catalog_variant_id ?? null,
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

function mapTeamMember(row) {
  return {
    id: row.id,
    displayName: row.display_name,
    roles: JSON.parse(row.roles_json),
    status: row.status,
    createdAt: apiTimestamp(row.created_at),
    updatedAt: apiTimestamp(row.updated_at)
  };
}

const assignableTeamRoles = ['owner', 'admin', 'intake', 'master'];

function timeToMinutes(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value ?? ''));
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
}

function calendarDateTimestamp(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  if (!match) return null;
  const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Date(timestamp).toISOString().slice(0, 10) === value ? timestamp : null;
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

  authenticateTeamToken(token) {
    if (!token) return null;
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const row = this.db.prepare(`SELECT member.tenant_id, member.display_name, member.roles_json
      FROM tenant_member_tokens token
      JOIN tenant_members member ON member.id = token.member_id AND member.tenant_id = token.tenant_id
      WHERE token.token_hash = ? AND member.status = 'active'`).get(tokenHash);
    return row ? {
      tenantId: row.tenant_id,
      displayName: row.display_name,
      roles: JSON.parse(row.roles_json)
    } : null;
  }

  listTeamMembers(tenantId) {
    return this.db.prepare(`SELECT id, display_name, roles_json, status, created_at, updated_at
      FROM tenant_members WHERE tenant_id = ?
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, display_name COLLATE NOCASE`)
      .all(tenantId).map(mapTeamMember);
  }

  createTeamMember(tenantId, input) {
    const displayName = String(input?.displayName ?? '').trim();
    const roles = Array.isArray(input?.roles) ? [...new Set(input.roles)].sort() : [];
    if (displayName.length < 2 || displayName.length > 80 || !roles.length ||
      roles.some((role) => !assignableTeamRoles.includes(role))) return { kind: 'invalid' };
    const id = `member_${randomUUID()}`;
    const accessToken = `df_${randomBytes(24).toString('hex')}`;
    const tokenHash = createHash('sha256').update(accessToken).digest('hex');
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO tenant_members
        (id, tenant_id, display_name, roles_json) VALUES (?, ?, ?, ?)`)
        .run(id, tenantId, displayName, JSON.stringify(roles));
      this.db.prepare(`INSERT INTO tenant_member_tokens
        (id, tenant_id, member_id, token_hash) VALUES (?, ?, ?, ?)`)
        .run(`member_token_${randomUUID()}`, tenantId, id, tokenHash);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    const member = this.db.prepare(`SELECT id, display_name, roles_json, status, created_at, updated_at
      FROM tenant_members WHERE id = ? AND tenant_id = ?`).get(id, tenantId);
    return { kind: 'created', member: mapTeamMember(member), accessToken };
  }

  updateTeamMember(tenantId, memberId, input) {
    const current = this.db.prepare(`SELECT id, display_name, roles_json, status, created_at, updated_at
      FROM tenant_members WHERE id = ? AND tenant_id = ?`).get(memberId, tenantId);
    if (!current) return { kind: 'not_found' };
    const hasRoles = Array.isArray(input?.roles);
    const hasStatus = input?.status !== undefined;
    if (!hasRoles && !hasStatus) return { kind: 'invalid' };
    const roles = hasRoles ? [...new Set(input.roles)].sort() : JSON.parse(current.roles_json);
    const status = hasStatus ? input.status : current.status;
    if (!roles.length || roles.some((role) => !assignableTeamRoles.includes(role)) ||
      !['active', 'blocked'].includes(status)) return { kind: 'invalid' };
    const wasActiveOwner = current.status === 'active' && JSON.parse(current.roles_json).includes('owner');
    const remainsActiveOwner = status === 'active' && roles.includes('owner');
    if (wasActiveOwner && !remainsActiveOwner) {
      const activeOwners = this.db.prepare(`SELECT roles_json FROM tenant_members
        WHERE tenant_id = ? AND status = 'active'`).all(tenantId)
        .filter((member) => JSON.parse(member.roles_json).includes('owner')).length;
      if (activeOwners <= 1) return { kind: 'conflict' };
    }
    this.db.prepare(`UPDATE tenant_members SET roles_json = ?, status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND tenant_id = ?`).run(JSON.stringify(roles), status, memberId, tenantId);
    const updated = this.db.prepare(`SELECT id, display_name, roles_json, status, created_at, updated_at
      FROM tenant_members WHERE id = ? AND tenant_id = ?`).get(memberId, tenantId);
    return { kind: 'updated', member: mapTeamMember(updated) };
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
      id, name, phoneDisplay, visitCount: 0, archived: false, vehicles: []
    } };
  }

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
  }

  insertCustomerAudit(tenantId, customerId, eventType, details, actorName) {
    this.db.prepare(`INSERT INTO customer_audit_events
      (id, tenant_id, customer_id, event_type, details_json, actor_name)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
        `ca_${randomUUID()}`, tenantId, customerId, eventType, JSON.stringify(details), actorName ?? null
      );
  }

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
  }

  getCustomerActiveWork(tenantId, customerId) {
    const row = this.db.prepare(`SELECT
        (SELECT COUNT(*) FROM bookings b WHERE b.tenant_id = ?1 AND b.customer_id = ?2 AND b.status = 'CONFIRMED'
          AND NOT EXISTS (SELECT 1 FROM order_workflows w WHERE w.booking_id = b.id AND w.tenant_id = b.tenant_id)) confirmed_bookings,
        (SELECT COUNT(*) FROM orders WHERE tenant_id = ?1 AND customer_id = ?2 AND status <> 'CLOSED') open_orders,
        (SELECT COUNT(*) FROM leads WHERE tenant_id = ?1 AND customer_id = ?2 AND status IN ('NEW', 'CONTACTED')) active_leads`)
      .get(tenantId, customerId);
    return { confirmedBookings: row.confirmed_bookings, openOrders: row.open_orders, activeLeads: row.active_leads };
  }

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
  }

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
  }

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

  listVehicleClasses(tenantId) {
    return this.db.prepare(`SELECT DISTINCT tenant_class FROM tenant_vehicle_class_rules
      WHERE tenant_id = ? ORDER BY tenant_class`).all(tenantId).map((row) => row.tenant_class);
  }

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

    const vehicleId = `veh_${randomUUID()}`;
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
  }

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
  }

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
  }

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
  }

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
  }

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
    const operationLibrary = this.db.prepare(`SELECT id, name, active
      FROM service_operations WHERE tenant_id = ? ORDER BY active DESC, name`).all(tenantId).map((operation) => ({
        id: operation.id,
        name: operation.name,
        active: Boolean(operation.active)
      }));
    return { vehicleClasses, operationLibrary, items: [...packages, ...services] };
  }

  // SQLite lower() only folds ASCII, so names are compared with the same normalizer as search.
  findOperationByName(tenantId, name, excludeId = null) {
    const target = normalizeSearch(name);
    return this.db.prepare('SELECT id, name FROM service_operations WHERE tenant_id = ?').all(tenantId)
      .find((operation) => operation.id !== excludeId && normalizeSearch(operation.name) === target) ?? null;
  }

  listOperationLibrary(tenantId, query = '') {
    const usage = (sql) => this.db.prepare(sql).all(tenantId).reduce((map, row) => {
      const list = map.get(row.operation_id) ?? [];
      list.push({ id: row.id, name: row.name, active: row.active === 1 });
      map.set(row.operation_id, list);
      return map;
    }, new Map());
    const services = usage(`SELECT relation.operation_id, s.id, s.name, s.active FROM tenant_service_operations relation
      JOIN tenant_services s ON s.id = relation.service_id WHERE s.tenant_id = ? ORDER BY s.name`);
    const packages = usage(`SELECT relation.operation_id, p.id, p.name, p.active FROM service_package_operations relation
      JOIN service_packages p ON p.id = relation.package_id WHERE p.tenant_id = ? ORDER BY p.name`);
    const terms = normalizeSearch(query).split(' ').filter(Boolean);
    return this.db.prepare('SELECT id, name, active FROM service_operations WHERE tenant_id = ?').all(tenantId)
      .filter((operation) => terms.every((term) => normalizeSearch(operation.name).includes(term)))
      .map((operation) => {
        const usedBy = { services: services.get(operation.id) ?? [], packages: packages.get(operation.id) ?? [] };
        return {
          id: operation.id,
          name: operation.name,
          active: operation.active === 1,
          usage: { ...usedBy, activeCount: [...usedBy.services, ...usedBy.packages].filter((item) => item.active).length }
        };
      })
      .sort((left, right) => Number(right.active) - Number(left.active) || left.name.localeCompare(right.name, 'ru'));
  }

  /** Rename affects only future quotes (bookings and estimates store snapshots); archiving is refused while active items use it. */
  updateCatalogOperation(tenantId, operationId, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { kind: 'invalid' };
    const keys = Object.keys(input);
    if (!keys.length || keys.some((key) => !['name', 'active'].includes(key))) return { kind: 'invalid' };
    const name = Object.hasOwn(input, 'name') ? (typeof input.name === 'string' ? input.name.trim() : null) : undefined;
    if (name === null || (name !== undefined && (name.length < 2 || name.length > 120))) return { kind: 'invalid' };
    if (Object.hasOwn(input, 'active') && typeof input.active !== 'boolean') return { kind: 'invalid' };
    const operation = this.db.prepare('SELECT id, name, active FROM service_operations WHERE id = ? AND tenant_id = ?').get(operationId, tenantId);
    if (!operation) return { kind: 'not_found' };
    if (name !== undefined && this.findOperationByName(tenantId, name, operationId)) return { kind: 'duplicate' };
    if (input.active === false && operation.active === 1) {
      const current = this.listOperationLibrary(tenantId).find((item) => item.id === operationId);
      const activeServices = current.usage.services.filter((item) => item.active);
      const activePackages = current.usage.packages.filter((item) => item.active);
      if (activeServices.length || activePackages.length) return {
        kind: 'conflict', code: 'operation_in_use',
        message: 'Операция входит в активные услуги или пакеты. Уберите её оттуда или переведите их в архив',
        details: { services: activeServices, packages: activePackages }
      };
    }
    this.db.prepare('UPDATE service_operations SET name = ?, active = ? WHERE id = ? AND tenant_id = ?').run(
      name ?? operation.name, input.active === undefined ? operation.active : Number(input.active), operationId, tenantId
    );
    return { kind: 'updated', operation: this.listOperationLibrary(tenantId).find((item) => item.id === operationId) };
  }

  createCatalogOperation(tenantId, input) {
    const name = String(input?.name ?? '').trim();
    if (name.length < 2 || name.length > 120) return { kind: 'invalid' };
    if (this.findOperationByName(tenantId, name)) return { kind: 'duplicate' };
    const operation = { id: `op_${randomUUID()}`, name, active: true };
    this.db.prepare(`INSERT INTO service_operations (id, tenant_id, name, active)
      VALUES (?, ?, ?, 1)`).run(operation.id, tenantId, name);
    return { kind: 'created', operation };
  }

  createManagedCatalogItem(tenantId, type, input) {
    if (!['service', 'package'].includes(type) || !input || typeof input !== 'object') return { kind: 'invalid' };
    const name = String(input.name ?? '').trim();
    const category = String(input.category ?? '').trim();
    const description = String(input.description ?? '').trim();
    const pricingMode = type === 'service' ? String(input.pricingMode ?? '') : 'fixed';
    const vehicleClasses = this.db.prepare(`SELECT DISTINCT tenant_class FROM tenant_vehicle_class_rules
      WHERE tenant_id = ?`).all(tenantId).map((row) => row.tenant_class);
    if (name.length < 2 || name.length > 120 || category.length < 2 || category.length > 80 ||
      description.length > 500 || !vehicleClasses.length ||
      (type === 'service' && !['fixed', 'from', 'inspection'].includes(pricingMode))) return { kind: 'invalid' };

    let operationIds;
    let operationPrices = [];
    let amountMinor;
    let durationMinutes;
    if (type === 'service') {
      if (!Array.isArray(input.operationPrices) || !input.operationPrices.length || input.operationPrices.length > 50) return { kind: 'invalid' };
      operationPrices = input.operationPrices.map((price) => ({
        operationId: String(price?.operationId ?? ''),
        amountMinor: Number(price?.amountMinor),
        durationMinutes: Number(price?.durationMinutes)
      }));
      operationIds = operationPrices.map((price) => price.operationId);
      if (new Set(operationIds).size !== operationIds.length || operationPrices.some((price) =>
        !Number.isInteger(price.amountMinor) || price.amountMinor < 0 || price.amountMinor > 100_000_000 ||
        !Number.isInteger(price.durationMinutes) || price.durationMinutes < 1 || price.durationMinutes > 1440)) return { kind: 'invalid' };
    } else {
      if (!Array.isArray(input.operationIds) || !input.operationIds.length || input.operationIds.length > 50) return { kind: 'invalid' };
      operationIds = [...new Set(input.operationIds.map((id) => String(id)))];
      amountMinor = Number(input.amountMinor);
      durationMinutes = Number(input.durationMinutes);
      if (operationIds.length !== input.operationIds.length || !Number.isInteger(amountMinor) || amountMinor < 0 || amountMinor > 100_000_000 ||
        !Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 1440) return { kind: 'invalid' };
    }
    const placeholders = operationIds.map(() => '?').join(',');
    const operationCount = this.db.prepare(`SELECT COUNT(*) count FROM service_operations
      WHERE tenant_id = ? AND active = 1 AND id IN (${placeholders})`).get(tenantId, ...operationIds).count;
    if (operationCount !== operationIds.length) return { kind: 'invalid' };

    const itemId = `${type === 'service' ? 'service' : 'package'}_${randomUUID()}`;
    this.db.exec('BEGIN');
    try {
      if (type === 'service') {
        this.db.prepare(`INSERT INTO tenant_services
          (id, tenant_id, category, name, description, pricing_mode, active)
          VALUES (?, ?, ?, ?, ?, ?, 1)`).run(itemId, tenantId, category, name, description, pricingMode);
        const insertRelation = this.db.prepare(`INSERT INTO tenant_service_operations
          (service_id, operation_id, sequence) VALUES (?, ?, ?)`);
        const insertPrice = this.db.prepare(`INSERT INTO service_operation_prices
          (service_id, operation_id, tenant_class, amount_minor, duration_minutes) VALUES (?, ?, ?, ?, ?)`);
        operationPrices.forEach((price, index) => {
          insertRelation.run(itemId, price.operationId, index + 1);
          for (const tenantClass of vehicleClasses) insertPrice.run(
            itemId, price.operationId, tenantClass, price.amountMinor, price.durationMinutes
          );
        });
      } else {
        this.db.prepare(`INSERT INTO service_packages
          (id, tenant_id, category, name, description, active) VALUES (?, ?, ?, ?, ?, 1)`)
          .run(itemId, tenantId, category, name, description);
        const insertRelation = this.db.prepare(`INSERT INTO service_package_operations
          (package_id, operation_id, sequence) VALUES (?, ?, ?)`);
        operationIds.forEach((operationId, index) => insertRelation.run(itemId, operationId, index + 1));
        const insertPrice = this.db.prepare(`INSERT INTO service_package_prices
          (package_id, tenant_class, amount_minor, duration_minutes) VALUES (?, ?, ?, ?)`);
        for (const tenantClass of vehicleClasses) insertPrice.run(itemId, tenantClass, amountMinor, durationMinutes);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { kind: 'created', item: this.getManagedCatalog(tenantId).items.find((item) => item.id === itemId) };
  }

  updateManagedCatalogItem(tenantId, type, itemId, input) {
    if (!['service', 'package'].includes(type) || typeof input !== 'object' || !input) return { kind: 'invalid' };
    const name = String(input.name ?? '').trim();
    const category = String(input.category ?? '').trim();
    const description = String(input.description ?? '').trim();
    const active = input.active;
    const prices = input.prices;
    const pricingMode = type === 'service' ? String(input.pricingMode ?? '') : 'fixed';
    const operationIds = input.operationIds === undefined ? null
      : Array.isArray(input.operationIds) ? [...new Set(input.operationIds.map((id) => String(id)))] : [];
    if (name.length < 2 || name.length > 120 || category.length < 2 || category.length > 80 ||
      description.length > 500 || typeof active !== 'boolean' || !Array.isArray(prices) || prices.length > 100 ||
      (type === 'service' && !['fixed', 'from', 'inspection'].includes(pricingMode)) ||
      (operationIds && (!operationIds.length || operationIds.length > 50 || operationIds.length !== input.operationIds.length))) return { kind: 'invalid' };

    const table = type === 'service' ? 'tenant_services' : 'service_packages';
    const item = this.db.prepare(`SELECT id FROM ${table} WHERE id = ? AND tenant_id = ?`).get(itemId, tenantId);
    if (!item) return { kind: 'not_found' };
    if (active) {
      // An item cannot return to sale while it still contains an archived operation.
      const composition = operationIds ?? this.db.prepare(type === 'service'
        ? 'SELECT operation_id id FROM tenant_service_operations WHERE service_id = ?'
        : 'SELECT operation_id id FROM service_package_operations WHERE package_id = ?').all(itemId).map((row) => row.id);
      const archived = composition.length ? this.db.prepare(`SELECT name FROM service_operations
        WHERE tenant_id = ? AND active = 0 AND id IN (${composition.map(() => '?').join(',')})`).all(tenantId, ...composition) : [];
      if (archived.length) return {
        kind: 'conflict', code: 'operation_archived',
        message: `В составе есть архивные операции: ${archived.map((row) => row.name).join(', ')}. Восстановите их или уберите из состава`
      };
    }
    if (operationIds) {
      const placeholders = operationIds.map(() => '?').join(',');
      const operationCount = this.db.prepare(`SELECT COUNT(*) count FROM service_operations
        WHERE tenant_id = ? AND active = 1 AND id IN (${placeholders})`).get(tenantId, ...operationIds).count;
      if (operationCount !== operationIds.length) return { kind: 'invalid' };
    }
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
        const allowedOperation = operationIds
          ? operationIds.includes(operationId)
          : Boolean(this.db.prepare(`SELECT 1 FROM tenant_service_operations relation
              JOIN service_operations operation ON operation.id = relation.operation_id
              WHERE relation.service_id = ? AND relation.operation_id = ? AND operation.tenant_id = ?`).get(itemId, operationId, tenantId));
        if (!allowedOperation) return { kind: 'invalid' };
        normalizedPrices.push({ operationId, tenantClass, amountMinor, durationMinutes });
      } else {
        normalizedPrices.push({ tenantClass, amountMinor, durationMinutes });
      }
    }
    if (type === 'service' && operationIds && operationIds.some((operationId) =>
      !normalizedPrices.some((price) => price.operationId === operationId) &&
      !this.db.prepare(`SELECT 1 FROM service_operation_prices
        WHERE service_id = ? AND operation_id = ? LIMIT 1`).get(itemId, operationId))) return { kind: 'invalid' };

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
        if (operationIds) {
          this.db.prepare('DELETE FROM tenant_service_operations WHERE service_id = ?').run(itemId);
          const insertRelation = this.db.prepare(`INSERT INTO tenant_service_operations
            (service_id, operation_id, sequence) VALUES (?, ?, ?)`);
          operationIds.forEach((operationId, index) => insertRelation.run(itemId, operationId, index + 1));
          const selectedPlaceholders = operationIds.map(() => '?').join(',');
          this.db.prepare(`DELETE FROM service_operation_prices
            WHERE service_id = ? AND operation_id NOT IN (${selectedPlaceholders})`).run(itemId, ...operationIds);
          for (const operationId of operationIds) {
            const seed = normalizedPrices.find((price) => price.operationId === operationId) ??
              this.db.prepare(`SELECT operation_id operationId, amount_minor amountMinor, duration_minutes durationMinutes
                FROM service_operation_prices WHERE service_id = ? AND operation_id = ? LIMIT 1`).get(itemId, operationId);
            if (!seed) throw new Error('missing_operation_price');
            for (const tenantClass of allowedClasses) this.db.prepare(`INSERT INTO service_operation_prices
              (service_id, operation_id, tenant_class, amount_minor, duration_minutes) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(service_id, operation_id, tenant_class) DO NOTHING`).run(
                itemId, operationId, tenantClass, seed.amountMinor, seed.durationMinutes
              );
          }
        }
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
        if (operationIds) {
          this.db.prepare('DELETE FROM service_package_operations WHERE package_id = ?').run(itemId);
          const insertRelation = this.db.prepare(`INSERT INTO service_package_operations
            (package_id, operation_id, sequence) VALUES (?, ?, ?)`);
          operationIds.forEach((operationId, index) => insertRelation.run(itemId, operationId, index + 1));
        }
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
        w.order_id
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
  }

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
        w.order_id
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
        customer: { id: row.customer_id, name: row.customer_name, phoneDisplay: row.customer_phone },
        vehicle: { id: row.vehicle_id, make: row.make, model: row.model, generation: row.generation, plate: row.plate_display, color: row.color }
      }));
    return { kind: 'listed', items };
  }

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
        b.estimated_duration_minutes, b.status, b.preliminary_amount_minor, b.resource_id, b.created_at,
        t.timezone, lead.lead_id
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
      quoteVersion: current.version,
      lines: current.lines,
      quoteVersions
    };
  }

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
  }

  reviseBookingQuote(tenantId, bookingId, input, actorName = null) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { kind: 'invalid' };
    if (Object.keys(input).some((key) => !['selections', 'expectedQuoteVersion', 'reason'].includes(key))) return { kind: 'invalid' };
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
    if (!this.isBookingSlotAvailable(tenantId, booking.start_at, quote.totalDurationMinutes, bookingId)) return {
      kind: 'conflict', code: 'slot_unavailable', message: 'Новый состав не помещается в выбранное время. Перенесите запись или сократите состав'
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
      this.db.prepare(`UPDATE bookings SET preliminary_amount_minor = ?, estimated_duration_minutes = ?
        WHERE id = ? AND tenant_id = ?`).run(quote.totalAmountMinor, quote.totalDurationMinutes, bookingId, tenantId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { kind: 'updated', booking: this.getBooking(tenantId, bookingId) };
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

  /** Active team members with the master role and their current workload (approved or in-progress orders). */
  listMasters(tenantId) {
    return this.db.prepare(`SELECT m.id, m.display_name, m.roles_json,
        (SELECT COUNT(*) FROM order_assignment_members a JOIN orders o ON o.id = a.order_id AND o.tenant_id = a.tenant_id
          WHERE a.tenant_id = m.tenant_id AND a.member_id = m.id AND o.status IN ('APPROVED', 'IN_PROGRESS')) active_orders
      FROM tenant_members m WHERE m.tenant_id = ? AND m.status = 'active'
      ORDER BY active_orders, m.display_name`).all(tenantId)
      .filter((row) => JSON.parse(row.roles_json).includes('master'))
      .map((row) => ({ id: row.id, displayName: row.display_name, activeOrders: row.active_orders }));
  }

  assignOrderMaster(tenantId, orderId, input) {
    // Preferred: a real team member (memberId). Legacy clients may still send a free-text masterName.
    const memberId = typeof input?.memberId === 'string' && input.memberId ? input.memberId : null;
    let masterName = String(input?.masterName ?? '').trim();
    if (memberId) {
      const member = this.db.prepare(`SELECT display_name, roles_json, status FROM tenant_members
        WHERE id = ? AND tenant_id = ?`).get(memberId, tenantId);
      if (!member || member.status !== 'active' || !JSON.parse(member.roles_json).includes('master')) {
        return { kind: 'invalid', code: 'not_a_master' };
      }
      masterName = member.display_name;
    } else if (masterName.length < 2 || masterName.length > 120) return { kind: 'invalid' };
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
      this.db.prepare('DELETE FROM order_assignment_members WHERE order_id = ? AND tenant_id = ?').run(orderId, tenantId);
      if (memberId) this.db.prepare(`INSERT INTO order_assignment_members (order_id, tenant_id, member_id)
        VALUES (?, ?, ?)`).run(orderId, tenantId, memberId);
      this.insertOrderAudit(tenantId, orderId, 'MASTER_ASSIGNED', { masterName, memberId });
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

  // Builds the frozen content of an order document from the current order state.
  // It is stored verbatim at issue time, so later edits never change an issued act.
  buildOrderDocumentContent(tenantId, orderId, type) {
    const order = this.getOrder(tenantId, orderId);
    if (!order) return { kind: 'not_found' };
    const parties = this.db.prepare(`SELECT t.name tenant_name, c.name customer_name, c.phone_display,
        v.make, v.model, v.generation, v.plate_display, v.color
      FROM orders o
      JOIN tenants t ON t.id = o.tenant_id
      JOIN customers c ON c.id = o.customer_id AND c.tenant_id = o.tenant_id
      JOIN vehicles v ON v.id = o.vehicle_id AND v.tenant_id = o.tenant_id
      WHERE o.id = ? AND o.tenant_id = ?`).get(orderId, tenantId);
    const base = {
      center: { name: parties.tenant_name },
      order: { id: order.id, number: order.id.replace(/^order_/, '').slice(0, 8), createdAt: order.createdAt },
      customer: { name: parties.customer_name, phoneDisplay: parties.phone_display },
      vehicle: { make: parties.make, model: parties.model, generation: parties.generation, plate: parties.plate_display, color: parties.color }
    };
    const photoCount = (phase) => order.photos.filter((photo) => photo.phase === phase).length;
    if (type === 'intake_act') {
      if (!order.intake) return { kind: 'conflict', code: 'document_not_available', message: 'Сначала сохраните приёмку автомобиля' };
      return { kind: 'built', content: {
        title: 'Акт приёмки автомобиля',
        ...base,
        intake: {
          conditionSummary: order.intake.conditionSummary,
          completedAt: order.intake.completedAt,
          findings: order.intake.findings.map(({ zone, severity, note }) => ({ zone, severity, note })),
          recommendations: order.intake.recommendations.map(({ title, reason, priority }) => ({ title, reason, priority })),
          photoCount: photoCount('intake')
        },
        statement: 'Автомобиль передан в центр для выполнения работ в состоянии, описанном в этом акте. Перечисленные повреждения и замечания зафиксированы до начала работ.'
      } };
    }
    if (order.status !== 'CLOSED') return { kind: 'conflict', code: 'document_not_available', message: 'Акт выдачи формируется после закрытия заказа' };
    const approval = order.approval?.decision === 'APPROVED' ? order.approval : null;
    const estimate = order.estimateVersions.find((item) => item.id === (approval?.estimateVersionId ?? order.currentEstimateVersionId)) ?? null;
    const works = order.work?.operations.length
      ? order.work.operations.map((operation) => ({ name: operation.name, amountMinor: operation.amountMinor, status: operation.status }))
      : (estimate?.lines ?? []).map((line) => ({ name: line.name, amountMinor: line.amountMinor, status: 'DONE' }));
    return { kind: 'built', content: {
      title: 'Акт выдачи автомобиля (заказ-наряд)',
      ...base,
      estimate: estimate ? {
        version: estimate.version,
        totalAmountMinor: estimate.totalAmountMinor,
        approvedAt: approval?.decidedAt ?? null,
        approvalMethod: approval?.method ?? null,
        approvedBy: approval?.responsible ?? null
      } : null,
      works,
      // Historical orders closed before handovers were recorded have no handover row.
      handover: order.handover
        ? { responsible: order.handover.responsible, note: order.handover.note, handedOverAt: order.handover.handedOverAt }
        : null,
      photos: { intake: photoCount('intake'), result: photoCount('result') },
      statement: 'Работы выполнены по согласованной смете. Клиент осмотрел автомобиль и принял его. Сумма указана по согласованной смете и не подтверждает расчёты.'
    } };
  }

  listOrderDocuments(tenantId, orderId) {
    if (!this.db.prepare('SELECT 1 FROM orders WHERE id = ? AND tenant_id = ?').get(orderId, tenantId)) return null;
    const intakeCompletedAt = this.db.prepare('SELECT completed_at FROM order_intakes WHERE order_id = ?').get(orderId)?.completed_at ?? null;
    const seenTypes = new Set();
    return this.db.prepare(`SELECT id, document_type, number, signer_name, signature_data_url IS NOT NULL signed, actor_name, created_at
      FROM order_documents WHERE tenant_id = ? AND order_id = ?
      ORDER BY created_at DESC, rowid DESC`).all(tenantId, orderId).map((row) => {
        const current = !seenTypes.has(row.document_type);
        seenTypes.add(row.document_type);
        return {
          id: row.id,
          type: row.document_type,
          number: row.number,
          signed: row.signed === 1,
          signerName: row.signer_name,
          signedAt: row.signed === 1 ? apiTimestamp(row.created_at) : null,
          actorName: row.actor_name,
          createdAt: apiTimestamp(row.created_at),
          current,
          // A re-saved intake after the act was issued makes the act describe an older inspection.
          outdated: row.document_type === 'intake_act' && intakeCompletedAt !== null && intakeCompletedAt > row.created_at
        };
      });
  }

  getOrderDocument(tenantId, orderId, documentId) {
    const summary = this.listOrderDocuments(tenantId, orderId)?.find((item) => item.id === documentId);
    if (!summary) return null;
    const row = this.db.prepare(`SELECT content_json, signature_data_url FROM order_documents
      WHERE id = ? AND tenant_id = ? AND order_id = ?`).get(documentId, tenantId, orderId);
    return { ...summary, content: JSON.parse(row.content_json), signatureDataUrl: row.signature_data_url };
  }

  issueOrderDocument(tenantId, orderId, input, actorName = null) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { kind: 'invalid' };
    if (Object.keys(input).some((key) => !['type', 'signerName', 'signatureDataUrl'].includes(key))) return { kind: 'invalid' };
    if (!['intake_act', 'handover_act'].includes(input.type)) return { kind: 'invalid' };
    const hasSignature = input.signatureDataUrl !== undefined && input.signatureDataUrl !== null;
    const hasSigner = input.signerName !== undefined && input.signerName !== null;
    if (hasSignature !== hasSigner) return { kind: 'invalid' };
    let signerName = null;
    let signatureDataUrl = null;
    if (hasSignature) {
      if (typeof input.signatureDataUrl !== 'string' || typeof input.signerName !== 'string') return { kind: 'invalid' };
      signerName = input.signerName.trim();
      const match = input.signatureDataUrl.match(/^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/);
      const bytes = match ? Buffer.from(match[1], 'base64') : null;
      const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
      if (signerName.length < 2 || signerName.length > 120 || !bytes || bytes.length < 8 || bytes.length > 200 * 1024 ||
        pngSignature.some((byte, index) => bytes[index] !== byte)) return { kind: 'invalid' };
      signatureDataUrl = input.signatureDataUrl;
    }

    const built = this.buildOrderDocumentContent(tenantId, orderId, input.type);
    if (built.kind !== 'built') return built;
    const id = `doc_${randomUUID()}`;
    this.db.exec('BEGIN');
    try {
      const sequence = this.db.prepare(`SELECT COALESCE(MAX(sequence), 0) + 1 next FROM order_documents
        WHERE tenant_id = ? AND document_type = ?`).get(tenantId, input.type).next;
      const number = `${input.type === 'intake_act' ? 'АП' : 'АВ'}-${String(sequence).padStart(6, '0')}`;
      this.db.prepare(`INSERT INTO order_documents
        (id, tenant_id, order_id, document_type, sequence, number, content_json, signer_name, signature_data_url, actor_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          id, tenantId, orderId, input.type, sequence, number, JSON.stringify(built.content), signerName, signatureDataUrl, actorName
        );
      this.insertOrderAudit(tenantId, orderId, 'DOCUMENT_ISSUED', { documentId: id, type: input.type, number, signed: hasSignature });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { kind: 'created', document: this.getOrderDocument(tenantId, orderId, id) };
  }

  listOrders(tenantId, limit = 20) {
    const requestedLimit = Number(limit);
    const boundedLimit = Number.isInteger(requestedLimit) ? Math.min(50, Math.max(1, requestedLimit)) : 20;
    return this.db.prepare(`SELECT o.id, o.status, o.created_at,
        c.id customer_id, c.name customer_name, c.phone_display customer_phone,
        v.id vehicle_id, v.make, v.model, v.generation, v.plate_display, v.color,
        e.total_amount_minor, a.master_name, am.member_id master_member_id
      FROM orders o
      JOIN customers c ON c.id = o.customer_id AND c.tenant_id = o.tenant_id
      JOIN vehicles v ON v.id = o.vehicle_id AND v.tenant_id = o.tenant_id
      LEFT JOIN order_workflows w ON w.order_id = o.id AND w.tenant_id = o.tenant_id
      LEFT JOIN estimate_versions e ON e.id = w.current_estimate_version_id AND e.tenant_id = o.tenant_id
      LEFT JOIN order_assignments a ON a.order_id = o.id AND a.tenant_id = o.tenant_id
      LEFT JOIN order_assignment_members am ON am.order_id = o.id AND am.tenant_id = o.tenant_id
      WHERE o.tenant_id = ?
      ORDER BY o.created_at DESC, o.rowid DESC
      LIMIT ?`).all(tenantId, boundedLimit).map((row) => ({
        id: row.id,
        status: row.status,
        createdAt: apiTimestamp(row.created_at),
        totalAmountMinor: row.total_amount_minor ?? null,
        masterName: row.master_name ?? null,
        masterMemberId: row.master_member_id ?? null,
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
    const assignment = this.db.prepare(`SELECT a.master_name, a.assigned_at, am.member_id FROM order_assignments a
      LEFT JOIN order_assignment_members am ON am.order_id = a.order_id AND am.tenant_id = a.tenant_id
      WHERE a.order_id = ? AND a.tenant_id = ?`).get(orderId, tenantId);
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
        memberId: assignment.member_id ?? null,
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
        })),
      documents: this.listOrderDocuments(tenantId, orderId)
    };
  }
}
