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

async function api(path, { token = 'demo-session-token', method = 'GET', body } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

test('vehicle profile returns the current owner, ownership timeline and historical visits', async () => {
  const response = await api('/api/vehicles/veh_mazda/profile');
  assert.equal(response.status, 200);
  const profile = await response.json();

  assert.equal(profile.vehicle.id, 'veh_mazda');
  assert.equal(profile.currentOwner.id, 'cust_alexey');
  assert.equal(profile.ownership.length, 1);
  assert.equal(profile.ownership[0].active, true);
  assert.deepEqual(profile.visits.map((visit) => visit.id), ['order_history_1']);
  assert.equal(profile.visits[0].customer.id, 'cust_alexey');
});

test('vehicle profile is tenant scoped and restricted to customer managers', async () => {
  assert.equal((await api('/api/vehicles/veh_mazda/profile', { token: 'other-session-token' })).status, 404);
  assert.equal((await api('/api/vehicles/veh_mazda/profile', { token: 'intake-session-token' })).status, 403);
});

test('explicit owner transfer preserves the previous link and historical order customer', async () => {
  const createdResponse = await api('/api/customers', {
    method: 'POST', body: { name: 'Мария Соколова', phone: '+7 999 111-22-33' }
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();

  const transferResponse = await api('/api/vehicles/veh_mazda/transfer', {
    method: 'POST', body: { customerId: created.id }
  });
  assert.equal(transferResponse.status, 200);
  const profile = await transferResponse.json();

  assert.equal(profile.currentOwner.id, created.id);
  assert.equal(profile.ownership.length, 2);
  assert.equal(profile.ownership[0].active, true);
  assert.equal(profile.ownership[0].customer.id, created.id);
  assert.equal(profile.ownership[1].active, false);
  assert.equal(profile.ownership[1].customer.id, 'cust_alexey');
  assert.ok(profile.ownership[1].validTo);
  assert.equal(profile.visits[0].customer.id, 'cust_alexey');
  assert.equal(profile.audit[0].type, 'OWNER_TRANSFERRED');

  const oldCustomer = await api('/api/customers/cust_alexey/vehicles');
  const newCustomer = await api(`/api/customers/${created.id}/vehicles`);
  assert.deepEqual((await oldCustomer.json()).items.map((item) => item.id), ['veh_camry']);
  assert.deepEqual((await newCustomer.json()).items.map((item) => item.id), ['veh_mazda']);

  const repeated = await api('/api/vehicles/veh_mazda/transfer', {
    method: 'POST', body: { customerId: created.id }
  });
  assert.equal(repeated.status, 409);
  assert.equal((await repeated.json()).error.code, 'same_owner');
});

test('transfer cannot target another tenant and does not change ownership', async () => {
  const response = await api('/api/vehicles/veh_camry/transfer', {
    method: 'POST', body: { customerId: 'cust_other' }
  });
  assert.equal(response.status, 404);

  const profile = await (await api('/api/vehicles/veh_camry/profile')).json();
  assert.equal(profile.currentOwner.id, 'cust_alexey');
  assert.equal(profile.ownership.length, 1);
});

test('transfer requires an explicit target customer', async () => {
  const response = await api('/api/vehicles/veh_camry/transfer', { method: 'POST', body: {} });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, 'validation_error');
});

test('status changes are audited without deleting ownership or visits', async () => {
  assert.equal((await api('/api/vehicles/veh_camry', {
    method: 'PATCH', body: { status: 'sold' }
  })).status, 200);
  assert.equal((await api('/api/vehicles/veh_camry', {
    method: 'PATCH', body: { status: 'active' }
  })).status, 200);

  const profile = await (await api('/api/vehicles/veh_camry/profile')).json();
  assert.equal(profile.vehicle.status, 'active');
  assert.equal(profile.currentOwner.id, 'cust_alexey');
  assert.deepEqual(profile.audit.map((event) => event.type), ['VEHICLE_STATUS_CHANGED', 'VEHICLE_STATUS_CHANGED']);
  assert.deepEqual(profile.audit.map((event) => event.details.toStatus), ['active', 'sold']);
});
