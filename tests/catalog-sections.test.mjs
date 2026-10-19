import test from 'node:test';
import assert from 'node:assert/strict';
import { createDetailFlowServer } from '../server/app.mjs';

async function startServer() {
  const server = createDetailFlowServer({ databasePath: ':memory:', seed: true });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, token = 'demo-session-token', headers = {} } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: response.status, body: await response.json() };
  };
  return { server, call };
}

const sectionNamed = async (call, name, token) => (await call('/api/tenants/current/catalog/sections', { token })).body.items.find((section) => section.name === name);
const quote = (call, vehicleId, id, token) => call('/api/bookings/quote-preview', { method: 'POST', token, body: { vehicleId, selections: [{ type: 'service', id }] } });

test('sections come from existing categories and can be created, renamed, reordered and removed when empty', async () => {
  const { server, call } = await startServer();
  try {
    const initial = (await call('/api/tenants/current/catalog/sections')).body.items;
    assert.deepEqual(initial.map((section) => section.name).sort(), ['Детейлинг кузова', 'Комплексы', 'Мойка и уход', 'Салон']);
    assert.equal(initial.find((section) => section.name === 'Мойка и уход').itemCount, 2);

    const created = await call('/api/tenants/current/catalog/sections', { method: 'POST', body: { name: 'Защитные покрытия' } });
    assert.equal(created.status, 201);
    assert.equal((await call('/api/tenants/current/catalog/sections', { method: 'POST', body: { name: '  защитные ПОКРЫТИЯ ' } })).body.error.code, 'section_exists');

    // Rename moves the items; a booking made earlier keeps its own snapshot.
    const booking = await call('/api/bookings', { method: 'POST', headers: { 'idempotency-key': 'sections-rename' }, body: {
      customerId: 'cust_alexey', vehicleId: 'veh_mazda', channel: 'call', startAt: '2026-12-28T10:00:00+03:00', selections: [{ type: 'service', id: 'service_wash' }]
    } });
    assert.equal(booking.status, 201);
    const wash = await sectionNamed(call, 'Мойка и уход');
    const renamed = await call(`/api/tenants/current/catalog/sections/${wash.id}`, { method: 'PATCH', body: { name: 'Мойка' } });
    assert.equal(renamed.body.name, 'Мойка');
    assert.equal(renamed.body.itemCount, 2);
    const managed = (await call('/api/tenants/current/catalog')).body;
    assert.equal(managed.items.find((item) => item.id === 'service_wash').category, 'Мойка');
    assert.equal((await call(`/api/bookings/${booking.body.id}`)).body.lines[0].name, 'Бережная мойка');

    // The order of sections is the order of groups when booking.
    const sections = managed.sections;
    const salon = sections.find((section) => section.name === 'Салон');
    const order = [salon.id, ...sections.filter((section) => section.id !== salon.id).map((section) => section.id)];
    assert.equal((await call('/api/tenants/current/catalog/sections/order', { method: 'PUT', body: { ids: order } })).status, 200);
    const bookingCatalog = (await call('/api/tenants/current/services?vehicleId=veh_mazda')).body.categories.map((category) => category.name);
    assert.equal(bookingCatalog[0], 'Салон');
    assert.equal((await call('/api/tenants/current/catalog/sections/order', { method: 'PUT', body: { ids: order.slice(1) } })).status, 422, 'every section must be listed');

    const notEmpty = await call(`/api/tenants/current/catalog/sections/${salon.id}`, { method: 'DELETE' });
    assert.equal(notEmpty.status, 409);
    assert.equal(notEmpty.body.error.code, 'section_not_empty');
    assert.equal((await call(`/api/tenants/current/catalog/sections/${created.body.id}`, { method: 'DELETE' })).status, 200);
    assert.equal(await sectionNamed(call, 'Защитные покрытия'), undefined);
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test('a simple service is a name, a time and a price; class prices override the base price', async () => {
  const { server, call } = await startServer();
  try {
    const salon = await sectionNamed(call, 'Салон');
    const created = await call('/api/tenants/current/catalog/simple-services', { method: 'POST', body: {
      sectionId: salon.id, name: 'Озонирование салона', pricingMode: 'fixed', basePrice: { amountMinor: 250000, durationMinutes: 40 }
    } });
    assert.equal(created.status, 201);
    assert.equal(created.body.category, 'Салон');
    assert.equal(created.body.simple, true);
    assert.deepEqual(created.body.basePrice, { amountMinor: 250000, durationMinutes: 40 });
    assert.deepEqual(created.body.classPrices, []);
    assert.equal(created.body.operations[0].name, 'Озонирование салона', 'the hidden operation is named after the service');

    const mazda = await quote(call, 'veh_mazda', created.body.id);
    assert.equal(mazda.body.lines[0].amountMinor, 250000);
    assert.equal(mazda.body.lines[0].durationMinutes, 40);

    // A higher price and longer time for business-class cars only.
    const updated = await call(`/api/tenants/current/catalog/simple-services/${created.body.id}`, { method: 'PUT', body: {
      sectionId: salon.id, name: 'Озонирование салона', pricingMode: 'fixed', active: true,
      basePrice: { amountMinor: 250000, durationMinutes: 40 }, classPrices: [{ tenantClass: 'Бизнес', amountMinor: 320000, durationMinutes: 50 }]
    } });
    assert.equal(updated.status, 200);
    assert.deepEqual(updated.body.classPrices, [{ tenantClass: 'Бизнес', amountMinor: 320000, durationMinutes: 50 }]);
    assert.equal((await quote(call, 'veh_camry', created.body.id)).body.lines[0].amountMinor, 320000);
    assert.equal((await quote(call, 'veh_mazda', created.body.id)).body.lines[0].amountMinor, 250000);
    const services = (await call('/api/tenants/current/services?vehicleId=veh_camry')).body.categories.flatMap((category) => category.items);
    assert.equal(services.find((item) => item.id === created.body.id).durationMinutes, 50);

    assert.equal((await call('/api/tenants/current/catalog/simple-services', { method: 'POST', body: {
      sectionId: salon.id, name: 'озонирование  салона', basePrice: { amountMinor: 1, durationMinutes: 1 }
    } })).body.error.code, 'service_exists');
    assert.equal((await call('/api/tenants/current/catalog/simple-services', { method: 'POST', body: {
      sectionId: 'section_missing', name: 'Чернение шин', basePrice: { amountMinor: 50000, durationMinutes: 10 }
    } })).body.error.code, 'section_required');
    assert.equal((await call('/api/tenants/current/catalog/simple-services', { method: 'POST', body: {
      sectionId: salon.id, name: 'Чернение шин', basePrice: { amountMinor: 50000, durationMinutes: 0 }
    } })).status, 422);
    assert.equal((await call('/api/tenants/current/catalog/simple-services', { method: 'POST', body: {
      sectionId: salon.id, name: 'Чернение шин', basePrice: { amountMinor: 50000, durationMinutes: 10 }, classPrices: [{ tenantClass: 'Грузовик', amountMinor: 1, durationMinutes: 1 }]
    } })).status, 422, 'only the center\'s classes');
    assert.equal((await call('/api/tenants/current/catalog/simple-services/service_wash', { method: 'PUT', body: {
      sectionId: salon.id, name: 'Бережная мойка', active: true, basePrice: { amountMinor: 1, durationMinutes: 1 }
    } })).body.error.code, 'service_not_simple');
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test('renaming a simple service renames its own operation but never one shared with other items', async () => {
  const { server, call } = await startServer();
  try {
    const salon = await sectionNamed(call, 'Салон');
    const own = (await call('/api/tenants/current/catalog/simple-services', { method: 'POST', body: {
      sectionId: salon.id, name: 'Чистка кожи', basePrice: { amountMinor: 300000, durationMinutes: 60 }
    } })).body;
    const renamed = (await call(`/api/tenants/current/catalog/simple-services/${own.id}`, { method: 'PUT', body: {
      sectionId: salon.id, name: 'Чистка и пропитка кожи', active: true, basePrice: { amountMinor: 300000, durationMinutes: 60 }
    } })).body;
    assert.equal(renamed.operations[0].name, 'Чистка и пропитка кожи');

    // "Детейлинг дисков" uses op_rims alone, and op_rims is also part of a package.
    const wheels = (await call('/api/tenants/current/catalog')).body.items.find((item) => item.id === 'service_wheels');
    assert.equal(wheels.simple, true);
    assert.equal(wheels.basePrice, null, 'seeded per-class prices have no base row yet');
    const section = await sectionNamed(call, wheels.category);
    const edited = await call('/api/tenants/current/catalog/simple-services/service_wheels', { method: 'PUT', body: {
      sectionId: section.id, name: 'Мойка дисков', active: true, basePrice: { amountMinor: 90000, durationMinutes: 25 }
    } });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.name, 'Мойка дисков');
    const usedByPackage = (await call('/api/tenants/current/catalog/operations')).body.items.find((operation) => operation.id === wheels.operations[0].id);
    assert.deepEqual(usedByPackage.usage.packages.map((item) => item.id), ['package_complex']);
    assert.equal(edited.body.operations[0].name, wheels.operations[0].name, 'an operation shared with a package keeps its name');
    assert.deepEqual(edited.body.classPrices, [], 'class prices not sent are dropped in favour of the base price');
    assert.equal((await quote(call, 'veh_camry', 'service_wheels')).body.lines[0].amountMinor, 90000);
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test('a center without vehicle class rules prices services for any car through the base price', async () => {
  const { server, call } = await startServer();
  const token = 'other-session-token';
  try {
    const managed = (await call('/api/tenants/current/catalog', { token })).body;
    assert.deepEqual(managed.vehicleClasses, ['*']);
    assert.deepEqual(managed.sections, []);
    const section = (await call('/api/tenants/current/catalog/sections', { method: 'POST', token, body: { name: 'Мойка' } })).body;
    const service = await call('/api/tenants/current/catalog/simple-services', { method: 'POST', token, body: {
      sectionId: section.id, name: 'Экспресс-мойка', basePrice: { amountMinor: 80000, durationMinutes: 20 }
    } });
    assert.equal(service.status, 201);
    const booking = (await call('/api/tenants/current/services?vehicleId=veh_other', { token })).body;
    assert.deepEqual(booking.categories.map((category) => category.name), ['Мойка']);
    assert.equal(booking.categories[0].items[0].price.amountMinor, 80000);
    assert.equal((await quote(call, 'veh_other', service.body.id, token)).body.lines[0].amountMinor, 80000);

    // The composite builder works too: its starting prices go to the base row.
    const operation = (await call('/api/tenants/current/catalog/operations', { method: 'POST', token, body: { name: 'Сушка' } })).body;
    const composite = await call('/api/tenants/current/catalog/services', { method: 'POST', token, body: {
      name: 'Мойка с сушкой', category: 'Мойка', description: '', pricingMode: 'fixed',
      operationPrices: [{ operationId: operation.id, amountMinor: 30000, durationMinutes: 10 }]
    } });
    assert.equal(composite.status, 201);
    assert.equal((await quote(call, 'veh_other', composite.body.id, token)).body.lines[0].amountMinor, 30000);

    // Tenant isolation: the demo center cannot see or edit these.
    assert.equal((await call(`/api/tenants/current/catalog/sections/${section.id}`, { method: 'PATCH', body: { name: 'Чужой' } })).status, 404);
    assert.equal((await call(`/api/tenants/current/catalog/simple-services/${service.body.id}`, { method: 'PUT', body: {
      sectionId: section.id, name: 'Захват', active: true, basePrice: { amountMinor: 1, durationMinutes: 1 }
    } })).status, 404);
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test('catalog sections and simple services require the catalog permission', async () => {
  const { server, call } = await startServer();
  try {
    const intake = (await call('/api/tenants/current/team', { method: 'POST', body: { displayName: 'Ирина Лебедева', roles: ['intake'] } })).body;
    assert.equal((await call('/api/tenants/current/catalog/sections', { token: intake.accessToken })).status, 403);
    assert.equal((await call('/api/tenants/current/catalog/sections', { method: 'POST', token: intake.accessToken, body: { name: 'Новый' } })).status, 403);
    assert.equal((await call('/api/tenants/current/catalog/simple-services', { method: 'POST', token: intake.accessToken, body: {} })).status, 403);
  } finally {
    await new Promise((done) => server.close(done));
  }
});
