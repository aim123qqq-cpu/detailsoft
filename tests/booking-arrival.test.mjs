import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDetailFlowServer } from '../server/app.mjs';

let server;
let baseUrl;
let keyCounter = 0;

before(async () => {
  server = createDetailFlowServer({
    databasePath: ':memory:',
    seed: true,
    authTokens: new Map([
      ['demo-session-token', { tenantId: 'tenant_demo', displayName: 'Анна', roles: ['owner', 'admin'] }],
      ['intake-session-token', { tenantId: 'tenant_demo', displayName: 'Ирина', roles: ['intake'] }],
      ['master-session-token', { tenantId: 'tenant_demo', displayName: 'Дмитрий', roles: ['master'] }]
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

function book(startAt, vehicleId = 'veh_mazda') {
  return api('/api/bookings', {
    method: 'POST', headers: { 'idempotency-key': `arrival-${keyCounter += 1}` },
    body: { customerId: 'cust_alexey', vehicleId, channel: 'call', startAt, selections: [{ type: 'service', id: 'service_wash' }] }
  });
}

const markNoShow = (bookingId, token) => api(`/api/bookings/${bookingId}`, { method: 'PATCH', body: { status: 'NO_SHOW' }, token });

test('no-show can be recorded only after the booking start time', async () => {
  const future = await (await book('2026-12-31T10:00:00+03:00')).json();
  const early = await markNoShow(future.id);
  assert.equal(early.status, 409);
  assert.equal((await early.json()).error.code, 'booking_not_started');
  assert.equal((await (await api(`/api/bookings/${future.id}`)).json()).status, 'CONFIRMED');

  const past = await (await book('2026-01-15T10:00:00+03:00')).json();
  const marked = await markNoShow(past.id);
  assert.equal(marked.status, 200);
  assert.equal((await marked.json()).status, 'NO_SHOW');
  const again = await markNoShow(past.id);
  assert.equal(again.status, 409);
  assert.equal((await again.json()).error.code, 'invalid_booking_state');
  assert.equal((await api('/api/orders', { method: 'POST', body: { bookingId: past.id } })).status, 404, 'no intake for a no-show');
});

test('a no-show frees the slot for other clients', async () => {
  const slot = '2026-01-16T12:00:00+03:00';
  const first = await (await book(slot)).json();
  assert.equal((await book(slot, 'veh_camry')).status, 201);
  const full = await book(slot);
  assert.equal(full.status, 409, 'capacity of two is used up');
  assert.equal((await full.json()).error.code, 'slot_unavailable');
  assert.equal((await markNoShow(first.id)).status, 200);
  assert.equal((await book(slot)).status, 201);
});

test('no-show is refused once intake started and requires booking rights', async () => {
  const booking = await (await book('2026-01-17T10:00:00+03:00')).json();
  assert.equal((await markNoShow(booking.id, 'intake-session-token')).status, 403);
  assert.equal((await api('/api/orders', { method: 'POST', body: { bookingId: booking.id } })).status, 201);
  const locked = await markNoShow(booking.id);
  assert.equal(locked.status, 409);
  assert.equal((await locked.json()).error.code, 'booking_has_order');
});

test('upcoming visits are listed soonest first and past unresolved bookings are listed as overdue', async () => {
  const later = await (await book('2027-02-10T10:00:00+03:00')).json();
  const sooner = await (await book('2027-02-01T10:00:00+03:00')).json();
  const unresolved = await (await book('2026-02-03T10:00:00+03:00')).json();
  const started = await (await book('2026-02-04T10:00:00+03:00')).json();
  assert.equal((await api('/api/orders', { method: 'POST', body: { bookingId: started.id } })).status, 201);

  const upcoming = (await (await api('/api/bookings?view=upcoming&limit=50')).json()).items;
  const ids = upcoming.map((item) => item.id);
  assert.ok(ids.indexOf(sooner.id) < ids.indexOf(later.id), 'soonest first');
  assert.ok(!ids.includes(unresolved.id) && !ids.includes(started.id), 'past visits are not upcoming');
  for (let index = 1; index < upcoming.length; index += 1) {
    assert.ok(Date.parse(upcoming[index - 1].startAt) <= Date.parse(upcoming[index].startAt));
  }

  const overdue = (await (await api('/api/bookings?view=overdue&limit=50')).json()).items;
  assert.ok(overdue.some((item) => item.id === unresolved.id));
  assert.ok(overdue.every((item) => item.status === 'CONFIRMED' && item.orderId === null && Date.parse(item.startAt) < Date.now()));
  assert.ok(!overdue.some((item) => item.id === started.id), 'a booking with an order is resolved');

  assert.equal((await api('/api/bookings?view=everything')).status, 422);
});

test('a master can open an existing order but cannot create one', async () => {
  const booking = await (await book('2026-01-18T10:00:00+03:00')).json();
  assert.equal((await api('/api/orders', { method: 'POST', body: { bookingId: booking.id }, token: 'master-session-token' })).status, 403);
  const order = await (await api('/api/orders', { method: 'POST', body: { bookingId: booking.id } })).json();
  const opened = await api(`/api/orders/${order.id}`, { token: 'master-session-token' });
  assert.equal(opened.status, 200);
  assert.equal((await opened.json()).bookingId, booking.id);
});
