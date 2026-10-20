import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDetailFlowServer } from '../server/app.mjs';
import { openDatabase } from '../server/db.mjs';
import { AuthRepository } from '../server/auth-repository.mjs';

let server;
let baseUrl;

before(async () => {
  server = createDetailFlowServer({
    databasePath: ':memory:',
    seed: true,
    authTokens: new Map([['owner-token', { tenantId: 'tenant_demo', displayName: 'Анна', roles: ['owner'] }]])
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

function api(path, { token = 'owner-token', method = 'GET', body } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
}

test('an employee deletes their own account: access ends, the name and messenger link are erased', async () => {
  const created = await (await api('/api/tenants/current/team', { method: 'POST', body: { displayName: 'Мария Орлова', roles: ['intake'] } })).json();
  const token = created.accessToken;
  const session = await (await api('/api/session', { token })).json();
  assert.equal(session.actor.memberId, created.member.id, 'an access-code session knows its member');

  const deleted = await api('/api/me', { token, method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { deleted: true });

  assert.equal((await api('/api/session', { token })).status, 401, 'the access code no longer works');
  const team = await (await api('/api/tenants/current/team')).json();
  const member = team.items.find((item) => item.id === created.member.id);
  assert.equal(member.displayName, 'Удалённый сотрудник');
  assert.equal(member.status, 'blocked');
  assert.deepEqual(member.roles, []);
  assert.deepEqual(member.messengerLinks, []);
  assert.ok(!JSON.stringify(team).includes('Мария Орлова'));
});

test('a demo session has no account to delete', async () => {
  const response = await api('/api/me', { method: 'DELETE' });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'no_account');
});

test('the only owner cannot delete the account; another owner can', () => {
  const db = openDatabase(':memory:', { seed: true });
  const auth = new AuthRepository(db);
  const link = (tenantId, memberId, externalId) => db.prepare(`INSERT INTO member_messenger_links (id, tenant_id, member_id, provider, external_user_id, external_name)
    VALUES (?, ?, ?, 'telegram', ?, 'Тест')`).run(`link_${memberId}`, tenantId, memberId, externalId);
  link('tenant_other', 'member_other_owner', '777');
  db.prepare(`INSERT INTO auth_sessions (id, tenant_id, member_id, token_hash, provider, expires_at) VALUES ('s1', 'tenant_other', 'member_other_owner', 'h1', 'telegram', '2999-01-01 00:00:00')`).run();

  assert.deepEqual(auth.deleteOwnAccount('tenant_other', 'member_other_owner'), { kind: 'last_owner' });
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM member_messenger_links WHERE member_id = 'member_other_owner'`).get().n, 1, 'nothing changes when refused');

  db.prepare(`INSERT INTO tenant_members (id, tenant_id, display_name, roles_json, status) VALUES ('member_other_owner_2', 'tenant_other', 'Ирина', '["owner"]', 'active')`).run();
  assert.deepEqual(auth.deleteOwnAccount('tenant_other', 'member_other_owner'), { kind: 'deleted' });
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM member_messenger_links WHERE member_id = 'member_other_owner'`).get().n, 0);
  assert.ok(db.prepare(`SELECT revoked_at FROM auth_sessions WHERE id = 's1'`).get().revoked_at, 'open sessions are revoked');
  assert.deepEqual(auth.deleteOwnAccount('tenant_other', 'member_missing'), { kind: 'not_found' });
});
