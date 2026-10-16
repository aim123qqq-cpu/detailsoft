import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDetailFlowServer } from '../server/app.mjs';

let server;
let baseUrl;

before(async () => {
  server = createDetailFlowServer({
    databasePath: ':memory:',
    seed: true,
    authTokens: new Map([
      ['demo-session-token', { tenantId: 'tenant_demo', displayName: 'Анна', roles: ['owner', 'admin'] }],
      ['other-session-token', { tenantId: 'tenant_other', displayName: 'Администратор', roles: ['admin'] }],
      ['intake-session-token', { tenantId: 'tenant_demo', displayName: 'Ирина', roles: ['intake'] }]
    ])
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

async function api(path, { token = 'demo-session-token', method = 'GET', body, headers = {} } = {}) {
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

async function createCustomer(name, phone) {
  const response = await api('/api/customers', { method: 'POST', body: { name, phone } });
  assert.equal(response.status, 201);
  return response.json();
}

async function profileOf(customerId) {
  const response = await api(`/api/customers/${customerId}/profile`);
  assert.equal(response.status, 200);
  return response.json();
}

test('customer profile returns contacts, vehicles, visits and aggregates without payment metrics', async () => {
  const profile = await profileOf('cust_alexey');

  assert.equal(profile.customer.id, 'cust_alexey');
  assert.equal(profile.customer.name, 'Алексей Морозов');
  assert.equal(profile.customer.phoneDisplay, '+7 913 123-45-67');
  assert.equal(profile.customer.archived, false);
  assert.equal(profile.customer.archivedAt, null);
  assert.deepEqual(profile.vehicles.map((vehicle) => vehicle.id).sort(), ['veh_camry', 'veh_mazda']);
  assert.ok(profile.vehicles.every((vehicle) => vehicle.ownedFrom));
  assert.deepEqual(profile.formerVehicles, []);
  assert.deepEqual(profile.orders.map((order) => order.id), ['order_history_1']);
  assert.equal(profile.orders[0].vehicle.plate, 'А123АА 55');
  assert.equal(profile.stats.orders, 1);
  assert.equal(profile.stats.closedOrders, 1);
  assert.equal(profile.stats.activeOrders, 0);
  assert.ok(profile.stats.lastVisitAt);
  assert.deepEqual(profile.phoneDuplicates, [], 'a customer with the same phone in another tenant is not a duplicate');
  assert.doesNotMatch(JSON.stringify(profile), /payment|paid/i);
});

test('search shows the same visit count as the profile: closed orders, not a stored counter', async () => {
  const search = await (await api('/api/customers?phone=9131234567')).json();
  const alexey = search.items.find((item) => item.id === 'cust_alexey');
  assert.equal(alexey.visitCount, (await profileOf('cust_alexey')).stats.closedOrders);
  assert.equal(alexey.visitCount, 1, 'the seeded stored counter (6) is no longer shown');
  const created = await createCustomer('Лидия Короткова', '+7 999 555-60-01');
  assert.equal(created.visitCount, 0);
  const found = await (await api('/api/customers?phone=5556001')).json();
  assert.equal(found.items[0].visitCount, 0);
});

test('customer profile and mutations are tenant scoped and restricted to customer managers', async () => {
  assert.equal((await api('/api/customers/cust_alexey/profile', { token: 'other-session-token' })).status, 404);
  assert.equal((await api('/api/customers/cust_other/profile')).status, 404);
  assert.equal((await api('/api/customers/cust_missing/profile')).status, 404);
  assert.equal((await api('/api/customers/cust_alexey', {
    token: 'other-session-token', method: 'PATCH', body: { name: 'Чужой' }
  })).status, 404);
  assert.equal((await api('/api/customers/cust_alexey/archive', { token: 'other-session-token', method: 'POST', body: {} })).status, 404);
  assert.equal((await api('/api/customers/cust_alexey/reactivate', { token: 'other-session-token', method: 'POST', body: {} })).status, 404);

  assert.equal((await api('/api/customers/cust_alexey/profile', { token: 'intake-session-token' })).status, 403);
  assert.equal((await api('/api/customers/cust_alexey', {
    token: 'intake-session-token', method: 'PATCH', body: { name: 'Без прав' }
  })).status, 403);
  assert.equal((await api('/api/customers/cust_alexey/archive', { token: 'intake-session-token', method: 'POST', body: {} })).status, 403);

  const profile = await profileOf('cust_alexey');
  assert.equal(profile.customer.name, 'Алексей Морозов');
  assert.equal(profile.customer.archived, false);
});

test('customer contact update validates input before changing anything', async () => {
  const customer = await createCustomer('Ольга Петрова', '+7 999 555-00-01');
  for (const body of [{}, { email: 'x@example.com' }, { name: 'О' }, { name: 'О'.repeat(121) }, { phone: '12-34' }, { phone: 42 }]) {
    const response = await api(`/api/customers/${customer.id}`, { method: 'PATCH', body });
    assert.equal(response.status, 422, JSON.stringify(body));
    assert.equal((await response.json()).error.code, 'validation_error');
  }
  const profile = await profileOf(customer.id);
  assert.equal(profile.customer.name, 'Ольга Петрова');
  assert.equal(profile.customer.phoneDisplay, '+7 999 555-00-01');
  assert.deepEqual(profile.audit, []);
});

test('phone is normalized by the search domain code and every change is audited', async () => {
  const customer = await createCustomer('Ольга Иванова', '+7 999 555-10-01');
  const response = await api(`/api/customers/${customer.id}`, {
    method: 'PATCH', body: { name: '  Ольга Сергеевна  ', phone: '8 (999) 555-10-02' }
  });
  assert.equal(response.status, 200);
  const profile = await response.json();
  assert.equal(profile.customer.name, 'Ольга Сергеевна');
  assert.equal(profile.customer.phoneDisplay, '8 (999) 555-10-02');

  const found = await (await api('/api/customers?phone=%2B7%20999%20555-10-02')).json();
  assert.deepEqual(found.items.map((item) => item.id), [customer.id]);
  const old = await (await api('/api/customers?phone=5551001')).json();
  assert.deepEqual(old.items, []);

  assert.equal(profile.audit.length, 1);
  assert.equal(profile.audit[0].type, 'CUSTOMER_UPDATED');
  assert.equal(profile.audit[0].actorName, 'Анна');
  assert.deepEqual(profile.audit[0].details.changes, {
    name: { from: 'Ольга Иванова', to: 'Ольга Сергеевна' },
    phone: { from: '+7 999 555-10-01', to: '8 (999) 555-10-02' }
  });

  const unchanged = await api(`/api/customers/${customer.id}`, { method: 'PATCH', body: { name: 'Ольга Сергеевна' } });
  assert.equal(unchanged.status, 200);
  assert.equal((await unchanged.json()).audit.length, 1, 'a no-op update does not create an audit event');
});

test('possible duplicate phone is reported and never merged automatically', async () => {
  const customer = await createCustomer('Пётр Смирнов', '+7 999 555-20-01');
  const conflict = await api(`/api/customers/${customer.id}`, {
    method: 'PATCH', body: { phone: '+7 913 123-45-67' }
  });
  assert.equal(conflict.status, 409);
  const error = (await conflict.json()).error;
  assert.equal(error.code, 'possible_duplicate');
  assert.deepEqual(error.details.matches.map((match) => match.id), ['cust_alexey']);
  assert.equal((await profileOf(customer.id)).customer.phoneDisplay, '+7 999 555-20-01', 'conflict leaves the phone unchanged');

  const confirmed = await api(`/api/customers/${customer.id}`, {
    method: 'PATCH', body: { phone: '+7 913 123-45-67', confirmDuplicate: true }
  });
  assert.equal(confirmed.status, 200);
  const profile = await confirmed.json();
  assert.equal(profile.customer.phoneDisplay, '+7 913 123-45-67');
  assert.deepEqual(profile.phoneDuplicates.map((item) => item.id), ['cust_alexey']);
  assert.deepEqual(profile.audit[0].details.duplicateAcknowledged, ['cust_alexey']);
  assert.deepEqual(profile.vehicles, [], 'changing a phone never moves vehicles');

  const alexey = await profileOf('cust_alexey');
  assert.deepEqual(alexey.vehicles.map((vehicle) => vehicle.id).sort(), ['veh_camry', 'veh_mazda']);
  assert.deepEqual(alexey.phoneDuplicates.map((item) => item.id), [customer.id]);
  const search = await (await api('/api/customers?phone=9131234567')).json();
  assert.deepEqual(search.items.map((item) => item.id).sort(), ['cust_alexey', customer.id].sort());

  const renamed = await api(`/api/customers/${customer.id}`, { method: 'PATCH', body: { name: 'Пётр Андреевич' } });
  assert.equal(renamed.status, 200, 'an unchanged duplicate phone does not block other edits');
});

test('archive is blocked while the customer has active work and leaves state unchanged', async () => {
  const blockedByLead = await api('/api/customers/cust_alexey/archive', { method: 'POST', body: {} });
  assert.equal(blockedByLead.status, 409);
  const leadError = (await blockedByLead.json()).error;
  assert.equal(leadError.code, 'customer_has_active_work');
  assert.equal(leadError.details.activeLeads, 1);
  assert.equal((await profileOf('cust_alexey')).customer.archived, false);

  const customer = await createCustomer('Игорь Белов', '+7 999 555-30-01');
  const vehicleResponse = await api('/api/vehicles', {
    method: 'POST', body: { customerId: customer.id, catalogVariantId: 'variant_camry_xv70', plateDisplay: 'Е555КХ 55', color: 'белый' }
  });
  assert.equal(vehicleResponse.status, 201);
  const { vehicle } = await vehicleResponse.json();
  const bookingResponse = await api('/api/bookings', {
    method: 'POST', headers: { 'idempotency-key': 'customer-archive-booking' }, body: {
      customerId: customer.id, vehicleId: vehicle.id, channel: 'call',
      startAt: '2026-12-21T12:00:00+03:00', selections: [{ type: 'service', id: 'service_wash' }]
    }
  });
  assert.equal(bookingResponse.status, 201);
  const booking = await bookingResponse.json();

  const blockedByBooking = await api(`/api/customers/${customer.id}/archive`, { method: 'POST', body: {} });
  assert.equal(blockedByBooking.status, 409);
  assert.equal((await blockedByBooking.json()).error.details.confirmedBookings, 1);

  assert.equal((await api(`/api/bookings/${booking.id}`, { method: 'PATCH', body: { status: 'CANCELLED' } })).status, 200);
  const archived = await api(`/api/customers/${customer.id}/archive`, { method: 'POST', body: {} });
  assert.equal(archived.status, 200);
  const profile = await archived.json();
  assert.equal(profile.customer.archived, true);
  assert.ok(profile.customer.archivedAt);
  assert.deepEqual(profile.vehicles.map((item) => item.id), [vehicle.id], 'archive keeps ownership links');
  assert.deepEqual(profile.bookings.map((item) => [item.id, item.status]), [[booking.id, 'CANCELLED']]);
});

test('archived customer is hidden from default search, read-only, and can be reactivated explicitly', async () => {
  const customer = await createCustomer('Вера Лаптева', '+7 999 555-40-01');
  assert.equal((await api(`/api/customers/${customer.id}/archive`, { method: 'POST', body: {} })).status, 200);

  const repeated = await api(`/api/customers/${customer.id}/archive`, { method: 'POST', body: {} });
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).audit.length, 1, 'repeated archive is idempotent');

  assert.deepEqual((await (await api('/api/customers?phone=5554001')).json()).items, []);
  const withArchived = await (await api('/api/customers?phone=5554001&includeArchived=true')).json();
  assert.deepEqual(withArchived.items.map((item) => [item.id, item.archived]), [[customer.id, true]]);

  const edit = await api(`/api/customers/${customer.id}`, { method: 'PATCH', body: { name: 'Вера Николаевна' } });
  assert.equal(edit.status, 409);
  assert.equal((await edit.json()).error.code, 'customer_archived');
  const vehicle = await api('/api/vehicles', {
    method: 'POST', body: { customerId: customer.id, catalogVariantId: 'variant_camry_xv70', plateDisplay: 'М777ММ 55', color: 'серый' }
  });
  assert.equal(vehicle.status, 404, 'archived customer cannot receive new vehicles');

  const reactivated = await api(`/api/customers/${customer.id}/reactivate`, { method: 'POST', body: {} });
  assert.equal(reactivated.status, 200);
  const profile = await reactivated.json();
  assert.equal(profile.customer.archived, false);
  assert.deepEqual(profile.audit.map((event) => event.type), ['CUSTOMER_REACTIVATED', 'CUSTOMER_ARCHIVED']);
  const active = await (await api('/api/customers?phone=5554001')).json();
  assert.deepEqual(active.items.map((item) => [item.id, item.archived]), [[customer.id, false]]);
});

test('owner transfer moves the vehicle to history while past orders keep their original customer', async () => {
  const buyer = await createCustomer('Сергей Новиков', '+7 999 555-50-01');
  assert.equal((await api('/api/vehicles/veh_mazda/transfer', { method: 'POST', body: { customerId: buyer.id } })).status, 200);

  const seller = await profileOf('cust_alexey');
  assert.deepEqual(seller.vehicles.map((vehicle) => vehicle.id), ['veh_camry']);
  assert.equal(seller.formerVehicles.length, 1);
  assert.equal(seller.formerVehicles[0].vehicle.id, 'veh_mazda');
  assert.ok(seller.formerVehicles[0].validTo);
  assert.equal(seller.formerVehicles[0].currentOwner.id, buyer.id);
  assert.deepEqual(seller.orders.map((order) => order.id), ['order_history_1']);

  const owner = await profileOf(buyer.id);
  assert.deepEqual(owner.vehicles.map((vehicle) => vehicle.id), ['veh_mazda']);
  assert.deepEqual(owner.orders, [], 'the new owner does not inherit visits made by the previous owner');
});
