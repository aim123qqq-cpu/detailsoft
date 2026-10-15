import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDetailFlowServer } from '../server/app.mjs';

let server;
let baseUrl;
let leadId;

before(async () => {
  server = createDetailFlowServer({
    databasePath: ':memory:',
    seed: true,
    authTokens: new Map([
      ['admin-token', { tenantId: 'tenant_demo', roles: ['admin'] }],
      ['intake-token', { tenantId: 'tenant_demo', roles: ['intake'] }],
      ['other-token', { tenantId: 'tenant_other', roles: ['admin'] }]
    ])
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

async function api(path, { token = 'admin-token', method = 'GET', body, headers = {} } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

test('admin creates and lists tenant-scoped enquiries while restricted roles cannot mutate them', async () => {
  const forbidden = await api('/api/leads', {
    token: 'intake-token', method: 'POST',
    body: { channel: 'telegram', contactName: 'Илья', phone: '+7 999 111-22-33', note: 'Керамика кузова' }
  });
  assert.equal(forbidden.status, 403);

  const created = await api('/api/leads', {
    method: 'POST', body: {
      customerId: 'cust_alexey', channel: 'telegram', contactName: 'Алексей Морозов',
      phone: '+7 913 123-45-67', note: 'Интересуется комплексным уходом'
    }
  });
  assert.equal(created.status, 201);
  const lead = await created.json();
  leadId = lead.id;
  assert.equal(lead.status, 'NEW');
  assert.equal(lead.customer.id, 'cust_alexey');

  const listed = await api('/api/leads');
  assert.equal(listed.status, 200);
  assert.ok((await listed.json()).items.some((item) => item.id === leadId));

  const foreign = await api('/api/leads', { token: 'other-token' });
  assert.ok(!(await foreign.json()).items.some((item) => item.id === leadId));
});

test('an enquiry moves to work and converts exactly once through the normal booking flow', async () => {
  const contacted = await api(`/api/leads/${leadId}`, {
    method: 'PATCH', body: { status: 'CONTACTED' }
  });
  assert.equal(contacted.status, 200);
  assert.equal((await contacted.json()).status, 'CONTACTED');

  const wrongCustomer = await api('/api/bookings', {
    method: 'POST', headers: { 'idempotency-key': 'lead-conversion-wrong-customer' }, body: {
      leadId,
      customerId: 'cust_unknown', vehicleId: 'veh_mazda', channel: 'telegram',
      startAt: '2026-12-14T12:00:00+03:00', selections: [{ type: 'service', id: 'service_wash' }]
    }
  });
  assert.equal(wrongCustomer.status, 409);
  assert.equal((await wrongCustomer.json()).error.code, 'lead_customer_mismatch');

  const booked = await api('/api/bookings', {
    method: 'POST', headers: { 'idempotency-key': 'lead-conversion-booking' }, body: {
      leadId,
      customerId: 'cust_alexey', vehicleId: 'veh_mazda', channel: 'telegram',
      startAt: '2026-12-15T12:00:00+03:00', selections: [{ type: 'service', id: 'service_wash' }]
    }
  });
  assert.equal(booked.status, 201);
  const booking = await booked.json();
  assert.equal(booking.leadId, leadId);

  const leads = await (await api('/api/leads')).json();
  const converted = leads.items.find((item) => item.id === leadId);
  assert.equal(converted.status, 'CONVERTED');
  assert.equal(converted.bookingId, booking.id);

  const duplicate = await api('/api/bookings', {
    method: 'POST', headers: { 'idempotency-key': 'lead-conversion-second' }, body: {
      leadId,
      customerId: 'cust_alexey', vehicleId: 'veh_camry', channel: 'telegram',
      startAt: '2026-12-16T12:00:00+03:00', selections: [{ type: 'service', id: 'service_wash' }]
    }
  });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error.code, 'lead_already_converted');
});

test('lost enquiries remain in history and cannot be converted', async () => {
  const created = await api('/api/leads', {
    method: 'POST', body: {
      channel: 'call', contactName: 'Марина', phone: '+7 999 222-33-44', note: 'Не устроили сроки'
    }
  });
  const lead = await created.json();
  const lost = await api(`/api/leads/${lead.id}`, { method: 'PATCH', body: { status: 'LOST' } });
  assert.equal(lost.status, 200);
  assert.equal((await lost.json()).status, 'LOST');

  const invalidTransition = await api(`/api/leads/${lead.id}`, {
    method: 'PATCH', body: { status: 'CONTACTED' }
  });
  assert.equal(invalidTransition.status, 409);
  assert.equal((await invalidTransition.json()).error.code, 'invalid_lead_state');
});
