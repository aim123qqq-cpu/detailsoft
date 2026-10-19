import test from 'node:test';
import assert from 'node:assert/strict';
import { createDetailFlowServer } from '../server/app.mjs';
import { localAvailability, localQuote, localSearchCustomers, localSearchVehicles, localServicesCatalog } from '../src/offline/bookingLocal.ts';

async function startServer() {
  const server = createDetailFlowServer({ databasePath: ':memory:', seed: true });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, token = 'demo-session-token', key } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: response.status, body: await response.json() };
  };
  return { server, call };
}

test('the phone computes the same catalog, quote, free time and search results as the server', async () => {
  const { server, call } = await startServer();
  try {
    // A business-class price and a busy slot make the comparison meaningful.
    const salon = (await call('/api/tenants/current/catalog/sections')).body.items.find((section) => section.name === 'Салон');
    await call('/api/tenants/current/catalog/simple-services', { method: 'POST', body: {
      sectionId: salon.id, name: 'Озонирование', basePrice: { amountMinor: 250000, durationMinutes: 40 }, classPrices: [{ tenantClass: 'Бизнес', amountMinor: 320000, durationMinutes: 50 }]
    } });
    await call('/api/bookings', { method: 'POST', key: 'parity-busy', body: {
      customerId: 'cust_alexey', vehicleId: 'veh_mazda', channel: 'call', startAt: '2026-12-28T10:00:00+03:00', selections: [{ type: 'service', id: 'service_wash' }]
    } });
    const pack = (await call('/api/offline/booking-pack')).body;
    assert.ok(pack.customers.length > 0);
    assert.equal(pack.vehicleClasses.veh_camry, 'Бизнес');

    for (const vehicleId of ['veh_mazda', 'veh_camry']) {
      assert.deepEqual(localServicesCatalog(pack, vehicleId), (await call(`/api/tenants/current/services?vehicleId=${vehicleId}`)).body, `catalog for ${vehicleId}`);
      for (const selections of [
        [{ type: 'service', id: 'service_wash' }],
        [{ type: 'package', id: 'package_complex' }, { type: 'service', id: 'service_wash' }, { type: 'service', id: 'service_polish' }],
        [{ type: 'service', id: 'service_interior' }, { type: 'service', id: pack.services.find((item) => item.name === 'Озонирование').id }]
      ]) {
        const server = (await call('/api/bookings/quote-preview', { method: 'POST', body: { vehicleId, selections } })).body;
        assert.deepEqual(localQuote(pack, vehicleId, selections), server, `quote ${vehicleId} ${selections.map((item) => item.id).join('+')}`);
      }
    }

    for (const [date, duration] of [['2026-12-28', 35], ['2026-12-28', 120], ['2026-12-27', 60]]) {
      // The server answer also carries an internal `kind` field (unchanged legacy shape).
      const { kind, ...server } = (await call(`/api/bookings/availability?date=${date}&durationMinutes=${duration}`)).body;
      assert.deepEqual(localAvailability(pack, [], date, duration), server, `availability ${date} ${duration}`);
    }

    assert.deepEqual(localSearchCustomers(pack, '913 123'), (await call('/api/customers?phone=913%20123')).body.items);
    assert.deepEqual(localSearchCustomers(pack, '91'), []);
    assert.deepEqual(localSearchVehicles(pack, 'а123'), (await call(`/api/vehicles?plate=${encodeURIComponent('а123')}`)).body.items.map((item) => ({ ...item, customer: { ...item.customer, visitCount: localSearchCustomers(pack, '913 123')[0].visitCount, vehicles: [] } })));
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test('a center without class rules is priced through the default price on the phone too', async () => {
  const { server, call } = await startServer();
  const token = 'other-session-token';
  try {
    const section = (await call('/api/tenants/current/catalog/sections', { method: 'POST', token, body: { name: 'Мойка' } })).body;
    await call('/api/tenants/current/catalog/simple-services', { method: 'POST', token, body: { sectionId: section.id, name: 'Экспресс-мойка', basePrice: { amountMinor: 80000, durationMinutes: 20 } } });
    const pack = (await call('/api/offline/booking-pack', { token })).body;
    assert.deepEqual(localServicesCatalog(pack, 'veh_other'), (await call('/api/tenants/current/services?vehicleId=veh_other', { token })).body);
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test('the booking pack follows the role: no pack without bookings, no phones without customer rights', async () => {
  const { server, call } = await startServer();
  try {
    const intake = (await call('/api/tenants/current/team', { method: 'POST', body: { displayName: 'Ирина Лебедева', roles: ['intake'] } })).body;
    assert.equal((await call('/api/offline/booking-pack', { token: intake.accessToken })).status, 403);
    const booker = (await call('/api/tenants/current/roles', { method: 'POST', body: { name: 'Только записи', permissions: ['manageBookings'] } })).body;
    const member = (await call('/api/tenants/current/team', { method: 'POST', body: { displayName: 'Ольга Котова', roles: [booker.key] } })).body;
    const pack = (await call('/api/offline/booking-pack', { token: member.accessToken })).body;
    assert.deepEqual(pack.customers, []);
    assert.ok(pack.services.length > 0);
  } finally {
    await new Promise((done) => server.close(done));
  }
});
