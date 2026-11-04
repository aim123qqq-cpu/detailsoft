import test from 'node:test';
import assert from 'node:assert/strict';
import { createDetailFlowServer } from '../server/app.mjs';
import { allCarVariants, carMakes, carModels, carVariants } from '../src/shared/carCatalog.ts';
import { NO_PLATE } from '../src/shared/normalize.ts';
import { BODY_TYPES } from '../src/shared/carLayouts.ts';
import { localCreateVehicle } from '../src/offline/bookingLocal.ts';

async function withServer(run) {
  const server = createDetailFlowServer({ databasePath: ':memory:' });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { authorization: 'Bearer demo-session-token', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
    });
    return { status: response.status, body: await response.json() };
  };
  try { await run(call); } finally { await new Promise((done) => server.close(done)); }
}

test('the car lists: makes and models people look for, found in Russian too, every body known', () => {
  assert.equal(carMakes()[0], 'Lada', 'the common makes come first');
  assert.deepEqual(carMakes('фольксваген'), ['Volkswagen']);
  assert.ok(carModels('Volkswagen').includes('Golf'));
  assert.deepEqual(carModels('Volkswagen', 'gol'), ['Golf', 'Golf Plus']);
  assert.deepEqual(carVariants('Volkswagen', 'Golf').map((item) => item.bodyType), ['hatchback', 'wagon']);
  const all = allCarVariants();
  assert.equal(new Set(all.map((item) => item.id)).size, all.length, 'ids are unique');
  const bodies = new Set(BODY_TYPES.map((item) => item.code));
  assert.ok(all.every((item) => bodies.has(item.bodyType)), 'every body has an inspection layout');
});

test('a car from the lists is saved with no plate, two such cars are no duplicates, the plate is added later', async () => {
  await withServer(async (call) => {
    const [golf] = carVariants('Volkswagen', 'Golf');
    const first = await call('/api/vehicles', 'POST', { customerId: 'cust_alexey', catalogVariantId: golf.id, plateDisplay: '', color: 'серый' });
    assert.equal(first.status, 201);
    assert.equal(first.body.vehicle.plate, NO_PLATE);
    assert.equal(first.body.vehicle.make, 'Volkswagen');
    assert.equal(first.body.vehicle.bodyType, 'hatchback');
    assert.equal(first.body.vehicle.customer.id, 'cust_alexey');

    const second = await call('/api/vehicles', 'POST', { customerId: 'cust_alexey', catalogVariantId: golf.id, color: 'белый' });
    assert.equal(second.status, 201, 'the field may be left out altogether');

    assert.equal((await call('/api/vehicles', 'POST', { customerId: 'cust_alexey', catalogVariantId: golf.id, plateDisplay: 'А1', color: 'белый' })).status, 422, 'half a plate is a typo');
    assert.equal((await call(`/api/vehicles?plate=${encodeURIComponent('БЕЗ')}`)).body.items.length, 0, 'the label is not a plate to find');

    const id = first.body.vehicle.id;
    assert.equal((await call(`/api/vehicles/${id}`, 'PATCH', { plateDisplay: 'А123АА 55' })).status, 409, 'somebody already has this plate');
    const updated = await call(`/api/vehicles/${id}`, 'PATCH', { plateDisplay: 'К321КК 55' });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.plate, 'К321КК 55');
    assert.equal((await call(`/api/vehicles?plate=${encodeURIComponent('К321КК')}`)).body.items[0].id, id);
    assert.equal((await call(`/api/vehicles/${id}`, 'PATCH', { plateDisplay: '' })).body.plate, NO_PLATE);
  });
});

test('offline, too, a car is added with no plate', () => {
  const pack = { classRules: [], vehicleClasses: {}, customers: [{ id: 'cust', name: 'Игорь', phoneDisplay: '+7', vehicles: [{ id: 'veh_old', plate: NO_PLATE }] }] };
  const [golf] = carVariants('Volkswagen', 'Golf');
  const { vehicle } = localCreateVehicle(pack, { customerId: 'cust', catalogVariantId: golf.id, plateDisplay: '', color: 'серый' }, golf, 'veh_new');
  assert.equal(vehicle.plate, NO_PLATE);
  assert.equal(vehicle.model, 'Golf');
});
