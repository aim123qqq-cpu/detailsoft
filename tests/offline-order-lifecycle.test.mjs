import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDetailFlowServer } from '../server/app.mjs';
import { localAddPhoto, localAssignMaster, localCloseOrder, localCompleteWork, localCreateEstimate, localCreateOrder, localDecideEstimate, localSaveIntake, localStartWork, localUpdateOperation } from '../src/offline/orderLocal.ts';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const now = '2026-10-19T10:00:00.000Z';
let counter = 0;
const newId = () => `local-${counter++}`;

async function startServer() {
  const server = createDetailFlowServer({ databasePath: ':memory:', seed: true });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, key } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method, headers: { authorization: 'Bearer demo-session-token', 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: response.status, body: await response.json() };
  };
  return { server, call };
}

/** What the phone and the server must agree on (times, audit and documents are server-side detail). */
const shape = (order) => ({
  id: order.id, status: order.status, bookingId: order.bookingId, customerId: order.customerId, vehicleId: order.vehicleId,
  currentEstimateVersionId: order.currentEstimateVersionId,
  estimates: order.estimateVersions.map((version) => ({ id: version.id, version: version.version, total: version.totalAmountMinor, duration: version.totalDurationMinutes,
    lines: version.lines.map(({ id, sourceType, sourceId, name, amountMinor, durationMinutes, reason }) => ({ id, sourceType, sourceId, name, amountMinor, durationMinutes, reason })) })),
  approval: order.approval && { estimateVersionId: order.approval.estimateVersionId, decision: order.approval.decision, method: order.approval.method, responsible: order.approval.responsible },
  assignment: order.assignment && { masterName: order.assignment.masterName, memberId: order.assignment.memberId },
  work: order.work && { status: order.work.status, operations: order.work.operations.map(({ id, name, status }) => ({ id, name, status })) },
  photos: order.photos.map(({ phase, kind, zone }) => ({ phase, kind, zone })),
  handover: order.handover && { responsible: order.handover.responsible, note: order.handover.note }
});

test('the whole order lifecycle on the phone matches the server step by step, with ids chosen on the phone', async () => {
  const { server, call } = await startServer();
  try {
    const booking = (await call('/api/bookings', { method: 'POST', key: 'lifecycle', body: {
      customerId: 'cust_alexey', vehicleId: 'veh_mazda', channel: 'call', startAt: '2026-12-28T10:00:00+03:00', selections: [{ type: 'service', id: 'service_wash' }]
    } })).body;

    const orderId = `order_${randomUUID()}`;
    let local = localCreateOrder(booking, orderId, now);
    let remote = (await call('/api/orders', { method: 'POST', body: { bookingId: booking.id, id: orderId } })).body;
    assert.deepEqual(shape(local), shape(remote), 'order created');

    const intake = { conditionSummary: 'Без замечаний', findings: [], recommendations: [] };
    local = localSaveIntake(local, intake, now, newId);
    const photo = { kind: 'intake', zone: 'Общий вид', dataUrl: PNG };
    local = localAddPhoto(local, photo, now, newId).order;
    await call(`/api/orders/${orderId}/photos`, { method: 'POST', body: photo });
    remote = (await call(`/api/orders/${orderId}/intake`, { method: 'PUT', body: intake })).body;
    assert.deepEqual(shape(local), shape(remote), 'intake');

    const estimateId = `estimate_${randomUUID()}`;
    const lines = [
      { id: `estimate_line_${randomUUID()}`, sourceType: 'service', sourceId: 'service_wash', name: 'Бережная мойка', amountMinor: 140000, durationMinutes: 35 },
      { id: `estimate_line_${randomUUID()}`, sourceType: 'custom', name: ' Чернение шин ', amountMinor: 30000, durationMinutes: 10, reason: 'Попросил клиент' }
    ];
    local = localCreateEstimate(local, lines, estimateId, now).order;
    const estimate = await call(`/api/orders/${orderId}/estimates`, { method: 'POST', body: { id: estimateId, lines } });
    assert.equal(estimate.body.id, estimateId);
    remote = (await call(`/api/orders/${orderId}`)).body;
    assert.deepEqual(shape(local), shape(remote), 'estimate with phone ids');

    const decision = { estimateVersionId: estimateId, decision: 'APPROVED', method: 'in_person', source: 'manager_mobile', responsible: 'Анна' };
    local = localDecideEstimate(local, decision, now);
    remote = (await call(`/api/orders/${orderId}/estimate-approvals`, { method: 'POST', body: decision })).body;
    assert.deepEqual(shape(local), shape(remote), 'approval');
    assert.throws(() => localDecideEstimate(local, decision, now), { code: 'estimate_already_decided' });

    local = localAssignMaster(local, { id: 'member_demo_master', displayName: 'Дмитрий Соколов' }, now);
    remote = (await call(`/api/orders/${orderId}/assignment`, { method: 'PUT', body: { memberId: 'member_demo_master' } })).body;
    assert.deepEqual(shape(local), shape(remote), 'master');

    local = localStartWork(local, now);
    remote = (await call(`/api/orders/${orderId}/work/start`, { method: 'POST' })).body;
    for (const operation of remote.work.operations) {
      local = localUpdateOperation(local, operation.id, 'DONE', '', now);
      await call(`/api/orders/${orderId}/work/operations/${operation.id}`, { method: 'PATCH', body: { status: 'DONE' } });
    }
    local = localCompleteWork(local, now);
    remote = (await call(`/api/orders/${orderId}/work/complete`, { method: 'POST' })).body;
    assert.deepEqual(shape(local), shape(remote), 'work done');

    const handover = { responsible: 'Анна', note: 'Выдан без замечаний', customerAccepted: true, completenessChecked: true };
    assert.throws(() => localCloseOrder(local, handover, now), { code: 'handover_photos_required' });
    const result = { phase: 'result', kind: 'intake', zone: 'Результат', dataUrl: PNG };
    local = localAddPhoto(local, result, now, newId).order;
    await call(`/api/orders/${orderId}/photos`, { method: 'POST', body: result });
    assert.throws(() => localCloseOrder(local, { ...handover, completenessChecked: false }, now), { code: 'validation_error' });
    local = localCloseOrder(local, handover, now);
    remote = (await call(`/api/orders/${orderId}/handover`, { method: 'POST', body: handover })).body;
    assert.deepEqual(shape(local), shape(remote), 'closed');
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test('ids from a phone are checked: wrong format is refused, a reused id or a second intake for the booking conflicts', async () => {
  const { server, call } = await startServer();
  try {
    const booking = (await call('/api/bookings', { method: 'POST', key: 'ids', body: {
      customerId: 'cust_alexey', vehicleId: 'veh_mazda', channel: 'call', startAt: '2026-12-28T10:00:00+03:00', selections: [{ type: 'service', id: 'service_wash' }]
    } })).body;
    assert.equal((await call('/api/orders', { method: 'POST', body: { bookingId: booking.id, id: 'order_1' } })).status, 422);
    const first = `order_${randomUUID()}`;
    assert.equal((await call('/api/orders', { method: 'POST', body: { bookingId: booking.id, id: first } })).status, 201);
    assert.equal((await call('/api/orders', { method: 'POST', body: { bookingId: booking.id, id: first } })).status, 200, 'same id: a replay');
    const second = await call('/api/orders', { method: 'POST', body: { bookingId: booking.id, id: `order_${randomUUID()}` } });
    assert.equal(second.body.error.code, 'order_exists_for_booking', 'another phone already started this intake');

    await call(`/api/orders/${first}/intake`, { method: 'PUT', body: { conditionSummary: 'Принят', findings: [], recommendations: [] } });
    const lineId = `estimate_line_${randomUUID()}`;
    const line = { id: lineId, sourceType: 'custom', name: 'Мойка', amountMinor: 1000, durationMinutes: 10 };
    assert.equal((await call(`/api/orders/${first}/estimates`, { method: 'POST', body: { id: 'estimate_x', lines: [line] } })).status, 422);
    assert.equal((await call(`/api/orders/${first}/estimates`, { method: 'POST', body: { id: `estimate_${randomUUID()}`, lines: [line, line] } })).status, 422, 'duplicate line ids');
    assert.equal((await call(`/api/orders/${first}/estimates`, { method: 'POST', body: { id: `estimate_${randomUUID()}`, lines: [line] } })).status, 201);
    const reused = await call(`/api/orders/${first}/estimates`, { method: 'POST', body: { id: `estimate_${randomUUID()}`, lines: [line] } });
    assert.equal(reused.body.error.code, 'estimate_exists');
  } finally {
    await new Promise((done) => server.close(done));
  }
});
