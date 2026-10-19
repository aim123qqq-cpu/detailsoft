// Helpers shared by the repository method groups (moved from server/repository.mjs unchanged).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { normalizePhone, normalizePlate, normalizeSearch } from '../domain/normalize.mjs';
import { buildDocumentContent } from '../../src/shared/orderDocuments.ts';
import { availabilityForDate, computeQuote, formatMoney, isSlotAvailable, localDateTime, priceLabel, timeToMinutes } from '../../src/shared/bookingRules.ts';

export function mapVehicle(row) {
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

// Price lookup for a vehicle class (bound as ?): the class's own row, else the '*' default row.
export const OPERATION_PRICE_CLASS = `(SELECT x.tenant_class FROM service_operation_prices x
  WHERE x.service_id = so.service_id AND x.operation_id = so.operation_id AND x.tenant_class IN (?, '*')
  ORDER BY x.tenant_class = '*' LIMIT 1)`;
export const PACKAGE_PRICE_CLASS = `(SELECT x.tenant_class FROM service_package_prices x
  WHERE x.package_id = p.id AND x.tenant_class IN (?, '*') ORDER BY x.tenant_class = '*' LIMIT 1)`;

/** An id chosen by a phone working offline: "<prefix>_<uuid>", or undefined when the server picks one. */
export function clientId(value, prefix) {
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string' && new RegExp(`^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`).test(value) ? value : null;
}

export function apiTimestamp(value) {
  if (!value) return null;
  return new Date(value.endsWith?.('Z') ? value : `${value.replace(' ', 'T')}Z`).toISOString();
}

export function mapTeamMember(row) {
  return {
    id: row.id,
    displayName: row.display_name,
    roles: JSON.parse(row.roles_json),
    status: row.status,
    createdAt: apiTimestamp(row.created_at),
    updatedAt: apiTimestamp(row.updated_at)
  };
}


export function calendarDateTimestamp(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  if (!match) return null;
  const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Date(timestamp).toISOString().slice(0, 10) === value ? timestamp : null;
}



export function mapLead(row) {
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

export { createHash, randomBytes, randomUUID, normalizePhone, normalizePlate, normalizeSearch, buildDocumentContent, availabilityForDate, computeQuote, formatMoney, isSlotAvailable, localDateTime, priceLabel, timeToMinutes };
