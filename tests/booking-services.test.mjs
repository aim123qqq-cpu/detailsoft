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
      ['demo-session-token', { tenantId: 'tenant_demo', roles: ['admin', 'intake', 'master', 'qc'] }],
      ['intake-only-token', { tenantId: 'tenant_demo', roles: ['intake'] }],
      ['other-session-token', { tenantId: 'tenant_other', roles: ['admin'] }]
    ])
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

async function api(path, { tenant = 'tenant_demo', token, method = 'GET', body, headers = {} } = {}) {
  const sessionToken = token ?? (tenant === 'tenant_other' ? 'other-session-token' : 'demo-session-token');
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${sessionToken}`,
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

test('bookings workspace lists only the current tenant records', async () => {
  const response = await api('/api/bookings?limit=20');
  assert.equal(response.status, 200);
  const items = (await response.json()).items;
  assert.ok(items.length >= 3);
  assert.ok(items.every((item) => item.customer.name === 'Алексей Морозов'));
  assert.ok(items.some((item) => item.vehicle.plate === 'А123АА 55'));
  assert.ok(items.every((item) => item.status === 'CONFIRMED'));

  const foreign = await api('/api/bookings?limit=20', { tenant: 'tenant_other' });
  assert.deepEqual((await foreign.json()).items, []);
});

test('calendar range is tenant scoped, validated and ordered chronologically', async () => {
  const response = await api('/api/bookings?from=2026-10-20&to=2026-10-21&limit=50');
  assert.equal(response.status, 200);
  const items = (await response.json()).items;
  assert.ok(items.length >= 3);
  assert.ok(items.every((item) => item.startAt.slice(0, 10) === '2026-10-20' || item.startAt.slice(0, 10) === '2026-10-21'));
  assert.deepEqual(items.map((item) => item.startAt), [...items.map((item) => item.startAt)].sort());

  const foreign = await api('/api/bookings?from=2026-10-20&to=2026-10-21', { tenant: 'tenant_other' });
  assert.deepEqual((await foreign.json()).items, []);
  assert.equal((await api('/api/bookings?from=2026-10-21&to=2026-10-20')).status, 422);
  assert.equal((await api('/api/bookings?from=2026-10-01&to=2026-11-15')).status, 422);
  assert.equal((await api('/api/bookings?from=not-a-date&to=2026-10-20')).status, 422);
  assert.equal((await api('/api/bookings?from=2026-10-20')).status, 422);
});

test('a confirmed booking can be rescheduled and cancelled without losing history', async () => {
  const createdResponse = await api('/api/bookings', {
    method: 'POST',
    headers: { 'idempotency-key': 'booking-manage-1' },
    body: {
      customerId: 'cust_alexey',
      vehicleId: 'veh_mazda',
      channel: 'call',
      startAt: '2026-10-24T09:00:00+03:00',
      selections: [{ type: 'service', id: 'service_wash' }]
    }
  });
  const created = await createdResponse.json();

  const forbidden = await api(`/api/bookings/${created.id}`, {
    token: 'intake-only-token', method: 'PATCH', body: { status: 'CANCELLED' }
  });
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).error.code, 'forbidden');

  const movedResponse = await api(`/api/bookings/${created.id}`, {
    method: 'PATCH', body: { startAt: '2026-10-24T12:00:00+03:00' }
  });
  assert.equal(movedResponse.status, 200);
  assert.equal((await movedResponse.json()).startAt, '2026-10-24T12:00:00+03:00');

  const cancelledResponse = await api(`/api/bookings/${created.id}`, {
    method: 'PATCH', body: { status: 'CANCELLED' }
  });
  assert.equal(cancelledResponse.status, 200);
  assert.equal((await cancelledResponse.json()).status, 'CANCELLED');

  const invalidMove = await api(`/api/bookings/${created.id}`, {
    method: 'PATCH', body: { startAt: '2026-10-24T14:30:00+03:00' }
  });
  assert.equal(invalidMove.status, 409);
  assert.equal((await invalidMove.json()).error.code, 'invalid_booking_state');

  const foreign = await api(`/api/bookings/${created.id}`, {
    tenant: 'tenant_other', method: 'PATCH', body: { status: 'CANCELLED' }
  });
  assert.equal(foreign.status, 404);
});

test('rescheduling respects center capacity and bookings with orders are locked', async () => {
  const create = async (key, startAt) => {
    const response = await api('/api/bookings', {
      method: 'POST', headers: { 'idempotency-key': key },
      body: {
        customerId: 'cust_alexey', vehicleId: 'veh_mazda', channel: 'telegram', startAt,
        selections: [{ type: 'service', id: 'service_wash' }]
      }
    });
    return response.json();
  };
  await create('booking-capacity-target-1', '2026-10-25T14:30:00+03:00');
  await create('booking-capacity-target-2', '2026-10-25T14:30:00+03:00');
  const movable = await create('booking-capacity-movable', '2026-10-25T09:00:00+03:00');

  const conflict = await api(`/api/bookings/${movable.id}`, {
    method: 'PATCH', body: { startAt: '2026-10-25T14:30:00+03:00' }
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, 'slot_unavailable');

  const order = await api('/api/orders', { method: 'POST', body: { bookingId: movable.id } });
  assert.equal(order.status, 201);
  const locked = await api(`/api/bookings/${movable.id}`, {
    method: 'PATCH', body: { status: 'CANCELLED' }
  });
  assert.equal(locked.status, 409);
  assert.equal((await locked.json()).error.code, 'booking_has_order');
});
