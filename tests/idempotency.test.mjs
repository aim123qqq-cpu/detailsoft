import test from 'node:test';
import assert from 'node:assert/strict';
import { createDetailFlowServer } from '../server/app.mjs';

async function startServer() {
  const server = createDetailFlowServer({ databasePath: ':memory:', seed: true });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const raw = (path, { method = 'GET', body, token = 'demo-session-token', key } = {}) => fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const call = async (path, options) => {
    const response = await raw(path, options);
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  return { server, call };
}

/** An approved order with an assigned master, ready for work to start. */
async function approvedOrder(call, suffix) {
  const booking = await call('/api/bookings', { method: 'POST', key: `booking-${suffix}`, body: {
    customerId: 'cust_alexey', vehicleId: 'veh_mazda', channel: 'call', startAt: '2026-12-28T10:00:00+03:00', selections: [{ type: 'service', id: 'service_wash' }]
  } });
  const order = (await call('/api/orders', { method: 'POST', body: { bookingId: booking.body.id } })).body;
  await call(`/api/orders/${order.id}/intake`, { method: 'PUT', body: { conditionSummary: 'Принят', findings: [], recommendations: [] } });
  const estimate = (await call(`/api/orders/${order.id}/estimates`, { method: 'POST', body: { lines: [
    { sourceType: 'service', sourceId: 'service_wash', name: 'Бережная мойка', amountMinor: 140000, durationMinutes: 35 },
    { sourceType: 'custom', name: 'Чернение шин', amountMinor: 30000, durationMinutes: 10 }
  ] } })).body;
  await call(`/api/orders/${order.id}/estimate-approvals`, { method: 'POST', body: {
    estimateVersionId: estimate.id, decision: 'APPROVED', method: 'in_person', source: 'manager_mobile', responsible: 'Анна'
  } });
  await call(`/api/orders/${order.id}/assignment`, { method: 'PUT', body: { memberId: 'member_demo_master' } });
  return { orderId: order.id, estimate };
}

test('a retried change with the same key returns the first answer instead of running twice', async () => {
  const { server, call } = await startServer();
  try {
    const { orderId, estimate } = await approvedOrder(call, 'retry');
    const first = await call(`/api/orders/${orderId}/work/start`, { method: 'POST', key: 'offline-1' });
    assert.equal(first.status, 200);
    assert.equal(first.body.status, 'IN_PROGRESS');
    // Work operation ids follow the estimate lines, so an offline phone can reference them.
    assert.deepEqual(first.body.work.operations.map((operation) => operation.id), estimate.lines.map((line) => `work_operation_${line.id}`));

    const retry = await call(`/api/orders/${orderId}/work/start`, { method: 'POST', key: 'offline-1' });
    assert.equal(retry.status, 200);
    assert.equal(retry.headers.get('idempotent-replay'), 'true');
    assert.deepEqual(retry.body, first.body);
    assert.equal((await call(`/api/orders/${orderId}/work/start`, { method: 'POST' })).status, 409, 'without a key the duplicate is refused');

    const operationId = first.body.work.operations[0].id;
    const done = await call(`/api/orders/${orderId}/work/operations/${operationId}`, { method: 'PATCH', key: 'offline-2', body: { status: 'DONE' } });
    assert.equal(done.status, 200);
    const reused = await call(`/api/orders/${orderId}/work/operations/${operationId}`, { method: 'PATCH', key: 'offline-2', body: { status: 'BLOCKED', note: 'другое' } });
    assert.equal(reused.status, 409);
    assert.equal(reused.body.error.code, 'idempotency_conflict');
    assert.equal((await call(`/api/orders/${orderId}`)).body.work.operations[0].status, 'DONE');

    // A refused change is remembered too: the retry gets the same refusal.
    const refused = await call(`/api/orders/${orderId}/work/complete`, { method: 'POST', key: 'offline-3' });
    assert.equal(refused.body.error.code, 'operations_incomplete');
    assert.equal((await call(`/api/orders/${orderId}/work/complete`, { method: 'POST', key: 'offline-3' })).headers.get('idempotent-replay'), 'true');
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test('keys are kept per center and API answers are never cached by the browser', async () => {
  const { server, call } = await startServer();
  try {
    const { orderId } = await approvedOrder(call, 'tenant');
    // The other center reusing the same key is not answered with this center's data.
    const foreign = await call(`/api/orders/${orderId}/work/start`, { method: 'POST', key: 'shared-key', token: 'other-session-token' });
    assert.equal(foreign.status, 404);
    const own = await call(`/api/orders/${orderId}/work/start`, { method: 'POST', key: 'shared-key' });
    assert.equal(own.status, 200);
    assert.equal(own.headers.get('idempotent-replay'), null);

    assert.equal((await call('/api/orders')).headers.get('cache-control'), 'no-store');
  } finally {
    await new Promise((done) => server.close(done));
  }
});
