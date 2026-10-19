import test from 'node:test';
import assert from 'node:assert/strict';
import { createDetailFlowServer } from '../server/app.mjs';
import { localAddPhoto, localCompleteWork, localSaveIntake, localSetPause, localStartWork, localUpdateOperation } from '../src/offline/orderLocal.ts';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
let counter = 0;
const newId = () => `test-${counter++}`;
const now = '2026-10-19T10:00:00.000Z';

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

/** The phone's rules give the same order as the server for the same sequence of work actions. */
test('offline work actions produce the order the server produces', async () => {
  const { server, call } = await startServer();
  try {
    const booking = await call('/api/bookings', { method: 'POST', key: 'local-parity', body: {
      customerId: 'cust_alexey', vehicleId: 'veh_mazda', channel: 'call', startAt: '2026-12-28T10:00:00+03:00', selections: [{ type: 'service', id: 'service_wash' }]
    } });
    const created = (await call('/api/orders', { method: 'POST', body: { bookingId: booking.body.id } })).body;

    // Intake and an intake photo.
    const intakeInput = { conditionSummary: 'Царапина на крыле', findings: [{ zone: 'Крыло', severity: 'LOW', note: 'Царапина' }], recommendations: [] };
    const localIntake = localSaveIntake(created, intakeInput, now, newId);
    const serverIntake = (await call(`/api/orders/${created.id}/intake`, { method: 'PUT', body: intakeInput })).body;
    assert.equal(localIntake.status, serverIntake.status);
    assert.deepEqual(localIntake.intake.findings.map(({ zone, severity, note }) => ({ zone, severity, note })), serverIntake.intake.findings.map(({ zone, severity, note }) => ({ zone, severity, note })));
    const { order: withPhoto } = localAddPhoto(serverIntake, { kind: 'intake', zone: 'Общий вид', dataUrl: PNG }, now, newId);
    assert.equal(withPhoto.photos.length, 1);
    assert.equal(withPhoto.photos[0].mimeType, 'image/png');

    const estimate = (await call(`/api/orders/${created.id}/estimates`, { method: 'POST', body: { lines: [
      { sourceType: 'service', sourceId: 'service_wash', name: 'Бережная мойка', amountMinor: 140000, durationMinutes: 35 },
      { sourceType: 'custom', name: 'Чернение шин', amountMinor: 30000, durationMinutes: 10 }
    ] } })).body;
    await call(`/api/orders/${created.id}/estimate-approvals`, { method: 'POST', body: { estimateVersionId: estimate.id, decision: 'APPROVED', method: 'in_person', source: 'manager_mobile', responsible: 'Анна' } });
    const approved = (await call(`/api/orders/${created.id}/assignment`, { method: 'PUT', body: { memberId: 'member_demo_master' } })).body;
    assert.throws(() => localSaveIntake(approved, intakeInput, now, newId), { code: 'invalid_order_state' });
    assert.throws(() => localAddPhoto(approved, { kind: 'intake', zone: 'Общий вид', dataUrl: PNG }, now, newId), { code: 'invalid_order_state' });

    // Start: same status and the very same operation ids.
    let local = localStartWork(approved, now);
    const started = (await call(`/api/orders/${created.id}/work/start`, { method: 'POST' })).body;
    assert.equal(local.status, started.status);
    assert.deepEqual(local.work.operations.map((operation) => [operation.id, operation.name, operation.status]), started.work.operations.map((operation) => [operation.id, operation.name, operation.status]));
    assert.throws(() => localStartWork(local, now), { code: 'invalid_order_state' });

    // Pause blocks operations and completion, as on the server.
    local = localSetPause(local, true, 'Ждём химию', now);
    assert.throws(() => localUpdateOperation(local, local.work.operations[0].id, 'DONE', '', now), { code: 'invalid_order_state' });
    assert.throws(() => localSetPause(local, true, 'Ещё раз', now), { code: 'invalid_order_state' });
    local = localSetPause(local, false, '', now);
    assert.throws(() => localCompleteWork(local, now), { code: 'operations_incomplete' });

    for (const operation of started.work.operations) {
      local = localUpdateOperation(local, operation.id, 'DONE', '', now);
      await call(`/api/orders/${created.id}/work/operations/${operation.id}`, { method: 'PATCH', body: { status: 'DONE' } });
    }
    local = localCompleteWork(local, now);
    const completed = (await call(`/api/orders/${created.id}/work/complete`, { method: 'POST' })).body;
    assert.equal(local.status, completed.status);
    assert.equal(local.work.status, completed.work.status);

    // Result photos are allowed only before handover, like on the server.
    assert.equal(localAddPhoto(completed, { phase: 'result', kind: 'intake', zone: 'Результат', dataUrl: PNG }, now, newId).photo.phase, 'result');
  } finally {
    await new Promise((done) => server.close(done));
  }
});
