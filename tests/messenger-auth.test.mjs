import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDetailFlowServer } from '../server/app.mjs';

function fakeAdapter(provider, botName) {
  return {
    provider,
    title: provider === 'telegram' ? 'Telegram' : 'MAX',
    botName,
    sent: [],
    answers: [],
    handler: null,
    deepLink(payload) { return `https://bots.example/${botName}?start=${payload}`; },
    async start(handler) { this.handler = handler; },
    stop() {},
    async sendMessage(userId, text, buttons) { this.sent.push({ userId, text, buttons }); },
    async answerCallback(callbackId, text) { this.answers.push({ callbackId, text }); },
    lastTo(userId) { return this.sent.filter((message) => message.userId === userId).at(-1); }
  };
}

const telegram = fakeAdapter('telegram', 'detailflow_test_bot');
const max = fakeAdapter('max', 'detailflow_max_bot');
let server;
let baseUrl;

before(async () => {
  server = createDetailFlowServer({ databasePath: ':memory:', seed: true, messengers: [telegram, max] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await new Promise((resolve) => setImmediate(resolve));
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

async function api(path, { token, method = 'GET', body, headers = {}, raw } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body || raw ? { 'content-type': 'application/json' } : {}),
      ...headers
    },
    body: raw ?? (body ? JSON.stringify(body) : undefined)
  });
}

async function invite(memberId, provider) {
  const response = await api(`/api/tenants/current/team/${memberId}/messenger-invites`, {
    token: 'demo-session-token', method: 'POST', body: { provider }
  });
  assert.equal(response.status, 201);
  return response.json();
}

async function startLogin(provider) {
  const response = await api('/api/auth/login-requests', { method: 'POST', body: { provider } });
  assert.equal(response.status, 201);
  const login = await response.json();
  return { ...login, startPayload: new URL(login.deepLink).searchParams.get('start') };
}

const status = async (login, secret = login.pollSecret) => api(`/api/auth/login-requests/${login.id}`, { headers: { 'x-login-secret': secret } });
const openSession = (login, body = {}) => api(`/api/auth/login-requests/${login.id}/session`, {
  method: 'POST', headers: { 'x-login-secret': login.pollSecret }, body
});

test('public provider list shows only bots that started successfully', async () => {
  const response = await api('/api/auth/providers');
  assert.equal(response.status, 200);
  const providers = await response.json();
  assert.deepEqual(providers.items.map((item) => [item.provider, item.botName]), [['telegram', 'detailflow_test_bot'], ['max', 'detailflow_max_bot']]);
  assert.equal(providers.demo, true);
  assert.equal((await api('/api/auth/login-requests', { method: 'POST', body: { provider: 'whatsapp' } })).status, 422);
});

test('owner invite links a Telegram account and the employee signs in after explicit confirmation', async () => {
  const created = await invite('member_demo_owner', 'telegram');
  assert.match(created.code, /^invite_[0-9a-f]{24}$/);
  assert.ok(created.deepLink.endsWith(`start=${created.code}`));
  await telegram.handler({ provider: 'telegram', kind: 'start', userId: '1001', displayName: 'Анна', payload: created.code });
  assert.match(telegram.lastTo('1001').text, /привязан к сотруднику «Анна Смирнова»/);

  const team = await (await api('/api/tenants/current/team', { token: 'demo-session-token' })).json();
  const owner = team.items.find((member) => member.id === 'member_demo_owner');
  assert.deepEqual(owner.messengerLinks.map((link) => [link.provider, link.externalName]), [['telegram', 'Анна']]);

  await telegram.handler({ provider: 'telegram', kind: 'start', userId: '1002', displayName: 'Чужой', payload: created.code });
  assert.match(telegram.lastTo('1002').text, /недействительно/, 'an invite works only once');

  const login = await startLogin('telegram');
  assert.match(login.shortCode, /^[A-Z2-9]{6}$/);
  assert.equal((await (await status(login)).json()).status, 'PENDING');
  assert.equal((await status(login, 'wrong-secret')).status, 404, 'status requires the browser poll secret');

  await telegram.handler({ provider: 'telegram', kind: 'start', userId: '1001', displayName: 'Анна', payload: login.startPayload });
  const prompt = telegram.lastTo('1001');
  assert.match(prompt.text, new RegExp(login.shortCode));
  assert.deepEqual(prompt.buttons[0].map((button) => button.payload), [`login_ok:${login.id}`, `login_no:${login.id}`]);
  assert.equal((await (await status(login)).json()).status, 'AWAITING_CONFIRMATION');

  await telegram.handler({ provider: 'telegram', kind: 'callback', userId: '1002', payload: `login_ok:${login.id}`, callbackId: 'cb-foreign' });
  assert.equal(telegram.answers.at(-1).text, 'Запрос устарел', 'another account cannot confirm someone else\'s login');
  assert.equal((await openSession(login)).status, 409);

  await telegram.handler({ provider: 'telegram', kind: 'callback', userId: '1001', payload: `login_ok:${login.id}`, callbackId: 'cb-1' });
  assert.equal(telegram.answers.at(-1).text, 'Вход подтверждён');
  const confirmed = await (await status(login)).json();
  assert.equal(confirmed.status, 'CONFIRMED');
  assert.deepEqual(confirmed.memberships.map((item) => item.tenant.id), ['tenant_demo']);

  const sessionResponse = await openSession(login);
  assert.equal(sessionResponse.status, 201);
  const session = await sessionResponse.json();
  assert.match(session.token, /^dfs_[0-9a-f]{64}$/);
  assert.equal(session.tenant.id, 'tenant_demo');
  assert.equal((await openSession(login)).status, 409, 'a confirmed login yields exactly one session');

  const me = await (await api('/api/session', { token: session.token })).json();
  assert.equal(me.actor.displayName, 'Анна Смирнова');
  assert.equal(me.actor.memberId, 'member_demo_owner');
  assert.equal(me.actor.authMethod, 'messenger');
  assert.deepEqual(me.actor.roles, ['owner', 'admin']);
  assert.equal(me.tenant.id, 'tenant_demo');
  assert.equal((await api('/api/customers?phone=9131234567', { token: session.token })).status, 200);

  const logout = await api('/api/auth/logout', { token: session.token, method: 'POST', body: {} });
  assert.deepEqual(await logout.json(), { revoked: true });
  assert.equal((await api('/api/session', { token: session.token })).status, 401);
});

test('MAX sign-in works with the short code typed into the bot', async () => {
  const created = await invite('member_demo_master', 'max');
  await max.handler({ provider: 'max', kind: 'text', userId: '7001', displayName: 'Дмитрий', text: created.code });
  assert.match(max.lastTo('7001').text, /«Дмитрий Соколов»/);

  const login = await startLogin('max');
  await max.handler({ provider: 'max', kind: 'text', userId: '7001', displayName: 'Дмитрий', text: login.shortCode.toLowerCase() });
  assert.equal((await (await status(login)).json()).status, 'AWAITING_CONFIRMATION');
  await max.handler({ provider: 'max', kind: 'callback', userId: '7001', payload: `login_ok:${login.id}`, callbackId: 'max-cb' });
  const session = await (await openSession(login)).json();
  const me = await (await api('/api/session', { token: session.token })).json();
  assert.deepEqual(me.actor.roles, ['master']);
  assert.equal(me.capabilities.manageCustomers, false);
  assert.equal((await api('/api/customers/cust_alexey/profile', { token: session.token })).status, 403, 'roles still come from the server');

  // Blocking the employee ends the session immediately.
  assert.equal((await api('/api/tenants/current/team/member_demo_master', {
    token: 'demo-session-token', method: 'PATCH', body: { status: 'blocked' }
  })).status, 200);
  assert.equal((await api('/api/session', { token: session.token })).status, 401);
  assert.equal((await api('/api/tenants/current/team/member_demo_master/messenger-invites', {
    token: 'demo-session-token', method: 'POST', body: { provider: 'max' }
  })).status, 409);
  await api('/api/tenants/current/team/member_demo_master', { token: 'demo-session-token', method: 'PATCH', body: { status: 'active' } });
});

test('unlinked accounts, denied logins and unlinking never produce a usable session', async () => {
  const strangerLogin = await startLogin('telegram');
  await telegram.handler({ provider: 'telegram', kind: 'start', userId: '5555', displayName: 'Незнакомец', payload: strangerLogin.startPayload });
  assert.match(telegram.lastTo('5555').text, /не привязан/);
  assert.equal((await (await status(strangerLogin)).json()).status, 'PENDING');

  const denied = await startLogin('telegram');
  await telegram.handler({ provider: 'telegram', kind: 'start', userId: '1001', payload: denied.startPayload });
  await telegram.handler({ provider: 'telegram', kind: 'callback', userId: '1001', payload: `login_no:${denied.id}`, callbackId: 'cb-no' });
  assert.equal((await (await status(denied)).json()).status, 'DENIED');
  assert.equal((await openSession(denied)).status, 409);

  const login = await startLogin('telegram');
  await telegram.handler({ provider: 'telegram', kind: 'start', userId: '1001', payload: login.startPayload });
  await telegram.handler({ provider: 'telegram', kind: 'callback', userId: '1001', payload: `login_ok:${login.id}`, callbackId: 'cb-ok' });
  const session = await (await openSession(login)).json();
  const team = await (await api('/api/tenants/current/team', { token: 'demo-session-token' })).json();
  const link = team.items.find((member) => member.id === 'member_demo_owner').messengerLinks[0];
  assert.equal((await api(`/api/tenants/current/team/member_demo_owner/messenger-links/${link.id}`, {
    token: 'demo-session-token', method: 'DELETE'
  })).status, 200);
  assert.equal((await api('/api/session', { token: session.token })).status, 401, 'unlinking revokes sessions from that messenger');
});

test('team invites are owner-only and tenant scoped', async () => {
  assert.equal((await api('/api/tenants/current/team/member_demo_owner/messenger-invites', {
    token: 'other-session-token', method: 'POST', body: { provider: 'telegram' }
  })).status, 403);
  assert.equal((await api('/api/tenants/current/team/member_other_owner/messenger-invites', {
    token: 'demo-session-token', method: 'POST', body: { provider: 'telegram' }
  })).status, 404);
  assert.equal((await api('/api/tenants/current/team/member_demo_owner/messenger-invites', {
    token: 'demo-session-token', method: 'POST', body: { provider: 'sms' }
  })).status, 422);
  assert.equal((await api('/api/auth/login-requests', { method: 'POST', raw: '{"provider":' })).status, 400, 'malformed JSON is a client error');
  assert.equal((await api('/api/customers', { token: 'demo-session-token', method: 'POST', raw: 'not json' })).status, 400);
});

test('public login creation is rate limited per client', async () => {
  const responses = [];
  for (let index = 0; index < 22; index += 1) {
    responses.push((await api('/api/auth/login-requests', { method: 'POST', body: { provider: 'telegram' } })).status);
  }
  assert.ok(responses.includes(429));
});
