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
      ['other-session-token', { tenantId: 'tenant_other', displayName: 'Олег', roles: ['owner', 'admin'] }],
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
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
}

const library = async (query = '') => (await (await api(`/api/tenants/current/catalog/operations${query}`)).json()).items;
const patchOperation = (id, body, token) => api(`/api/tenants/current/catalog/operations/${id}`, { method: 'PATCH', body, token });

test('operation library lists every operation with the services and packages that use it', async () => {
  const items = await library();
  const prewash = items.find((item) => item.id === 'op_prewash');
  assert.equal(prewash.name, 'Предварительная мойка');
  assert.equal(prewash.active, true);
  assert.deepEqual(prewash.usage.services.map((item) => item.id), ['service_wash']);
  assert.deepEqual(prewash.usage.packages.map((item) => item.id), ['package_complex']);
  assert.equal(prewash.usage.activeCount, 2);
  const polish = items.find((item) => item.id === 'op_polish');
  assert.deepEqual(polish.usage.services.map((item) => [item.id, item.active]), [['service_polish', true]]);

  const search = await library('?q=%D0%9C%D0%9E%D0%99%D0%9A');
  assert.deepEqual(search.map((item) => item.id).sort(), ['op_handwash', 'op_prewash'], 'search is case-insensitive for Cyrillic');
});

test('renaming applies to future quotes while existing bookings keep their snapshot', async () => {
  const booking = await (await api('/api/bookings', {
    method: 'POST', headers: { 'idempotency-key': 'operation-rename-booking' }, body: {
      customerId: 'cust_alexey', vehicleId: 'veh_mazda', channel: 'call', startAt: '2026-12-30T10:00:00+03:00',
      selections: [{ type: 'service', id: 'service_wash' }]
    }
  })).json();

  const renamed = await patchOperation('op_dry', { name: '  Сушка кузова микрофиброй ' });
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).name, 'Сушка кузова микрофиброй');

  const catalog = await (await api('/api/tenants/current/services?vehicleId=veh_mazda')).json();
  const wash = catalog.categories.flatMap((category) => category.items).find((item) => item.id === 'service_wash');
  assert.ok(wash.operations.some((operation) => operation.name === 'Сушка кузова микрофиброй'));

  const stored = await (await api(`/api/bookings/${booking.id}`)).json();
  assert.ok(stored.lines[0].operations.some((operation) => operation.name === 'Сушка кузова'), 'booking snapshot keeps the old name');

  const duplicate = await patchOperation('op_dry', { name: 'ручная МОЙКА кузова' });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error.code, 'operation_exists');
  const created = await api('/api/tenants/current/catalog/operations', { method: 'POST', body: { name: 'ПРЕДВАРИТЕЛЬНАЯ мойка' } });
  assert.equal(created.status, 409, 'creating also detects Cyrillic case-insensitive duplicates');
});

test('an operation used by an active service or package cannot be archived', async () => {
  const response = await patchOperation('op_prewash', { active: false });
  assert.equal(response.status, 409);
  const error = (await response.json()).error;
  assert.equal(error.code, 'operation_in_use');
  assert.deepEqual(error.details.services.map((item) => item.id), ['service_wash']);
  assert.deepEqual(error.details.packages.map((item) => item.id), ['package_complex']);
  assert.equal((await library()).find((item) => item.id === 'op_prewash').active, true);
});

test('unused or archived-only operations can be archived, hidden from new items and restored', async () => {
  const created = await (await api('/api/tenants/current/catalog/operations', { method: 'POST', body: { name: 'Озонирование салона' } })).json();
  const archived = await patchOperation(created.id, { active: false });
  assert.equal(archived.status, 200);
  assert.equal((await archived.json()).active, false);

  const rejected = await api('/api/tenants/current/catalog/services', { method: 'POST', body: {
    name: 'Озон', category: 'Салон', description: '', pricingMode: 'fixed',
    operationPrices: [{ operationId: created.id, amountMinor: 100000, durationMinutes: 30 }]
  } });
  assert.equal(rejected.status, 422, 'archived operations cannot be used in new services');

  assert.equal((await patchOperation(created.id, { active: true })).status, 200);

  // Archive the only service that uses polishing, then the operation itself.
  const polishBody = { name: 'Одношаговая полировка', category: 'Детейлинг кузова', description: 'Возвращает блеск и убирает лёгкие риски', pricingMode: 'from', prices: [] };
  assert.equal((await api('/api/tenants/current/catalog/services/service_polish', { method: 'PATCH', body: { ...polishBody, active: false } })).status, 200);
  assert.equal((await patchOperation('op_polish', { active: false })).status, 200);

  const reactivate = await api('/api/tenants/current/catalog/services/service_polish', { method: 'PATCH', body: { ...polishBody, active: true } });
  assert.equal(reactivate.status, 409, 'a service cannot return to sale while it contains an archived operation');
  assert.equal((await reactivate.json()).error.code, 'operation_archived');
  assert.equal((await patchOperation('op_polish', { active: true })).status, 200);
  assert.equal((await api('/api/tenants/current/catalog/services/service_polish', { method: 'PATCH', body: { ...polishBody, active: true } })).status, 200);
});

test('operation changes are validated, tenant scoped and limited to catalog managers', async () => {
  for (const body of [{}, { name: 'О' }, { active: 'no' }, { name: 'Мойка', color: 'red' }]) {
    const response = await patchOperation('op_rims', body);
    assert.equal(response.status, 422, JSON.stringify(body));
  }
  assert.equal((await patchOperation('op_rims', { name: 'Чужая' }, 'other-session-token')).status, 404);
  assert.equal((await patchOperation('op_rims', { name: 'Без прав' }, 'intake-session-token')).status, 403);
  assert.equal((await api('/api/tenants/current/catalog/operations', { token: 'intake-session-token' })).status, 403);
  const otherLibrary = await (await api('/api/tenants/current/catalog/operations', { token: 'other-session-token' })).json();
  assert.equal(otherLibrary.items.some((item) => item.id === 'op_rims'), false);
  assert.equal((await library()).find((item) => item.id === 'op_rims').name, 'Очистка дисков');
});
