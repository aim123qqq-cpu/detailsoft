import { randomUUID, normalizePhone, mapLead } from './shared.mjs';

/** Incoming requests (leads) before they become bookings. Mixed into DetailFlowRepository (server/repository.mjs). */
export const leadsMethods = {
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
  },

  getLead(tenantId, leadId) {
    return mapLead(this.db.prepare(`SELECT lead.id, lead.channel, lead.status, lead.contact_name, lead.phone_display,
        lead.note, lead.created_at, lead.updated_at, customer.id customer_id, customer.name customer_name,
        booking.booking_id
      FROM leads lead
      LEFT JOIN customers customer ON customer.id = lead.customer_id AND customer.tenant_id = lead.tenant_id
      LEFT JOIN lead_bookings booking ON booking.lead_id = lead.id AND booking.tenant_id = lead.tenant_id
      WHERE lead.id = ? AND lead.tenant_id = ?`).get(leadId, tenantId));
  },

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
  },

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
};
