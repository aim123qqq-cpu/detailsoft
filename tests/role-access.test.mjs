import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDetailFlowServer } from '../server/app.mjs';

let server;
let baseUrl;
let keyCounter = 0;

before(async () => {
  server = createDetailFlowServer({
    databasePath: ':memory:',
    seed: true,
    authTokens: new Map([
      ['admin-token', { tenantId: 'tenant_demo', displayName: 'Анна', roles: ['owner', 'admin'] }],
      ['intake-token', { tenantId: 'tenant_demo', displayName: 'Ирина Лебедева', roles: ['intake'] }],
      ['master-token', { tenantId: 'tenant_demo', displayName: 'Дмитрий Соколов', roles: ['master'], memberId: 'member_demo_master' }],
      ['other-token', { tenantId: 'tenant_other', displayName: 'Олег', roles: ['owner', 'admin'] }]
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
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
}

async function approvedOrder() {
  const booking = await (await api('/api/bookings', {
    method: 'POST', headers: { 'idempotency-key': `roles-${keyCounter += 1}` },
    body: { customerId: 'cust_alexey', vehicleId: 'veh_mazda', channel: 'call', startAt: `2026-12-0${keyCounter}T10:00:00+03:00`, selections: [{ type: 'service', id: 'service_wash' }] }
  })).json();
  const order = await (await api('/api/orders', { method: 'POST', body: { bookingId: booking.id } })).json();
  await api(`/api/orders/${order.id}/intake`, { method: 'PUT', body: { conditionSummary: 'Принят', findings: [], recommendations: [] } });
  const estimate = await (await api(`/api/orders/${order.id}/estimates`, { method: 'POST', body: { lines: [
    { sourceType: 'service', sourceId: 'service_wash', name: 'Бережная мойка', amountMinor: 140000, durationMinutes: 35 }
  ] } })).json();
  await api(`/api/orders/${order.id}/estimate-approvals`, { method: 'POST', body: {
    estimateVersionId: estimate.id, decision: 'APPROVED', method: 'in_person', source: 'manager_mobile', responsible: 'Анна'
  } });
  return { booking, order };
}

test('customer and lead data is not readable without the matching role', async () => {
  for (const token of ['intake-token', 'master-token']) {
    for (const path of ['/api/customers?phone=9131234567', '/api/customers/cust_alexey/vehicles', '/api/vehicles?plate=А123', '/api/vehicle-catalog/variants?q=Mazda', '/api/leads']) {
      assert.equal((await api(path, { token })).status, 403, `${token} ${path}`);
    }
  }
  assert.equal((await api('/api/customers?phone=9131234567')).status, 200);
  assert.equal((await api('/api/leads')).status, 200);
});

test('bookings are visible to front desk and intake; pricing tools stay with booking managers', async () => {
  assert.equal((await api('/api/bookings', { token: 'intake-token' })).status, 200);
  assert.equal((await api('/api/bookings', { token: 'master-token' })).status, 403);
  assert.equal((await api('/api/bookings/availability?date=2026-12-10&durationMinutes=60', { token: 'intake-token' })).status, 403);
  assert.equal((await api('/api/bookings/quote-preview', {
    token: 'intake-token', method: 'POST', body: { vehicleId: 'veh_mazda', selections: [{ type: 'service', id: 'service_wash' }] }
  })).status, 403);
  assert.equal((await api('/api/tenants/current/services?vehicleId=veh_mazda', { token: 'master-token' })).status, 403);
});

test('every role can open orders and the booking behind them (no phone numbers there)', async () => {
  const { booking, order } = await approvedOrder();
  for (const token of ['intake-token', 'master-token']) {
    assert.equal((await api('/api/orders', { token })).status, 200);
    assert.equal((await api(`/api/orders/${order.id}`, { token })).status, 200);
    const opened = await api(`/api/bookings/${booking.id}`, { token });
    assert.equal(opened.status, 200);
    assert.doesNotMatch(JSON.stringify(await opened.json()), /\+7 9/);
  }
});

test('masters come from the team with their real workload, and assignment links the member', async () => {
  const masters = await (await api('/api/tenants/current/masters')).json();
  assert.deepEqual(masters.items.map((item) => [item.id, item.displayName, item.activeOrders]), [['member_demo_master', 'Дмитрий Соколов', 0]]);
  assert.equal((await api('/api/tenants/current/masters', { token: 'master-token' })).status, 403);
  assert.deepEqual((await (await api('/api/tenants/current/masters', { token: 'other-token' })).json()).items, []);

  const { order } = await approvedOrder();
  const notMaster = await api(`/api/orders/${order.id}/assignment`, { method: 'PUT', body: { memberId: 'member_demo_owner' } });
  assert.equal(notMaster.status, 422);
  assert.equal((await notMaster.json()).error.code, 'not_a_master');
  assert.equal((await api(`/api/orders/${order.id}/assignment`, { method: 'PUT', body: { memberId: 'member_other_owner' } })).status, 422);

  const assigned = await api(`/api/orders/${order.id}/assignment`, { method: 'PUT', body: { memberId: 'member_demo_master' } });
  assert.equal(assigned.status, 200);
  const assignment = (await assigned.json()).assignment;
  assert.equal(assignment.masterName, 'Дмитрий Соколов');
  assert.equal(assignment.memberId, 'member_demo_master');

  const listed = (await (await api('/api/orders', { token: 'master-token' })).json()).items.find((item) => item.id === order.id);
  assert.equal(listed.masterMemberId, 'member_demo_master');
  assert.equal((await (await api('/api/tenants/current/masters')).json()).items[0].activeOrders, 1);
});

test('a blocked master cannot be assigned; the legacy name-only assignment still works', async () => {
  await api('/api/tenants/current/team/member_demo_master', { method: 'PATCH', body: { status: 'blocked' } });
  const { order } = await approvedOrder();
  assert.equal((await api(`/api/orders/${order.id}/assignment`, { method: 'PUT', body: { memberId: 'member_demo_master' } })).status, 422);
  assert.deepEqual((await (await api('/api/tenants/current/masters')).json()).items, []);
  await api('/api/tenants/current/team/member_demo_master', { method: 'PATCH', body: { status: 'active' } });

  const legacy = await api(`/api/orders/${order.id}/assignment`, { method: 'PUT', body: { masterName: 'Приглашённый мастер' } });
  assert.equal(legacy.status, 200);
  const assignment = (await legacy.json()).assignment;
  assert.equal(assignment.masterName, 'Приглашённый мастер');
  assert.equal(assignment.memberId, null);
});
