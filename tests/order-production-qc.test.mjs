import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDetailFlowServer } from '../server/app.mjs';

let server;
let baseUrl;
let orderId;

before(async () => {
  server = createDetailFlowServer({
    databasePath: ':memory:',
    seed: true,
    features: { qualityControl: true },
    authTokens: new Map([
      ['demo-session-token', { tenantId: 'tenant_demo', roles: ['admin', 'intake', 'master', 'qc'] }],
      ['intake-only-token', { tenantId: 'tenant_demo', roles: ['intake'] }],
      ['other-session-token', { tenantId: 'tenant_other', roles: ['admin'] }]
    ])
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const bookingResponse = await api('/api/bookings', {
    method: 'POST', headers: { 'idempotency-key': 'production-flow-booking' }, body: {
      customerId: 'cust_alexey', vehicleId: 'veh_mazda', channel: 'in_person',
      startAt: '2026-11-05T12:00:00+03:00', selections: [{ type: 'service', id: 'service_wash' }]
    }
  });
  const booking = await bookingResponse.json();
  const createdOrder = await api('/api/orders', { method: 'POST', body: { bookingId: booking.id } });
  orderId = (await createdOrder.json()).id;
  await api(`/api/orders/${orderId}/intake`, { method: 'PUT', body: {
    conditionSummary: 'Автомобиль принят',
    findings: [{ zone: 'Кузов', severity: 'LOW', note: 'Лёгкие загрязнения' }],
    recommendations: []
  } });
  const estimateResponse = await api(`/api/orders/${orderId}/estimates`, { method: 'POST', body: { lines: [
    { sourceType: 'service', sourceId: 'service_wash', name: 'Бережная мойка', amountMinor: 140000, durationMinutes: 35 },
    { sourceType: 'recommendation', name: 'Защита кузова', amountMinor: 90000, durationMinutes: 25 }
  ] } });
  const estimate = await estimateResponse.json();
  await api(`/api/orders/${orderId}/estimate-approvals`, { method: 'POST', body: {
    estimateVersionId: estimate.id, decision: 'APPROVED', method: 'in_person', source: 'manager_mobile', responsible: 'Анна'
  } });
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

test('assignment is role-protected and starts only from an approved order', async () => {
  const forbidden = await api(`/api/orders/${orderId}/assignment`, {
    token: 'intake-only-token', method: 'PUT', body: { masterName: 'Дмитрий Соколов' }
  });
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).error.code, 'forbidden');

  const assigned = await api(`/api/orders/${orderId}/assignment`, {
    method: 'PUT', body: { masterName: 'Дмитрий Соколов' }
  });
  assert.equal(assigned.status, 200);
  assert.equal((await assigned.json()).assignment.masterName, 'Дмитрий Соколов');

  const started = await api(`/api/orders/${orderId}/work/start`, { method: 'POST', body: {} });
  assert.equal(started.status, 200);
  const order = await started.json();
  assert.equal(order.status, 'IN_PROGRESS');
  assert.equal(order.work.status, 'ACTIVE');
  assert.equal(order.work.operations.length, 2);
  assert.deepEqual(order.work.operations.map((item) => item.name), ['Бережная мойка', 'Защита кузова']);
});

test('work cannot finish until every approved operation is done', async () => {
  const incomplete = await api(`/api/orders/${orderId}/work/complete`, { method: 'POST', body: {} });
  assert.equal(incomplete.status, 409);
  assert.equal((await incomplete.json()).error.code, 'operations_incomplete');

  const order = await (await api(`/api/orders/${orderId}`)).json();
  for (const operation of order.work.operations) {
    const updated = await api(`/api/orders/${orderId}/work/operations/${operation.id}`, {
      method: 'PATCH', body: { status: 'DONE', note: operation.name === 'Защита кузова' ? 'Нанесено после мойки' : '' }
    });
    assert.equal(updated.status, 200);
  }
  const completedOrder = await (await api(`/api/orders/${orderId}`)).json();
  assert.ok(completedOrder.work.operations.every((item) => item.status === 'DONE'));
});

test('master can pause and resume with a journaled reason', async () => {
  const paused = await api(`/api/orders/${orderId}/work/pause`, {
    method: 'POST', body: { note: 'Ожидаем освобождения зоны сушки' }
  });
  assert.equal(paused.status, 200);
  const pausedOrder = await paused.json();
  assert.equal(pausedOrder.work.status, 'PAUSED');
  const pausedUpdate = await api(`/api/orders/${orderId}/work/operations/${pausedOrder.work.operations[0].id}`, {
    method: 'PATCH', body: { status: 'PENDING', note: 'Не должно измениться на паузе' }
  });
  assert.equal(pausedUpdate.status, 409);
  assert.equal((await pausedUpdate.json()).error.code, 'invalid_order_state');

  const resumed = await api(`/api/orders/${orderId}/work/resume`, { method: 'POST', body: {} });
  assert.equal(resumed.status, 200);
  const order = await resumed.json();
  assert.equal(order.work.status, 'ACTIVE');
  assert.ok(order.auditTrail.some((event) => event.eventType === 'WORK_PAUSED'));
});

test('QC can return work for rework and later release it for delivery', async () => {
  const qcReady = await api(`/api/orders/${orderId}/work/complete`, { method: 'POST', body: {} });
  assert.equal(qcReady.status, 200);
  assert.equal((await qcReady.json()).status, 'QC');

  const rework = await api(`/api/orders/${orderId}/qc`, { method: 'POST', body: {
    decision: 'REWORK', responsible: 'Мария, QC', note: 'Остался развод на капоте',
    checks: [{ code: 'body', label: 'Кузов без разводов', passed: false }]
  } });
  assert.equal(rework.status, 200);
  const reworkOrder = await rework.json();
  assert.equal(reworkOrder.status, 'IN_PROGRESS');
  const reworkOperation = reworkOrder.work.operations.find((item) => item.status === 'PENDING');
  assert.match(reworkOperation.name, /Доработка/);

  const prematureQc = await api(`/api/orders/${orderId}/work/complete`, { method: 'POST', body: {} });
  assert.equal(prematureQc.status, 409);
  await api(`/api/orders/${orderId}/work/operations/${reworkOperation.id}`, {
    method: 'PATCH', body: { status: 'DONE', note: 'Развод устранён' }
  });

  const backToQc = await api(`/api/orders/${orderId}/work/complete`, { method: 'POST', body: {} });
  assert.equal((await backToQc.json()).status, 'QC');
  const passed = await api(`/api/orders/${orderId}/qc`, { method: 'POST', body: {
    decision: 'PASSED', responsible: 'Мария, QC', note: 'Повторная проверка пройдена',
    checks: [
      { code: 'body', label: 'Кузов без разводов', passed: true },
      { code: 'interior', label: 'Салон чистый', passed: true },
      { code: 'handover', label: 'Комплектность сохранена', passed: true }
    ]
  } });
  assert.equal(passed.status, 200);
  const ready = await passed.json();
  assert.equal(ready.status, 'READY');
  assert.equal(ready.qualityControl.at(-1).decision, 'PASSED');
  assert.ok(ready.auditTrail.some((event) => event.eventType === 'QC_REWORK'));
  assert.ok(ready.auditTrail.some((event) => event.eventType === 'QC_PASSED'));
});

test('delivery closes a ready order without a payment workflow', async () => {
  const forbidden = await api(`/api/orders/${orderId}/handover`, {
    token: 'intake-only-token', method: 'POST', body: { responsible: 'Анна', note: 'Клиент проверил автомобиль' }
  });
  assert.equal(forbidden.status, 403);

  const foreign = await api(`/api/orders/${orderId}/handover`, {
    token: 'other-session-token', method: 'POST', body: { responsible: 'Анна', note: 'Клиент проверил автомобиль' }
  });
  assert.equal(foreign.status, 404);

  const removedPaymentsRoute = await api(`/api/orders/${orderId}/payments`, {
    method: 'POST', body: { amountMinor: 100000, method: 'card', responsible: 'Анна' }
  });
  assert.equal(removedPaymentsRoute.status, 404);

  const handover = await api(`/api/orders/${orderId}/handover`, {
    method: 'POST', body: { responsible: 'Анна', note: 'Клиент проверил автомобиль' }
  });
  assert.equal(handover.status, 200);
  const closed = await handover.json();
  assert.equal(closed.status, 'CLOSED');
  assert.equal(closed.handover.responsible, 'Анна');
  assert.ok(closed.auditTrail.some((event) => event.eventType === 'ORDER_CLOSED'));
});

test('orders workspace returns tenant-scoped operational summaries', async () => {
  const response = await api('/api/orders?limit=20');
  assert.equal(response.status, 200);
  const items = (await response.json()).items;
  const order = items.find((item) => item.id === orderId);
  assert.equal(order.status, 'CLOSED');
  assert.equal(order.customer.name, 'Алексей Морозов');
  assert.equal(order.vehicle.plate, 'А123АА 55');
  assert.equal(order.masterName, 'Дмитрий Соколов');
  assert.equal(order.totalAmountMinor, 230000);

  const foreign = await api('/api/orders?limit=20', { token: 'other-session-token' });
  assert.deepEqual((await foreign.json()).items, []);
});
