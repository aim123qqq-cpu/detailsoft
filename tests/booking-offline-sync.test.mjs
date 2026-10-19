import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDetailFlowServer } from '../server/app.mjs';

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

const at = '2026-12-28T10:00:00+03:00';
const booking = (vehicleId, extra = {}) => ({ customerId: 'cust_alexey', vehicleId, channel: 'call', startAt: at, selections: [{ type: 'service', id: 'service_wash' }], ...extra });

test('a booking sent from the offline queue keeps the phone id and, if its time was taken, is kept with a conflict mark', async () => {
  const { server, call } = await startServer();
  try {
    // The demo center serves two cars at once: fill 10:00.
    for (const [index, vehicleId] of ['veh_mazda', 'veh_camry'].entries()) {
      assert.equal((await call('/api/bookings', { method: 'POST', key: `fill-${index}`, body: booking(vehicleId) })).status, 201);
    }
    const id = `booking_${randomUUID()}`;
    const refused = await call('/api/bookings', { method: 'POST', key: 'online-third', body: booking('veh_mazda', { id }) });
    assert.equal(refused.body.error.code, 'slot_unavailable', 'online booking still refuses a taken time');

    const offline = await call('/api/bookings', { method: 'POST', key: 'offline-third', body: booking('veh_mazda', { id, allowSlotConflict: true }) });
    assert.equal(offline.status, 201);
    assert.equal(offline.body.id, id, 'the id chosen on the phone');
    assert.equal(offline.body.slotConflict, true);
    const replay = await call('/api/bookings', { method: 'POST', key: 'offline-third', body: booking('veh_mazda', { id, allowSlotConflict: true }) });
    assert.equal(replay.status, 200, 'a resend is a replay, not a second booking');

    const upcoming = (await call('/api/bookings?view=upcoming&limit=20')).body.items;
    assert.equal(upcoming.find((item) => item.id === id).slotConflict, true);
    assert.equal(upcoming.filter((item) => item.id !== id).every((item) => item.slotConflict === false), true);

    // Moving it to a free time clears the mark.
    const moved = await call(`/api/bookings/${id}`, { method: 'PATCH', body: { startAt: '2026-12-28T12:00:00+03:00' } });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.slotConflict, false);
    assert.equal((await call(`/api/bookings/${id}`)).body.slotConflict, false);

    assert.equal((await call('/api/bookings', { method: 'POST', key: 'bad-id', body: booking('veh_mazda', { id: 'booking_1', startAt: '2026-12-29T10:00:00+03:00' }) })).status, 422);
    const taken = await call('/api/bookings', { method: 'POST', key: 'other-key', body: booking('veh_mazda', { id, startAt: '2026-12-29T10:00:00+03:00' }) });
    assert.equal(taken.body.error.code, 'booking_exists');
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test('cancelling a conflicting booking also clears its mark', async () => {
  const { server, call } = await startServer();
  try {
    for (const [index, vehicleId] of ['veh_mazda', 'veh_camry'].entries()) await call('/api/bookings', { method: 'POST', key: `fill-${index}`, body: booking(vehicleId) });
    const conflicting = (await call('/api/bookings', { method: 'POST', key: 'conflict', body: booking('veh_mazda', { allowSlotConflict: true }) })).body;
    assert.equal(conflicting.slotConflict, true);
    const cancelled = await call(`/api/bookings/${conflicting.id}`, { method: 'PATCH', body: { status: 'CANCELLED' } });
    assert.equal(cancelled.body.slotConflict, false);
  } finally {
    await new Promise((done) => server.close(done));
  }
});
