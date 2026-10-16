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

let keyCounter = 0;
async function createBooking({ vehicleId = 'veh_mazda', startAt, selections = [{ type: 'service', id: 'service_wash' }] }) {
  const response = await api('/api/bookings', {
    method: 'POST',
    headers: { 'idempotency-key': `quote-revision-${keyCounter += 1}` },
    body: { customerId: 'cust_alexey', vehicleId, channel: 'call', startAt, selections }
  });
  assert.equal(response.status, 201);
  return response.json();
}

function revise(bookingId, body, token) {
  return api(`/api/bookings/${bookingId}/quote`, { method: 'PUT', body, token });
}

test('a booking without revisions exposes its original snapshot as quote version 1', async () => {
  const booking = await createBooking({ startAt: '2026-12-22T10:00:00+03:00' });
  assert.equal(booking.quoteVersion, 1);
  assert.equal(booking.quoteVersions.length, 1);
  assert.equal(booking.quoteVersions[0].version, 1);
  assert.equal(booking.quoteVersions[0].totalAmountMinor, booking.preliminaryAmountMinor);
  assert.deepEqual(booking.quoteVersions[0].lines.map((line) => line.id), ['service_wash']);
  assert.deepEqual(booking.lines.map((line) => line.id), ['service_wash']);
});

test('revising the composition creates an immutable new version and rechecks pricing on the server', async () => {
  const booking = await createBooking({ startAt: '2026-12-22T12:00:00+03:00' });
  const original = { amount: booking.preliminaryAmountMinor, duration: booking.estimatedDurationMinutes };

  const response = await revise(booking.id, {
    selections: [{ type: 'package', id: 'package_complex' }],
    expectedQuoteVersion: 1,
    reason: '  Клиент добавил уход за салоном  '
  });
  assert.equal(response.status, 200);
  const revised = await response.json();
  assert.equal(revised.quoteVersion, 2);
  assert.equal(revised.preliminaryAmountMinor, 490000, 'Mazda sedan is priced as «Средний» by the server');
  assert.equal(revised.estimatedDurationMinutes, 120);
  assert.equal(revised.startAt, booking.startAt);
  assert.equal(revised.customerId, booking.customerId);
  assert.equal(revised.vehicleId, booking.vehicleId);
  assert.deepEqual(revised.lines.map((line) => line.id), ['package_complex']);

  assert.deepEqual(revised.quoteVersions.map((version) => version.version), [1, 2]);
  const [v1, v2] = revised.quoteVersions;
  assert.equal(v1.totalAmountMinor, original.amount);
  assert.equal(v1.totalDurationMinutes, original.duration);
  assert.deepEqual(v1.lines.map((line) => line.id), ['service_wash']);
  assert.equal(v2.vehicleClass, 'Средний');
  assert.equal(v2.reason, 'Клиент добавил уход за салоном');
  assert.equal(v2.actorName, 'Анна');

  const listed = (await (await api('/api/bookings?limit=50')).json()).items.find((item) => item.id === booking.id);
  assert.equal(listed.preliminaryAmountMinor, 490000);
  assert.equal(listed.estimatedDurationMinutes, 120);

  // A later catalog price change must not rewrite stored snapshots.
  const priceUpdate = await api('/api/tenants/current/catalog/packages/package_complex', {
    method: 'PATCH', body: {
      name: 'Комплексный уход', category: 'Комплексы', description: 'Кузов, диски и салон', active: true,
      prices: [{ tenantClass: 'Средний', amountMinor: 525000, durationMinutes: 125 }]
    }
  });
  assert.equal(priceUpdate.status, 200);
  const reread = await (await api(`/api/bookings/${booking.id}`)).json();
  assert.equal(reread.preliminaryAmountMinor, 490000);
  assert.equal(reread.quoteVersions[1].totalAmountMinor, 490000);
  assert.equal(reread.quoteVersions[0].totalAmountMinor, original.amount);

  const stale = await revise(booking.id, { selections: [{ type: 'service', id: 'service_wheels' }], expectedQuoteVersion: 1 });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, 'stale_quote_version');

  const unchanged = await revise(booking.id, { selections: [{ type: 'package', id: 'package_complex' }], expectedQuoteVersion: 2 });
  assert.equal(unchanged.status, 409);
  assert.equal((await unchanged.json()).error.code, 'quote_unchanged');

  const third = await revise(booking.id, {
    selections: [{ type: 'package', id: 'package_complex' }, { type: 'service', id: 'service_wash' }], expectedQuoteVersion: 2
  });
  assert.equal(third.status, 200);
  const v3 = await third.json();
  assert.equal(v3.quoteVersion, 3);
  assert.equal(v3.preliminaryAmountMinor, 525000, 'a new version uses the current catalog, excluding operations already in the package');
  assert.equal(v3.lines.find((line) => line.id === 'service_wash').amountMinor, 0);
  assert.deepEqual(v3.quoteVersions.map((version) => version.totalAmountMinor), [original.amount, 490000, 525000]);
});

test('a longer composition is rejected when the slot no longer fits and nothing changes', async () => {
  const booking = await createBooking({ startAt: '2026-12-23T09:00:00+03:00' });
  await createBooking({ vehicleId: 'veh_camry', startAt: '2026-12-23T10:00:00+03:00' });
  await createBooking({ vehicleId: 'veh_camry', startAt: '2026-12-23T10:00:00+03:00' });

  const response = await revise(booking.id, { selections: [{ type: 'package', id: 'package_complex' }], expectedQuoteVersion: 1 });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'slot_unavailable');

  const reread = await (await api(`/api/bookings/${booking.id}`)).json();
  assert.equal(reread.quoteVersion, 1);
  assert.equal(reread.quoteVersions.length, 1);
  assert.equal(reread.preliminaryAmountMinor, booking.preliminaryAmountMinor);
  assert.equal(reread.estimatedDurationMinutes, booking.estimatedDurationMinutes);
});

test('composition is locked once an order exists or the booking is no longer confirmed', async () => {
  const withOrder = await createBooking({ startAt: '2026-12-24T10:00:00+03:00' });
  assert.equal((await api('/api/orders', { method: 'POST', body: { bookingId: withOrder.id } })).status, 201);
  const locked = await revise(withOrder.id, { selections: [{ type: 'package', id: 'package_complex' }], expectedQuoteVersion: 1 });
  assert.equal(locked.status, 409);
  assert.equal((await locked.json()).error.code, 'booking_has_order');

  const cancelled = await createBooking({ startAt: '2026-12-24T14:00:00+03:00' });
  assert.equal((await api(`/api/bookings/${cancelled.id}`, { method: 'PATCH', body: { status: 'CANCELLED' } })).status, 200);
  const cancelledResult = await revise(cancelled.id, { selections: [{ type: 'package', id: 'package_complex' }], expectedQuoteVersion: 1 });
  assert.equal(cancelledResult.status, 409);
  assert.equal((await cancelledResult.json()).error.code, 'invalid_booking_state');
});

test('revision input is validated without partial changes', async () => {
  const booking = await createBooking({ startAt: '2026-12-25T10:00:00+03:00' });
  const cases = [
    [{ selections: [], expectedQuoteVersion: 1 }, 422, 'validation_error'],
    [{ selections: [{ type: 'package', id: 'package_complex' }] }, 422, 'validation_error'],
    [{ selections: [{ type: 'package', id: 'package_complex' }], expectedQuoteVersion: '1' }, 422, 'validation_error'],
    [{ selections: [{ type: 'package', id: 'package_complex' }], expectedQuoteVersion: 1, reason: 'x'.repeat(201) }, 422, 'validation_error'],
    [{ selections: [{ type: 'package', id: 'package_complex' }], expectedQuoteVersion: 1, vehicleId: 'veh_camry' }, 422, 'validation_error'],
    [{ selections: [{ type: 'service', id: 'service_missing' }], expectedQuoteVersion: 1 }, 404, 'offering_not_found'],
    [{ selections: [{ type: 'package', id: 'package_complex' }, { type: 'package', id: 'package_interior' }], expectedQuoteVersion: 1 }, 409, 'package_overlap']
  ];
  for (const [body, status, code] of cases) {
    const response = await revise(booking.id, body);
    assert.equal(response.status, status, JSON.stringify(body));
    assert.equal((await response.json()).error.code, code);
  }
  const reread = await (await api(`/api/bookings/${booking.id}`)).json();
  assert.equal(reread.quoteVersion, 1);
  assert.deepEqual(reread.lines.map((line) => line.id), ['service_wash']);
});

test('revision is tenant scoped and requires booking management rights', async () => {
  const booking = await createBooking({ startAt: '2026-12-26T10:00:00+03:00' });
  const body = { selections: [{ type: 'package', id: 'package_complex' }], expectedQuoteVersion: 1 };
  assert.equal((await revise(booking.id, body, 'other-session-token')).status, 404);
  assert.equal((await revise(booking.id, body, 'intake-session-token')).status, 403);
  assert.equal((await revise('booking_missing', body)).status, 404);
  const reread = await (await api(`/api/bookings/${booking.id}`)).json();
  assert.equal(reread.quoteVersion, 1);
});
