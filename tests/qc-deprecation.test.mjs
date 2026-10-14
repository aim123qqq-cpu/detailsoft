import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDetailFlowServer } from '../server/app.mjs';

let server;
let baseUrl;
let orderId;

before(async () => {
  server = createDetailFlowServer({ databasePath: ':memory:', seed: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const bookingResponse = await api('/api/bookings', {
    method: 'POST', headers: { 'idempotency-key': 'qc-deprecation-booking' }, body: {
      customerId: 'cust_alexey', vehicleId: 'veh_mazda', channel: 'in_person',
      startAt: '2026-12-02T12:00:00+03:00', selections: [{ type: 'service', id: 'service_wash' }]
    }
  });
  const booking = await bookingResponse.json();
  const orderResponse = await api('/api/orders', { method: 'POST', body: { bookingId: booking.id } });
  const order = await orderResponse.json();
  orderId = order.id;
  await api(`/api/orders/${orderId}/intake`, { method: 'PUT', body: {
    conditionSummary: 'Автомобиль принят', findings: [], recommendations: []
  } });
  const estimateResponse = await api(`/api/orders/${orderId}/estimates`, { method: 'POST', body: { lines: [
    { sourceType: 'service', sourceId: 'service_wash', name: 'Бережная мойка', amountMinor: 140000, durationMinutes: 35 }
  ] } });
  const estimate = await estimateResponse.json();
  await api(`/api/orders/${orderId}/estimate-approvals`, { method: 'POST', body: {
    estimateVersionId: estimate.id, decision: 'APPROVED', method: 'in_person', source: 'manager_mobile', responsible: 'Анна'
  } });
  await api(`/api/orders/${orderId}/assignment`, { method: 'PUT', body: { masterName: 'Дмитрий Соколов' } });
  const started = await (await api(`/api/orders/${orderId}/work/start`, { method: 'POST', body: {} })).json();
  for (const operation of started.work.operations) {
    await api(`/api/orders/${orderId}/work/operations/${operation.id}`, { method: 'PATCH', body: { status: 'DONE', note: '' } });
  }
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

async function api(path, { method = 'GET', body, headers = {} } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: 'Bearer demo-session-token',
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

test('QC is deprecated by default and completed work proceeds directly to delivery', async () => {
  const completed = await api(`/api/orders/${orderId}/work/complete`, { method: 'POST', body: {} });
  assert.equal(completed.status, 200);
  const order = await completed.json();
  assert.equal(order.status, 'READY');
  assert.equal(order.qualityControl.length, 0);
  assert.ok(order.auditTrail.some((event) => event.eventType === 'WORK_COMPLETED'));

  const deprecated = await api(`/api/orders/${orderId}/qc`, { method: 'POST', body: {
    decision: 'PASSED', responsible: 'Мария', note: 'Проверка',
    checks: [{ code: 'body', label: 'Кузов', passed: true }]
  } });
  assert.equal(deprecated.status, 410);
  assert.equal((await deprecated.json()).error.code, 'feature_deprecated');
});
