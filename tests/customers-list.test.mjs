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
      ['master-session-token', { tenantId: 'tenant_demo', displayName: 'Дмитрий', roles: ['master'] }],
      ['other-session-token', { tenantId: 'tenant_other', displayName: 'Администратор', roles: ['admin'] }]
    ])
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

let key = 0;
const api = (path, { token = 'demo-session-token', method = 'GET', body } = {}) => fetch(`${baseUrl}${path}`, {
  method, headers: { authorization: `Bearer ${token}`, 'idempotency-key': `customers-list-${key += 1}`, ...(body ? { 'content-type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined
});

test('the customers list shows everyone in the center with cars and what is going on now', async () => {
  const list = await (await api('/api/customers/list')).json();
  const alexey = list.items.find((item) => item.id === 'cust_alexey');
  assert.ok(alexey, 'the seeded customer is listed');
  assert.equal(alexey.name, 'Алексей Морозов');
  assert.ok(alexey.vehicles.some((vehicle) => vehicle.make === 'Mazda'));
  assert.equal(list.total, list.items.filter((item) => !item.archived).length);
  assert.equal('phoneNormalized' in alexey, false, 'the search key stays on the server');

  // A booking in the future shows up as "what is next"; the filter keeps only such customers.
  const tomorrow = new Date(Date.now() + 24 * 60 * 60_000).toISOString().slice(0, 10);
  const booked = await api('/api/bookings', { method: 'POST', body: { customerId: 'cust_alexey', vehicleId: 'veh_mazda', channel: 'call', startAt: `${tomorrow}T12:00:00+03:00`, selections: [{ type: 'service', id: 'service_wash' }] } });
  assert.equal(booked.status, 201);
  const withBooking = await (await api('/api/customers/list?filter=booked')).json();
  assert.deepEqual(withBooking.items.map((item) => item.id), ['cust_alexey']);
  assert.ok(withBooking.items[0].nextBookingAt);

  // An open order takes over; the booking no longer counts as "next".
  const booking = await booked.json();
  assert.equal((await api('/api/orders', { method: 'POST', body: { bookingId: booking.id } })).status, 201);
  const active = await (await api('/api/customers/list?filter=active')).json();
  assert.equal(active.items[0].openOrderStatus, 'INTAKE');
  assert.equal(active.items[0].nextBookingAt, null);
});

test('search matches a name, phone digits or a plate; other centers and roles see nothing', async () => {
  for (const query of ['мороз', '913 123', 'а123']) {
    const found = await (await api(`/api/customers/list?query=${encodeURIComponent(query)}`)).json();
    assert.ok(found.items.some((item) => item.id === 'cust_alexey'), `found by "${query}"`);
  }
  assert.equal((await (await api('/api/customers/list?query=zzzz')).json()).items.length, 0);
  const foreign = await (await api('/api/customers/list', { token: 'other-session-token' })).json();
  assert.equal(foreign.items.some((item) => item.id === 'cust_alexey'), false);
  assert.equal((await api('/api/customers/list', { token: 'master-session-token' })).status, 403);
});
