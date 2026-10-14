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
      ['admin-token', { tenantId: 'tenant_demo', roles: ['admin'] }],
      ['intake-token', { tenantId: 'tenant_demo', roles: ['intake'] }],
      ['other-admin-token', { tenantId: 'tenant_other', roles: ['admin'] }]
    ])
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const bookingResponse = await api('/api/bookings', {
    method: 'POST',
    headers: { 'idempotency-key': 'analytics-booking' },
    body: {
      customerId: 'cust_alexey',
      vehicleId: 'veh_mazda',
      channel: 'in_person',
      startAt: '2026-11-05T12:00:00+03:00',
      selections: [{ type: 'service', id: 'service_wash' }]
    }
  });
  assert.equal(bookingResponse.status, 201);
  const booking = await bookingResponse.json();

  const midnightBooking = await api('/api/bookings', {
    method: 'POST',
    headers: { 'idempotency-key': 'analytics-midnight-booking' },
    body: {
      customerId: 'cust_alexey',
      vehicleId: 'veh_mazda',
      channel: 'call',
      startAt: '2026-11-30T00:30:00+03:00',
      selections: [{ type: 'service', id: 'service_wash' }]
    }
  });
  assert.equal(midnightBooking.status, 201);

  const orderResponse = await api('/api/orders', { method: 'POST', body: { bookingId: booking.id } });
  assert.equal(orderResponse.status, 201);
  const order = await orderResponse.json();

  await api(`/api/orders/${order.id}/intake`, { method: 'PUT', body: {
    conditionSummary: 'Автомобиль принят', findings: [], recommendations: []
  } });
  const estimateResponse = await api(`/api/orders/${order.id}/estimates`, { method: 'POST', body: { lines: [
    { sourceType: 'service', sourceId: 'service_wash', name: 'Бережная мойка', amountMinor: 140000, durationMinutes: 35 },
    { sourceType: 'custom', name: 'Защита кузова', amountMinor: 90000, durationMinutes: 25 }
  ] } });
  const estimate = await estimateResponse.json();
  await api(`/api/orders/${order.id}/estimate-approvals`, { method: 'POST', body: {
    estimateVersionId: estimate.id,
    decision: 'APPROVED',
    method: 'in_person',
    source: 'manager_mobile',
    responsible: 'Анна'
  } });
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

async function api(path, { token = 'admin-token', method = 'GET', body, headers = {} } = {}) {
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

test('overview returns tenant-scoped operational metrics without treating estimates as payments', async () => {
  const response = await api('/api/analytics/overview?from=2026-10-01&to=2026-11-30');
  assert.equal(response.status, 200);
  const overview = await response.json();

  assert.deepEqual(overview.period, { from: '2026-10-01', to: '2026-11-30' });
  assert.deepEqual(overview.bookings, { total: 2, confirmed: 2, cancelled: 0 });
  assert.equal(overview.orders.total, 2);
  assert.equal(overview.orders.active, 1);
  assert.equal(overview.orders.ready, 0);
  assert.equal(overview.orders.closed, 1);
  assert.equal(overview.orders.approvedEstimateAmountMinor, 230000);
  assert.equal(overview.orders.averageApprovedEstimateAmountMinor, 230000);
  assert.deepEqual(overview.orderStatuses, [
    { status: 'APPROVED', count: 1 },
    { status: 'CLOSED', count: 1 }
  ]);
  assert.ok(overview.daily.some((day) => day.date === '2026-11-05' && day.bookings === 1));
  assert.ok(overview.daily.some((day) => day.date === '2026-11-30' && day.bookings === 1));
  assert.equal('revenueAmountMinor' in overview.orders, false);
  assert.equal('paidAmountMinor' in overview.orders, false);

  const foreignResponse = await api('/api/analytics/overview?from=2026-10-01&to=2026-11-30', { token: 'other-admin-token' });
  const foreign = await foreignResponse.json();
  assert.equal(foreign.orders.total, 0);
  assert.equal(foreign.bookings.total, 0);
});

test('overview requires a manager role and a valid period of no more than 90 days', async () => {
  const forbidden = await api('/api/analytics/overview?from=2026-10-01&to=2026-10-31', { token: 'intake-token' });
  assert.equal(forbidden.status, 403);

  for (const query of [
    'from=2026-10-32&to=2026-11-01',
    'from=2026-11-01&to=2026-10-01',
    'from=2026-01-01&to=2026-10-01'
  ]) {
    const invalid = await api(`/api/analytics/overview?${query}`);
    assert.equal(invalid.status, 422);
    assert.equal((await invalid.json()).error.code, 'validation_error');
  }
});
