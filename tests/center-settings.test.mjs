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
      ['owner-token', { tenantId: 'tenant_demo', roles: ['owner'] }],
      ['intake-token', { tenantId: 'tenant_demo', roles: ['intake'] }],
      ['other-owner-token', { tenantId: 'tenant_other', roles: ['owner'] }]
    ])
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
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

test('center settings are tenant scoped and restricted to owners and administrators', async () => {
  const response = await api('/api/tenants/current/settings');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    timezone: 'Europe/Moscow',
    workingDays: [0, 1, 2, 3, 4, 5, 6],
    openTime: '09:00',
    closeTime: '20:00',
    slotStepMinutes: 30,
    simultaneousCapacity: 2
  });
  assert.equal((await api('/api/tenants/current/settings', { token: 'owner-token' })).status, 200);
  assert.equal((await api('/api/tenants/current/settings', { token: 'intake-token' })).status, 403);

  const foreign = await api('/api/tenants/current/settings', { token: 'other-owner-token' });
  assert.equal(foreign.status, 200);
  assert.equal((await foreign.json()).simultaneousCapacity, 1);
});

test('saved schedule changes generated slots and blocks bookings outside working hours', async () => {
  const updated = await api('/api/tenants/current/settings', {
    token: 'owner-token', method: 'PATCH', body: {
      workingDays: [1, 2, 3, 4, 5],
      openTime: '10:00',
      closeTime: '16:00',
      slotStepMinutes: 60,
      simultaneousCapacity: 1
    }
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).slotStepMinutes, 60);

  const weekday = await api('/api/bookings/availability?date=2026-10-21&durationMinutes=35');
  assert.equal(weekday.status, 200);
  assert.deepEqual((await weekday.json()).slots.map((slot) => slot.time), ['10:00', '11:00', '12:00', '13:00', '14:00', '15:00']);

  const weekend = await api('/api/bookings/availability?date=2026-10-24&durationMinutes=35');
  assert.equal(weekend.status, 200);
  const weekendBody = await weekend.json();
  assert.equal(weekendBody.closed, true);
  assert.deepEqual(weekendBody.slots, []);

  const outsideHours = await api('/api/bookings', {
    method: 'POST', headers: { 'idempotency-key': 'outside-center-hours' }, body: {
      customerId: 'cust_alexey', vehicleId: 'veh_mazda', channel: 'call',
      startAt: '2026-10-21T09:00:00+03:00', selections: [{ type: 'service', id: 'service_wash' }]
    }
  });
  assert.equal(outsideHours.status, 409);
  assert.equal((await outsideHours.json()).error.code, 'slot_unavailable');

  const outsideStep = await api('/api/bookings', {
    method: 'POST', headers: { 'idempotency-key': 'outside-slot-step' }, body: {
      customerId: 'cust_alexey', vehicleId: 'veh_mazda', channel: 'call',
      startAt: '2026-10-21T10:30:00+03:00', selections: [{ type: 'service', id: 'service_wash' }]
    }
  });
  assert.equal(outsideStep.status, 409);
  assert.equal((await outsideStep.json()).error.code, 'slot_unavailable');
});

test('invalid schedules do not overwrite the current center settings', async () => {
  const invalid = await api('/api/tenants/current/settings', {
    method: 'PATCH', body: {
      workingDays: [], openTime: '18:00', closeTime: '10:00', slotStepMinutes: 17, simultaneousCapacity: 0
    }
  });
  assert.equal(invalid.status, 422);

  const current = await api('/api/tenants/current/settings');
  assert.equal(current.status, 200);
  const settings = await current.json();
  assert.equal(settings.openTime, '10:00');
  assert.equal(settings.simultaneousCapacity, 1);
});
