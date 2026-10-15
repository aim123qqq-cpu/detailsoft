import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDetailFlowServer } from '../server/app.mjs';

let server;
let baseUrl;

before(async () => {
  server = createDetailFlowServer({
    databasePath: ':memory:', seed: true,
    authTokens: new Map([
      ['demo-session-token', { tenantId: 'tenant_demo', displayName: 'Анна', roles: ['owner', 'admin'] }],
      ['other-session-token', { tenantId: 'tenant_other', displayName: 'Олег', roles: ['admin'] }],
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

test('manual vehicle creation keeps explicit body type and tenant pricing class', async () => {
  const response = await api('/api/vehicles', {
    method: 'POST',
    body: {
      customerId: 'cust_alexey',
      manual: { make: 'Zeekr', model: '001', generation: '1 поколение', bodyType: 'wagon' },
      tenantClass: 'SUV',
      plateDisplay: 'М001ММ 55',
      color: 'серый'
    }
  });
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(created.vehicle.make, 'Zeekr');
  assert.equal(created.vehicle.bodyType, 'wagon');
  assert.equal(created.vehicle.tenantClass, 'SUV');

  const catalog = await api(`/api/tenants/current/services?vehicleId=${created.vehicle.id}`);
  assert.equal(catalog.status, 200);
  assert.equal((await catalog.json()).vehicleClass, 'SUV');
});

test('vehicle body and tenant class can be corrected without changing historical identity', async () => {
  const response = await api('/api/vehicles/veh_mazda', {
    method: 'PATCH', body: { bodyType: 'hatchback', tenantClass: 'Компакт' }
  });
  assert.equal(response.status, 200);
  const vehicle = await response.json();
  assert.equal(vehicle.id, 'veh_mazda');
  assert.equal(vehicle.bodyType, 'hatchback');
  assert.equal(vehicle.tenantClass, 'Компакт');

  const profile = await (await api('/api/vehicles/veh_mazda/profile')).json();
  assert.equal(profile.vehicle.bodyType, 'hatchback');
  assert.equal(profile.vehicle.tenantClass, 'Компакт');
  assert.equal(profile.visits[0].id, 'order_history_1');

  const invalid = await api('/api/vehicles/veh_mazda', {
    method: 'PATCH', body: { tenantClass: 'Несуществующий' }
  });
  assert.equal(invalid.status, 422);
});

test('vehicle mutations reject ambiguous or mixed commands without partial changes', async () => {
  const ambiguousCreate = await api('/api/vehicles', {
    method: 'POST', body: {
      customerId: 'cust_alexey', catalogVariantId: 'variant_camry_xv70',
      manual: { make: 'Manual', model: 'Car', bodyType: 'sedan' },
      plateDisplay: 'Т100ТТ 55', color: 'белый'
    }
  });
  assert.equal(ambiguousCreate.status, 422);

  const before = await (await api('/api/vehicles/veh_camry/profile')).json();
  const mixedPatch = await api('/api/vehicles/veh_camry', {
    method: 'PATCH', body: { bodyType: 'hatchback', status: 'unknown' }
  });
  assert.equal(mixedPatch.status, 422);
  const after = await (await api('/api/vehicles/veh_camry/profile')).json();
  assert.equal(after.vehicle.bodyType, before.vehicle.bodyType);
  assert.equal(after.vehicle.status, before.vehicle.status);
});

test('managed catalog exposes tenant operations and creates a priced service for every class', async () => {
  const operationResponse = await api('/api/tenants/current/catalog/operations', {
    method: 'POST', body: { name: 'Очистка панорамной крыши' }
  });
  assert.equal(operationResponse.status, 201);
  const operation = await operationResponse.json();

  const serviceResponse = await api('/api/tenants/current/catalog/services', {
    method: 'POST',
    body: {
      name: 'Панорамная крыша',
      category: 'Экстерьер',
      description: 'Безопасная очистка стекла и уплотнителей',
      pricingMode: 'fixed',
      operationPrices: [{ operationId: operation.id, amountMinor: 150000, durationMinutes: 35 }]
    }
  });
  assert.equal(serviceResponse.status, 201);
  const service = await serviceResponse.json();
  assert.equal(service.operations[0].id, operation.id);
  assert.ok(service.operations[0].prices.length >= 4);

  const managed = await (await api('/api/tenants/current/catalog')).json();
  assert.ok(managed.operationLibrary.some((item) => item.id === operation.id));

  const quoteResponse = await api('/api/bookings/quote-preview', {
    method: 'POST', body: { vehicleId: 'veh_mazda', selections: [{ type: 'service', id: service.id }] }
  });
  assert.equal(quoteResponse.status, 200);
  const quote = await quoteResponse.json();
  assert.equal(quote.totalAmountMinor, 150000);
  assert.equal(quote.totalDurationMinutes, 35);
});

test('package creation reuses operations and participates in duplicate-operation protection', async () => {
  const managed = await (await api('/api/tenants/current/catalog')).json();
  const operationIds = managed.items.find((item) => item.id === 'service_wash').operations.slice(0, 2).map((item) => item.id);
  const response = await api('/api/tenants/current/catalog/packages', {
    method: 'POST',
    body: {
      name: 'Быстрый комплекс',
      category: 'Комплексы',
      description: 'Две базовые операции',
      operationIds,
      amountMinor: 110000,
      durationMinutes: 30
    }
  });
  assert.equal(response.status, 201);
  const servicePackage = await response.json();
  assert.deepEqual(servicePackage.operations.map((item) => item.id), operationIds);
  assert.ok(servicePackage.prices.length >= 4);

  const quote = await api('/api/bookings/quote-preview', {
    method: 'POST',
    body: { vehicleId: 'veh_mazda', selections: [
      { type: 'package', id: servicePackage.id },
      { type: 'service', id: 'service_wash' }
    ] }
  });
  assert.equal(quote.status, 200);
  assert.ok((await quote.json()).warnings.some((item) => item.code === 'package_overlap'));
});

test('service composition can add and remove operations while historical snapshots stay independent', async () => {
  const createdOperation = await (await api('/api/tenants/current/catalog/operations', {
    method: 'POST', body: { name: 'Финишный антистатик' }
  })).json();
  const managed = await (await api('/api/tenants/current/catalog')).json();
  const wash = managed.items.find((item) => item.id === 'service_wash');
  const retained = wash.operations[0];

  const response = await api('/api/tenants/current/catalog/services/service_wash', {
    method: 'PATCH',
    body: {
      name: wash.name,
      category: wash.category,
      description: wash.description,
      pricingMode: wash.pricingMode,
      active: true,
      operationIds: [retained.id, createdOperation.id],
      prices: [
        { operationId: retained.id, tenantClass: 'Средний', amountMinor: 30000, durationMinutes: 8 },
        { operationId: createdOperation.id, tenantClass: 'Средний', amountMinor: 25000, durationMinutes: 5 }
      ]
    }
  });
  assert.equal(response.status, 200);
  const updated = await response.json();
  assert.deepEqual(updated.operations.map((item) => item.id), [retained.id, createdOperation.id]);
  assert.ok(updated.operations[1].prices.some((price) => price.tenantClass === 'SUV'));

  const historical = await api('/api/orders/order_history_1');
  assert.equal(historical.status, 200);
});

test('catalog creation is tenant scoped, role protected and validates foreign operations', async () => {
  const restricted = await api('/api/tenants/current/catalog/operations', {
    token: 'intake-session-token', method: 'POST', body: { name: 'Скрытая операция' }
  });
  assert.equal(restricted.status, 403);

  const foreign = await api('/api/tenants/current/catalog/operations', {
    token: 'other-session-token', method: 'POST', body: { name: 'Чужая операция' }
  });
  assert.equal(foreign.status, 201, 'other tenant admin may create only in its own tenant');

  const invalid = await api('/api/tenants/current/catalog/packages', {
    method: 'POST',
    body: {
      name: 'Неверный пакет', category: 'Комплексы', description: '',
      operationIds: [(await foreign.json()).id], amountMinor: 10000, durationMinutes: 10
    }
  });
  assert.equal(invalid.status, 422);

  const localOperation = await (await api('/api/tenants/current/catalog/operations', {
    method: 'POST', body: { name: 'Новая операция без цены' }
  })).json();
  const managed = await (await api('/api/tenants/current/catalog')).json();
  const wash = managed.items.find((item) => item.id === 'service_wash');
  const missingPrice = await api('/api/tenants/current/catalog/services/service_wash', {
    method: 'PATCH',
    body: {
      name: wash.name, category: wash.category, description: wash.description,
      pricingMode: wash.pricingMode, active: true,
      operationIds: [...wash.operations.map((item) => item.id), localOperation.id],
      prices: wash.operations.map((item) => ({
        operationId: item.id, tenantClass: 'Средний', amountMinor: 10000, durationMinutes: 10
      }))
    }
  });
  assert.equal(missingPrice.status, 422);
});
