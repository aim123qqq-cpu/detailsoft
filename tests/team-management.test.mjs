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
      ['owner-token', { tenantId: 'tenant_demo', displayName: 'Анна', roles: ['owner'] }],
      ['admin-token', { tenantId: 'tenant_demo', displayName: 'Администратор', roles: ['admin'] }],
      ['other-owner-token', { tenantId: 'tenant_other', displayName: 'Олег', roles: ['owner'] }]
    ])
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

async function api(path, { token = 'owner-token', method = 'GET', body } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

test('owner manages only the current tenant team while an administrator cannot', async () => {
  const response = await api('/api/tenants/current/team');
  assert.equal(response.status, 200);
  const team = await response.json();
  assert.ok(team.items.length >= 2);
  assert.ok(team.items.every((member) => !member.displayName.includes('Олег')));
  assert.equal((await api('/api/tenants/current/team', { token: 'admin-token' })).status, 403);
  const otherTeam = await (await api('/api/tenants/current/team', { token: 'other-owner-token' })).json();
  assert.deepEqual(otherTeam.items.map((member) => member.displayName), ['Олег Петров']);
  assert.equal((await api('/api/tenants/current/team/member_other_owner', {
    method: 'PATCH', body: { roles: ['admin'] }
  })).status, 404);
});

test('new member receives a one-time token whose roles are updated dynamically', async () => {
  const createdResponse = await api('/api/tenants/current/team', {
    method: 'POST', body: { displayName: 'Мария Орлова', roles: ['intake'] }
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.member.displayName, 'Мария Орлова');
  assert.deepEqual(created.member.roles, ['intake']);
  assert.match(created.accessToken, /^df_[a-f0-9]{48}$/);

  const initialSession = await api('/api/session', { token: created.accessToken });
  assert.equal(initialSession.status, 200);
  assert.deepEqual((await initialSession.json()).actor.roles, ['intake']);

  const updatedResponse = await api(`/api/tenants/current/team/${created.member.id}`, {
    method: 'PATCH', body: { roles: ['admin', 'master'] }
  });
  assert.equal(updatedResponse.status, 200);
  assert.deepEqual((await updatedResponse.json()).roles, ['admin', 'master']);
  assert.deepEqual((await (await api('/api/session', { token: created.accessToken })).json()).actor.roles, ['admin', 'master']);

  const blocked = await api(`/api/tenants/current/team/${created.member.id}`, {
    method: 'PATCH', body: { status: 'blocked' }
  });
  assert.equal(blocked.status, 200);
  assert.equal((await blocked.json()).status, 'blocked');
  assert.equal((await api('/api/session', { token: created.accessToken })).status, 401);
});

test('invalid roles and removing the last active owner are rejected without changing state', async () => {
  const team = await (await api('/api/tenants/current/team')).json();
  const owner = team.items.find((member) => member.roles.includes('owner'));
  assert.ok(owner);

  const lastOwner = await api(`/api/tenants/current/team/${owner.id}`, {
    method: 'PATCH', body: { roles: ['admin'] }
  });
  assert.equal(lastOwner.status, 409);
  assert.equal((await lastOwner.json()).error.code, 'last_owner_required');

  const invalid = await api('/api/tenants/current/team', {
    method: 'POST', body: { displayName: 'Неверная роль', roles: ['qc'] }
  });
  assert.equal(invalid.status, 422);
  const unchanged = await (await api('/api/tenants/current/team')).json();
  assert.deepEqual(unchanged.items.find((member) => member.id === owner.id).roles, owner.roles);
});
