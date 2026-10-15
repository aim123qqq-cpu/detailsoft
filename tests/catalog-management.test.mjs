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
      ['admin-token', { tenantId: 'tenant_demo', roles: ['admin'] }],
      ['owner-token', { tenantId: 'tenant_demo', roles: ['owner'] }],
      ['intake-token', { tenantId: 'tenant_demo', roles: ['intake'] }],
      ['other-owner-token', { tenantId: 'tenant_other', roles: ['owner'] }]
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

test('catalog editor is tenant scoped and restricted to owners and administrators', async () => {
  const admin = await api('/api/tenants/current/catalog');
  assert.equal(admin.status, 200);
  const catalog = await admin.json();
  assert.deepEqual(catalog.vehicleClasses, ['Бизнес', 'Компакт', 'Средний', 'SUV']);
  assert.ok(catalog.items.some((item) => item.id === 'service_wash' && item.type === 'service'));
  assert.ok(catalog.items.some((item) => item.id === 'package_complex' && item.type === 'package'));

  assert.equal((await api('/api/tenants/current/catalog', { token: 'owner-token' })).status, 200);
  assert.equal((await api('/api/tenants/current/catalog', { token: 'intake-token' })).status, 403);

  const foreign = await api('/api/tenants/current/catalog', { token: 'other-owner-token' });
  assert.equal(foreign.status, 200);
  assert.ok(!(await foreign.json()).items.some((item) => item.id === 'service_wash'));
});

test('service metadata and operation prices update the existing booking catalog', async () => {
  const booked = await api('/api/bookings', {
    method: 'POST', headers: { 'idempotency-key': 'catalog-history-booking' }, body: {
      customerId: 'cust_alexey', vehicleId: 'veh_mazda', channel: 'call',
      startAt: '2026-12-20T09:00:00+03:00', selections: [{ type: 'service', id: 'service_wash' }]
    }
  });
  assert.equal(booked.status, 201);
  const historical = await booked.json();
  assert.equal(historical.preliminaryAmountMinor, 140000);

  const updated = await api('/api/tenants/current/catalog/services/service_wash', {
    method: 'PATCH',
    body: {
      name: 'Бережная мойка Premium',
      category: 'Мойка и уход',
      description: 'Обновлённый трёхфазный уход',
      pricingMode: 'from',
      active: true,
      prices: [
        { operationId: 'op_prewash', tenantClass: 'Средний', amountMinor: 40000, durationMinutes: 10 },
        { operationId: 'op_handwash', tenantClass: 'Средний', amountMinor: 100000, durationMinutes: 20 },
        { operationId: 'op_dry', tenantClass: 'Средний', amountMinor: 40000, durationMinutes: 10 }
      ]
    }
  });
  assert.equal(updated.status, 200);
  const service = await updated.json();
  assert.equal(service.name, 'Бережная мойка Premium');
  assert.equal(service.pricingMode, 'from');

  const bookingCatalog = await api('/api/tenants/current/services?vehicleId=veh_mazda');
  const body = await bookingCatalog.json();
  const offering = body.categories.flatMap((category) => category.items).find((item) => item.id === 'service_wash');
  assert.equal(offering.name, 'Бережная мойка Premium');
  assert.equal(offering.price.amountMinor, 180000);
  assert.equal(offering.durationMinutes, 40);
  assert.match(offering.price.label, /^от /);

  const preserved = await api(`/api/bookings/${historical.id}`);
  assert.equal(preserved.status, 200);
  assert.equal((await preserved.json()).preliminaryAmountMinor, 140000);
});

test('package prices can change and offerings archive without deleting historical rows', async () => {
  const packageUpdate = await api('/api/tenants/current/catalog/packages/package_complex', {
    token: 'owner-token', method: 'PATCH', body: {
      name: 'Комплексный уход', category: 'Комплексы', description: 'Кузов, диски и салон', active: true,
      prices: [{ tenantClass: 'Средний', amountMinor: 525000, durationMinutes: 125 }]
    }
  });
  assert.equal(packageUpdate.status, 200);
  assert.equal((await packageUpdate.json()).prices.find((price) => price.tenantClass === 'Средний').amountMinor, 525000);

  const archived = await api('/api/tenants/current/catalog/services/service_wheels', {
    method: 'PATCH', body: {
      name: 'Детейлинг дисков', category: 'Мойка и уход', description: 'Глубокая очистка дисков',
      pricingMode: 'fixed', active: false, prices: []
    }
  });
  assert.equal(archived.status, 200);
  assert.equal((await archived.json()).active, false);

  const bookingCatalog = await api('/api/tenants/current/services?vehicleId=veh_mazda');
  const operationalIds = (await bookingCatalog.json()).categories.flatMap((category) => category.items.map((item) => item.id));
  assert.ok(!operationalIds.includes('service_wheels'));

  const editorCatalog = await api('/api/tenants/current/catalog');
  const archivedRow = (await editorCatalog.json()).items.find((item) => item.id === 'service_wheels');
  assert.equal(archivedRow.active, false);
  assert.ok(archivedRow.operations.length > 0);

  assert.equal((await api('/api/tenants/current/catalog/services/service_wash', {
    token: 'other-owner-token', method: 'PATCH', body: {
      name: 'Чужое изменение', category: 'Чужая', description: 'X', pricingMode: 'fixed', active: true, prices: []
    }
  })).status, 404);
});
