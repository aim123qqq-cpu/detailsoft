import test from 'node:test';
import assert from 'node:assert/strict';
import { createDetailFlowServer } from '../server/app.mjs';

async function startServer() {
  const server = createDetailFlowServer({ databasePath: ':memory:', seed: true, authTokens: new Map([
    ['demo-session-token', { tenantId: 'tenant_demo', displayName: 'Анна', roles: ['owner', 'admin', 'intake', 'master'] }],
    ['other-session-token', { tenantId: 'tenant_other', displayName: 'Администратор', roles: ['admin', 'intake', 'master'] }],
    ['other-owner-token', { tenantId: 'tenant_other', displayName: 'Владелец другого центра', roles: ['owner'] }]
  ]) });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, token = 'demo-session-token' } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: response.status, body: await response.json() };
  };
  return { server, call };
}

test('a custom role grants exactly its checked permissions to the members who hold it', async () => {
  const { server, call } = await startServer();
  try {
    const catalog = await call('/api/tenants/current/roles');
    assert.equal(catalog.status, 200);
    assert.deepEqual(catalog.body.items.map((role) => role.key), ['owner', 'admin', 'intake', 'master']);
    assert.ok(!catalog.body.permissions.some((permission) => permission.key === 'manageTeam'), 'team management is the owner\'s alone');

    const senior = await call('/api/tenants/current/roles', { method: 'POST', body: {
      name: 'Старший мастер', permissions: ['acceptAssignments', 'performWork', 'assignMasters']
    } });
    assert.equal(senior.status, 201);
    assert.match(senior.body.key, /^role_[0-9a-f-]{36}$/);
    assert.deepEqual(senior.body.permissions, ['assignMasters', 'performWork', 'acceptAssignments'], 'stored in catalog order');

    const created = await call('/api/tenants/current/team', { method: 'POST', body: { displayName: 'Олег Ким', roles: [senior.body.key] } });
    assert.equal(created.status, 201);
    const session = await call('/api/session', { token: created.body.accessToken });
    assert.deepEqual(session.body.actor.roleNames, ['Старший мастер']);
    const granted = Object.entries(session.body.capabilities).filter(([, value]) => value).map(([key]) => key).sort();
    assert.deepEqual(granted, ['acceptAssignments', 'assignMasters', 'performWork']);

    assert.equal((await call('/api/bookings', { token: created.body.accessToken })).status, 403);
    assert.equal((await call('/api/tenants/current/masters', { token: created.body.accessToken })).status, 200);
    const masters = (await call('/api/tenants/current/masters')).body.items.map((master) => master.displayName);
    assert.ok(masters.includes('Олег Ким'), 'acceptAssignments puts the member on the masters list');
    assert.ok(!masters.includes('Анна Смирнова'), 'the owner is not an executor unless a role says so');
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test('the owner edits system role permissions; the change applies at once and is audited', async () => {
  const { server, call } = await startServer();
  try {
    const intake = await call('/api/tenants/current/team', { method: 'POST', body: { displayName: 'Ирина Лебедева', roles: ['intake'] } });
    const token = intake.body.accessToken;
    assert.equal((await call('/api/session', { token })).body.capabilities.manageBookings, false);

    const updated = await call('/api/tenants/current/roles/intake', { method: 'PATCH', body: { permissions: ['manageIntake', 'manageBookings'] } });
    assert.equal(updated.status, 200);
    assert.deepEqual(updated.body.permissions, ['manageBookings', 'manageIntake']);
    assert.equal((await call('/api/session', { token })).body.capabilities.manageBookings, true);

    const events = await call('/api/tenants/current/roles/intake/events');
    assert.equal(events.body.items[0].eventType, 'ROLE_UPDATED');
    assert.equal(events.body.items[0].actorName, 'Анна');
    assert.deepEqual(events.body.items[0].details.permissions, { from: ['manageIntake'], to: ['manageBookings', 'manageIntake'] });

    const unchanged = await call('/api/tenants/current/roles/intake', { method: 'PATCH', body: { permissions: ['manageBookings', 'manageIntake'] } });
    assert.equal(unchanged.status, 200);
    assert.equal((await call('/api/tenants/current/roles/intake/events')).body.items.length, 1, 'no event without a change');
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test('locked, duplicate and invalid role changes are refused', async () => {
  const { server, call } = await startServer();
  try {
    const owner = await call('/api/tenants/current/roles/owner', { method: 'PATCH', body: { permissions: ['viewAnalytics'] } });
    assert.equal(owner.status, 409);
    assert.equal(owner.body.error.code, 'role_locked');
    assert.equal((await call('/api/tenants/current/roles/master', { method: 'PATCH', body: { name: 'Исполнитель' } })).body.error.code, 'role_name_locked');
    assert.equal((await call('/api/tenants/current/roles/master/archive', { method: 'POST' })).body.error.code, 'role_locked');

    const duplicate = await call('/api/tenants/current/roles', { method: 'POST', body: { name: '  мастер ', permissions: ['performWork'] } });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'role_name_taken');
    assert.equal((await call('/api/tenants/current/roles', { method: 'POST', body: { name: 'Кассир', permissions: ['manageTeam'] } })).status, 422, 'team rights cannot be granted');
    assert.equal((await call('/api/tenants/current/roles', { method: 'POST', body: { name: 'Пустая', permissions: [] } })).status, 422);
    assert.equal((await call('/api/tenants/current/roles', { method: 'POST', body: { name: 'Х', permissions: ['performWork'] } })).status, 422);
    assert.equal((await call('/api/tenants/current/roles/role_missing', { method: 'PATCH', body: { name: 'Новая' } })).status, 404);
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test('a role in use cannot be archived; an archived role is not assignable and can be restored', async () => {
  const { server, call } = await startServer();
  try {
    const washer = (await call('/api/tenants/current/roles', { method: 'POST', body: { name: 'Мойщик', permissions: ['performWork', 'acceptAssignments'] } })).body;
    const member = (await call('/api/tenants/current/team', { method: 'POST', body: { displayName: 'Пётр Белов', roles: [washer.key] } })).body.member;

    const inUse = await call(`/api/tenants/current/roles/${washer.key}/archive`, { method: 'POST' });
    assert.equal(inUse.status, 409);
    assert.equal(inUse.body.error.code, 'role_in_use');

    await call(`/api/tenants/current/team/${member.id}`, { method: 'PATCH', body: { roles: ['master'] } });
    const archived = await call(`/api/tenants/current/roles/${washer.key}/archive`, { method: 'POST' });
    assert.equal(archived.status, 200);
    assert.equal(archived.body.archived, true);
    assert.ok(!(await call('/api/tenants/current/roles')).body.items.some((role) => role.key === washer.key));
    assert.ok((await call('/api/tenants/current/roles?includeArchived=true')).body.items.some((role) => role.key === washer.key));
    assert.equal((await call('/api/tenants/current/team', { method: 'POST', body: { displayName: 'Новый Мойщик', roles: [washer.key] } })).status, 422);

    const restored = await call(`/api/tenants/current/roles/${washer.key}/restore`, { method: 'POST' });
    assert.equal(restored.body.archived, false);
    assert.equal((await call('/api/tenants/current/team', { method: 'POST', body: { displayName: 'Новый Мойщик', roles: [washer.key] } })).status, 201);
    const history = (await call(`/api/tenants/current/roles/${washer.key}/events`)).body.items.map((event) => event.eventType);
    assert.deepEqual(history, ['ROLE_RESTORED', 'ROLE_ARCHIVED', 'ROLE_CREATED']);
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test('roles are tenant scoped and managed by the owner only', async () => {
  const { server, call } = await startServer();
  try {
    const role = (await call('/api/tenants/current/roles', { method: 'POST', body: { name: 'Детейлер', permissions: ['performWork'] } })).body;
    // other-session-token: an admin of another center, without the owner role.
    assert.equal((await call('/api/tenants/current/roles', { token: 'other-session-token' })).status, 403);
    // The owner of another center sees only their own roles and cannot touch or assign this one.
    const foreign = (await call('/api/tenants/current/roles', { token: 'other-owner-token' })).body.items.map((item) => item.key);
    assert.deepEqual(foreign, ['owner', 'admin', 'intake', 'master']);
    assert.equal((await call(`/api/tenants/current/roles/${role.key}`, { method: 'PATCH', token: 'other-owner-token', body: { name: 'Захват' } })).status, 404);
    assert.equal((await call(`/api/tenants/current/roles/${role.key}/archive`, { method: 'POST', token: 'other-owner-token' })).status, 404);
    assert.equal((await call('/api/tenants/current/team', { method: 'POST', token: 'other-owner-token', body: { displayName: 'Чужой', roles: [role.key] } })).status, 422);
    await call('/api/tenants/current/roles/intake', { method: 'PATCH', token: 'other-owner-token', body: { permissions: ['manageIntake', 'viewAnalytics'] } });
    assert.deepEqual((await call('/api/tenants/current/roles')).body.items.find((item) => item.key === 'intake').permissions, ['manageIntake'], 'system role edits stay in their center');

    const intake = (await call('/api/tenants/current/team', { method: 'POST', body: { displayName: 'Ирина Лебедева', roles: ['intake'] } })).body;
    assert.equal((await call('/api/tenants/current/roles', { token: intake.accessToken })).status, 403);
    assert.equal((await call('/api/tenants/current/roles/intake', { method: 'PATCH', token: intake.accessToken, body: { permissions: ['manageBookings'] } })).status, 403);
  } finally {
    await new Promise((done) => server.close(done));
  }
});
