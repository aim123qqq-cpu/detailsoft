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

test('tenant catalog uses the selected vehicle tenant pricing class', async () => {
  const response = await api('/api/tenants/current/services?vehicleId=veh_mazda');
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.vehicleClass, 'Средний');
  assert.ok(payload.categories.some((category) => category.name === 'Мойка и уход'));
  const wash = payload.categories.flatMap((category) => category.items)
    .find((item) => item.id === 'service_wash');
  assert.equal(wash.price.amountMinor, 140000);
  assert.equal(wash.price.label, '1 400 ₽');
});

test('another tenant cannot read a vehicle catalog through a foreign vehicle id', async () => {
  const response = await api('/api/tenants/current/services?vehicleId=veh_mazda', { tenant: 'tenant_other' });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, 'vehicle_not_found');
});

test('quote preview excludes operations already covered by a selected package', async () => {
  const response = await api('/api/bookings/quote-preview', {
    method: 'POST',
    body: {
      vehicleId: 'veh_mazda',
      selections: [
        { type: 'package', id: 'package_complex' },
        { type: 'service', id: 'service_wash' }
      ]
    }
  });
  assert.equal(response.status, 200);
  const quote = await response.json();
  assert.equal(quote.preliminary, true);
  assert.equal(quote.totalAmountMinor, 490000);
  const wash = quote.lines.find((line) => line.id === 'service_wash');
  assert.equal(wash.amountMinor, 0);
  assert.equal(wash.excluded, true);
  assert.equal(wash.excludedOperations.length, 3);
  assert.ok(quote.warnings.some((warning) => warning.code === 'package_overlap'));
});

test('overlapping packages are rejected instead of charging shared operations twice', async () => {
  const response = await api('/api/bookings/quote-preview', {
    method: 'POST',
    body: {
      vehicleId: 'veh_mazda',
      selections: [
        { type: 'package', id: 'package_complex' },
        { type: 'package', id: 'package_interior' }
      ]
    }
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'package_overlap');
});

test('standalone service quote sums operation prices for the tenant class', async () => {
  const response = await api('/api/bookings/quote-preview', {
    method: 'POST',
    body: {
      vehicleId: 'veh_mazda',
      selections: [{ type: 'service', id: 'service_wash' }]
    }
  });
  const quote = await response.json();
  assert.equal(quote.totalAmountMinor, 140000);
  assert.equal(quote.totalDurationMinutes, 35);
  assert.deepEqual(quote.lines[0].operations.map((operation) => operation.name), [
    'Предварительная мойка', 'Ручная мойка кузова', 'Сушка кузова'
  ]);
});

test('booking creation stores a server-calculated quote without requiring a box', async () => {
  const response = await api('/api/bookings', {
    method: 'POST',
    headers: { 'idempotency-key': 'booking-test-1' },
    body: {
      customerId: 'cust_alexey',
      vehicleId: 'veh_mazda',
      channel: 'telegram',
      startAt: '2026-10-20T11:00:00+03:00',
      selections: [{ type: 'service', id: 'service_wash' }]
    }
  });
  assert.equal(response.status, 201);
  const booking = await response.json();
  assert.equal(booking.status, 'CONFIRMED');
  assert.equal(booking.preliminaryAmountMinor, 140000);
  assert.equal(booking.estimatedDurationMinutes, 35);
  assert.equal(booking.resourceId, null);
  assert.equal(booking.timezone, 'Europe/Moscow');

  const replay = await api('/api/bookings', {
    method: 'POST',
    headers: { 'idempotency-key': 'booking-test-1' },
    body: {
      customerId: 'cust_alexey',
      vehicleId: 'veh_mazda',
      channel: 'telegram',
      startAt: '2026-10-20T11:00:00+03:00',
      selections: [{ type: 'service', id: 'service_wash' }]
    }
  });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).id, booking.id);

  const conflictingReplay = await api('/api/bookings', {
    method: 'POST',
    headers: { 'idempotency-key': 'booking-test-1' },
    body: {
      customerId: 'cust_alexey',
      vehicleId: 'veh_mazda',
      channel: 'telegram',
      startAt: '2026-10-20T12:00:00+03:00',
      selections: [{ type: 'service', id: 'service_wash' }]
    }
  });
  assert.equal(conflictingReplay.status, 409);
  assert.equal((await conflictingReplay.json()).error.code, 'idempotency_conflict');
});

test('center capacity protects a slot without requiring individual boxes', async () => {
  const body = {
    customerId: 'cust_alexey',
    vehicleId: 'veh_mazda',
    channel: 'call',
    startAt: '2026-10-21T14:30:00+03:00',
    selections: [{ type: 'service', id: 'service_wash' }]
  };
  const first = await api('/api/bookings', { method: 'POST', headers: { 'idempotency-key': 'capacity-1' }, body });
  const second = await api('/api/bookings', { method: 'POST', headers: { 'idempotency-key': 'capacity-2' }, body });
  const third = await api('/api/bookings', { method: 'POST', headers: { 'idempotency-key': 'capacity-3' }, body });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(third.status, 409);
  assert.equal((await third.json()).error.code, 'slot_unavailable');

  const availability = await api('/api/bookings/availability?date=2026-10-21&durationMinutes=35');
  assert.equal(availability.status, 200);
  const slot = (await availability.json()).slots.find((item) => item.time === '14:30');
  assert.equal(slot.available, false);
});
