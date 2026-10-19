import test from 'node:test';
import assert from 'node:assert/strict';
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

const at = (time) => `2026-12-28T${time}:00+03:00`;
const book = (call, key, vehicleId, time) => call('/api/bookings', { method: 'POST', key, body: {
  customerId: 'cust_alexey', vehicleId, channel: 'call', startAt: at(time), selections: [{ type: 'service', id: 'service_wash' }]
} });

test('a longer composition is saved together with a new time in one step, or nothing changes', async () => {
  const { server, call } = await startServer();
  try {
    const booking = (await book(call, 'a', 'veh_mazda', '10:00')).body;
    // Capacity 2: 11:00 is full, so the 2-hour package cannot stay at 10:00 (nor start at 10:30).
    assert.equal((await book(call, 'b', 'veh_camry', '11:00')).status, 201);
    assert.equal((await book(call, 'c', 'veh_camry', '11:00')).status, 201);
    const longer = { selections: [{ type: 'package', id: 'package_complex' }], expectedQuoteVersion: 1 };

    const refused = await call(`/api/bookings/${booking.id}/quote`, { method: 'PUT', body: longer });
    assert.equal(refused.body.error.code, 'slot_unavailable');
    const busyTime = await call(`/api/bookings/${booking.id}/quote`, { method: 'PUT', body: { ...longer, startAt: at('10:30') } });
    assert.equal(busyTime.body.error.code, 'slot_unavailable');
    assert.match(busyTime.body.error.message, /и в это время/);
    const untouched = (await call(`/api/bookings/${booking.id}`)).body;
    assert.equal(untouched.quoteVersion, 1);
    assert.equal(untouched.startAt, at('10:00'));

    const moved = await call(`/api/bookings/${booking.id}/quote`, { method: 'PUT', body: { ...longer, startAt: at('12:00') } });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.quoteVersion, 2);
    assert.equal(moved.body.startAt, at('12:00'));
    assert.equal(moved.body.estimatedDurationMinutes, 120);
    assert.equal((await call(`/api/bookings/${booking.id}/quote`, { method: 'PUT', body: { ...longer, expectedQuoteVersion: 2, startAt: 'вчера' } })).status, 422);
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test('free time for moving a booking does not count that booking itself', async () => {
  const { server, call } = await startServer();
  try {
    const booking = (await book(call, 'a', 'veh_mazda', '10:00')).body;
    await book(call, 'b', 'veh_camry', '10:00');
    const slot = async (query) => (await call(`/api/bookings/availability?date=2026-12-28&durationMinutes=35${query}`)).body.slots.find((item) => item.time === '10:00');
    assert.equal((await slot('')).available, false, 'two cars at 10:00 fill the center');
    assert.equal((await slot(`&excludeBookingId=${booking.id}`)).available, true, 'the moved booking frees its own place');
  } finally {
    await new Promise((done) => server.close(done));
  }
});
