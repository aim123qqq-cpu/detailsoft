import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDetailFlowServer } from '../server/app.mjs';

let server;
let baseUrl;

before(async () => {
  server = createDetailFlowServer({ databasePath: ':memory:', seed: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

async function api(path, { tenant = 'tenant_demo', method = 'GET', body, headers = {} } = {}) {
  const token = tenant === 'tenant_other' ? 'other-session-token' : 'demo-session-token';
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

test('phone search returns one customer with both active vehicles', async () => {
  const response = await api('/api/customers?phone=%2B7%20913%20123-45-67');
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].name, 'Алексей Морозов');
  assert.deepEqual(payload.items[0].vehicles.map((vehicle) => vehicle.plate), ['А123АА 55', 'В476РЕ 155']);
});

test('tenant boundary hides customers and vehicles from another center', async () => {
  const customerResponse = await api('/api/customers?phone=79131234567', { tenant: 'tenant_other' });
  const vehicleResponse = await api('/api/vehicles?plate=%D0%90123%D0%90%D0%9055', { tenant: 'tenant_other' });
  const customers = (await customerResponse.json()).items;
  const vehicles = (await vehicleResponse.json()).items;
  assert.deepEqual(customers.map((item) => item.id), ['cust_other']);
  assert.deepEqual(vehicles.map((item) => item.id), ['veh_other']);
  assert.ok(customers.every((item) => item.id !== 'cust_alexey'));
  assert.ok(vehicles.every((item) => item.id !== 'veh_mazda'));
});

test('tenant scope comes from the authenticated session, not a spoofable header', async () => {
  const response = await api('/api/customers?phone=79131234567', {
    headers: { 'x-tenant-id': 'tenant_other' }
  });
  assert.deepEqual((await response.json()).items.map((item) => item.id), ['cust_alexey']);
});

test('Mazda 3 BL catalog search keeps sedan and hatchback as explicit choices', async () => {
  const response = await api('/api/vehicle-catalog/variants?q=Mazda%203%20BL');
  const payload = await response.json();
  assert.deepEqual(payload.items.map((item) => item.bodyType).sort(), ['hatchback', 'sedan']);
});

test('new vehicle is linked to the existing customer and receives tenant pricing class', async () => {
  const response = await api('/api/vehicles', {
    method: 'POST',
    body: {
      customerId: 'cust_alexey',
      catalogVariantId: 'variant_mazda_3_bl_hatch',
      plateDisplay: 'К777КК 55',
      color: 'графитовый'
    }
  });
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(created.vehicle.bodyType, 'hatchback');
  assert.equal(created.vehicle.tenantClass, 'Компакт');
  assert.equal(created.link.customerId, 'cust_alexey');

  const search = await api('/api/vehicles?plate=%D0%9A777%D0%9A%D0%9A55');
  const payload = await search.json();
  assert.equal(payload.items[0].id, created.vehicle.id);
});

test('a missing phone can create a customer without losing the entered number', async () => {
  const response = await api('/api/customers', {
    method: 'POST',
    body: { name: 'Мария Соколова', phone: '+7 999 111-22-33' }
  });
  assert.equal(response.status, 201);
  const customer = await response.json();
  assert.equal(customer.phoneDisplay, '+7 999 111-22-33');

  const search = await api('/api/customers?phone=79991112233');
  assert.deepEqual((await search.json()).items.map((item) => item.id), [customer.id]);
});

test('possible duplicate plate returns a conflict and does not merge automatically', async () => {
  const response = await api('/api/vehicles', {
    method: 'POST',
    body: {
      customerId: 'cust_alexey',
      catalogVariantId: 'variant_mazda_3_bl_sedan',
      plateDisplay: 'А123АА-55',
      color: 'белый'
    }
  });
  assert.equal(response.status, 409);
  const payload = await response.json();
  assert.equal(payload.error.code, 'possible_duplicate');
  assert.equal(payload.error.details.matches[0].id, 'veh_mazda');
});

test('archiving a vehicle preserves historical orders', async () => {
  const archive = await api('/api/vehicles/veh_mazda', {
    method: 'PATCH',
    body: { status: 'sold' }
  });
  assert.equal(archive.status, 200);

  const order = await api('/api/orders/order_history_1');
  assert.equal(order.status, 200);
  const payload = await order.json();
  assert.equal(payload.vehicleId, 'veh_mazda');
  assert.equal(payload.customerId, 'cust_alexey');
});
