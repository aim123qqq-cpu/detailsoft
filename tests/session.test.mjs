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
      ['admin-token', { tenantId: 'tenant_demo', displayName: 'Анна', roles: ['admin', 'intake', 'master'] }],
      ['intake-token', { tenantId: 'tenant_demo', displayName: 'Ирина', roles: ['intake'] }],
      ['other-token', { tenantId: 'tenant_other', displayName: 'Олег', roles: ['owner'] }]
    ])
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

async function getSession(token) {
  return fetch(`${baseUrl}/api/session`, {
    headers: token ? { authorization: `Bearer ${token}` } : {}
  });
}

test('session describes the authenticated employee, tenant and effective capabilities', async () => {
  const response = await getSession('admin-token');
  assert.equal(response.status, 200);
  const session = await response.json();

  assert.deepEqual(session.actor, {
    displayName: 'Анна',
    roles: ['admin', 'intake', 'master'],
    roleNames: ['Администратор', 'Приёмщик', 'Мастер'],
    memberId: null,
    authMethod: 'demo'
  });
  assert.deepEqual(session.tenant, {
    id: 'tenant_demo',
    name: 'DetailFlow Studio',
    timezone: 'Europe/Moscow'
  });
  assert.deepEqual(session.preferences, { locale: 'ru-RU', currency: 'RUB' });
  assert.deepEqual(session.features, { qualityControl: false });
  assert.deepEqual(session.capabilities, {
    manageCustomers: true,
    manageBookings: true,
    manageIntake: true,
    approveEstimates: true,
    assignMasters: true,
    performWork: true,
    acceptAssignments: true,
    performQualityControl: false,
    closeOrders: true,
    manageCatalog: true,
    manageSettings: true,
    manageTeam: false,
    viewAnalytics: true
  });
});

test('session capabilities are derived on the backend and remain tenant scoped', async () => {
  const intakeResponse = await getSession('intake-token');
  assert.equal(intakeResponse.status, 200);
  const intake = await intakeResponse.json();
  assert.equal(intake.actor.displayName, 'Ирина');
  assert.equal(intake.capabilities.manageIntake, true);
  assert.equal(intake.capabilities.approveEstimates, false);
  assert.equal(intake.capabilities.assignMasters, false);
  assert.equal(intake.capabilities.performWork, false);
  assert.equal(intake.capabilities.closeOrders, false);
  assert.equal(intake.capabilities.manageCatalog, false);
  assert.equal(intake.capabilities.manageSettings, false);
  assert.equal(intake.capabilities.manageTeam, false);
  assert.equal(intake.capabilities.viewAnalytics, false);

  const otherResponse = await getSession('other-token');
  assert.equal(otherResponse.status, 200);
  const other = await otherResponse.json();
  assert.equal(other.tenant.id, 'tenant_other');
  assert.equal(other.tenant.name, 'Другой центр');
  assert.equal(other.capabilities.manageCatalog, true);
  assert.equal(other.capabilities.manageSettings, true);
  assert.equal(other.capabilities.manageTeam, true);
  assert.equal(other.capabilities.viewAnalytics, true);

  assert.equal((await getSession('unknown-token')).status, 401);
  assert.equal((await getSession()).status, 401);
});

test('restricted roles cannot bypass capabilities through mutation endpoints', async () => {
  const createCustomer = await fetch(`${baseUrl}/api/customers`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer intake-token',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ name: 'Новый клиент', phone: '+7 999 000-00-00' })
  });
  assert.equal(createCustomer.status, 403);
  assert.equal((await createCustomer.json()).error.code, 'forbidden');

  const createBooking = await fetch(`${baseUrl}/api/bookings`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer intake-token',
      'content-type': 'application/json',
      'idempotency-key': 'forbidden-booking'
    },
    body: JSON.stringify({})
  });
  assert.equal(createBooking.status, 403);
  assert.equal((await createBooking.json()).error.code, 'forbidden');
});
