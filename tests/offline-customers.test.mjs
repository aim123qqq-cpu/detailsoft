import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDetailFlowServer } from '../server/app.mjs';
import { localCreateCustomer, localCreateVehicle, localVehicleClass } from '../src/offline/bookingLocal.ts';

async function startServer() {
  const server = createDetailFlowServer({ databasePath: ':memory:', seed: true });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method, headers: { authorization: 'Bearer demo-session-token', 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: response.status, body: await response.json() };
  };
  return { server, call };
}

test('a customer sent from the offline queue keeps its id and asks before duplicating a phone', async () => {
  const { server, call } = await startServer();
  try {
    const id = `cust_${randomUUID()}`;
    const fresh = await call('/api/customers', { method: 'POST', body: { id, name: 'Ольга Новикова', phone: '+7 900 555-11-22', checkDuplicatePhone: true } });
    assert.equal(fresh.status, 201);
    assert.equal(fresh.body.id, id);

    // The demo customer already has +7 913 123-45-67.
    const duplicate = await call('/api/customers', { method: 'POST', body: { id: `cust_${randomUUID()}`, name: 'А. Морозов', phone: '8 913 123 45 67', checkDuplicatePhone: true } });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'customer_phone_exists');
    assert.deepEqual(duplicate.body.error.details.customers.map((item) => item.id), ['cust_alexey']);
    const confirmed = await call('/api/customers', { method: 'POST', body: { id: `cust_${randomUUID()}`, name: 'Другой Морозов', phone: '8 913 123 45 67', checkDuplicatePhone: true, confirmDuplicate: true } });
    assert.equal(confirmed.status, 201, 'another person with the same phone, confirmed explicitly');
    assert.equal((await call('/api/customers', { method: 'POST', body: { name: 'Без проверки', phone: '8 913 123 45 67' } })).status, 201, 'the online form keeps its own flow');

    assert.equal((await call('/api/customers', { method: 'POST', body: { id: 'cust_1', name: 'Неверный', phone: '+7 900 000-00-01' } })).status, 422);
    assert.equal((await call('/api/customers', { method: 'POST', body: { id, name: 'Повтор', phone: '+7 900 000-00-02' } })).body.error.code, 'customer_exists');

    const vehicleId = `veh_${randomUUID()}`;
    const vehicle = await call('/api/vehicles', { method: 'POST', body: { id: vehicleId, customerId: id, manual: { make: 'Lada', model: 'Vesta', bodyType: 'sedan' }, plateDisplay: 'Е001КХ 55', color: 'белый' } });
    assert.equal(vehicle.status, 201);
    assert.equal(vehicle.body.vehicle.id, vehicleId);
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test('the phone prices a new vehicle in the same class as the server and refuses known plates and phones', async () => {
  const { server, call } = await startServer();
  try {
    const cases = [
      { input: { catalogVariantId: 'variant_camry_xv70' }, variant: 'variant_camry_xv70' },
      { input: { catalogVariantId: 'variant_bmw_x5_g05' }, variant: 'variant_bmw_x5_g05' },
      { input: { manual: { make: 'Lada', model: 'Granta', bodyType: 'sedan' } } },
      { input: { manual: { make: 'Haval', model: 'Jolion', bodyType: 'suv' }, tenantClass: 'SUV' } }
    ];
    const variants = (await call('/api/vehicle-catalog/variants?q=a')).body.items.concat((await call('/api/vehicle-catalog/variants?q=x5')).body.items, (await call('/api/vehicle-catalog/variants?q=camry')).body.items);
    for (const [index, item] of cases.entries()) {
      const plate = `К${String(100 + index)}КК 55`;
      const created = await call('/api/vehicles', { method: 'POST', body: { customerId: 'cust_alexey', plateDisplay: plate, color: 'серый', ...item.input } });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const pack = (await call('/api/offline/booking-pack')).body;
      const variant = item.variant ? variants.find((entry) => entry.id === item.variant) : null;
      if (item.variant) assert.ok(variant?.systemVehicleClass !== undefined, `catalog variant ${item.variant} found`);
      const local = localVehicleClass(pack, {
        catalogVariantId: item.input.catalogVariantId ?? null,
        systemVehicleClass: variant?.systemVehicleClass ?? null,
        tenantClass: item.input.tenantClass ?? null
      });
      assert.equal(local, pack.vehicleClasses[created.body.vehicle.id], `class for case ${index}`);
    }

    const pack = (await call('/api/offline/booking-pack')).body;
    assert.throws(() => localCreateCustomer(pack, { name: 'Дубль', phone: '+7 (913) 123-45-67' }, `cust_${randomUUID()}`), { code: 'customer_phone_exists' });
    const { pack: withCustomer, customer } = localCreateCustomer(pack, { name: 'Пётр Белов', phone: '+7 900 777-66-55' }, `cust_${randomUUID()}`);
    assert.ok(withCustomer.customers.some((item) => item.id === customer.id));
    assert.throws(() => localCreateVehicle(withCustomer, { customerId: customer.id, manual: { make: 'Mazda', model: '6', bodyType: 'sedan' }, plateDisplay: 'а 123 аа 55', color: 'синий' }, null, `veh_${randomUUID()}`), { code: 'possible_duplicate' });
    const { pack: withVehicle, vehicle } = localCreateVehicle(withCustomer, { customerId: customer.id, manual: { make: 'Mazda', model: '6', bodyType: 'sedan' }, tenantClass: 'Бизнес', plateDisplay: 'М777ММ 55', color: 'синий' }, null, `veh_${randomUUID()}`);
    assert.equal(withVehicle.vehicleClasses[vehicle.id], 'Бизнес');
  } finally {
    await new Promise((done) => server.close(done));
  }
});
