import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDetailFlowServer } from '../server/app.mjs';
import { CENTERS_PER_ACCOUNT } from '../server/auth-repository.mjs';

// A production server: no demo center, no demo access. Centers are created by their owners.
function fakeAdapter(provider, botName) {
  return {
    provider, title: provider === 'telegram' ? 'Telegram' : 'MAX', botName, sent: [], answers: [], handler: null,
    deepLink(payload) { return `https://bots.example/${botName}?start=${payload}`; },
    async start(handler) { this.handler = handler; },
    stop() {},
    async sendMessage(userId, text, buttons) { this.sent.push({ userId, text, buttons }); },
    async answerCallback(callbackId, text) { this.answers.push({ callbackId, text }); },
    lastTo(userId) { return this.sent.filter((message) => message.userId === userId).at(-1); }
  };
}

const telegram = fakeAdapter('telegram', 'detailflow_test_bot');
let server;
let baseUrl;

before(async () => {
  server = createDetailFlowServer({ databasePath: ':memory:', seed: false, authTokens: new Map(), messengers: [telegram] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await new Promise((resolve) => setImmediate(resolve));
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

const api = (path, { token, method = 'GET', body, headers = {} } = {}) => fetch(`${baseUrl}${path}`, {
  method,
  headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
  body: body ? JSON.stringify(body) : undefined
});

async function request(purpose) {
  const response = await api('/api/auth/login-requests', { method: 'POST', body: { provider: 'telegram', ...(purpose ? { purpose } : {}) } });
  assert.equal(response.status, 201);
  const login = await response.json();
  return { ...login, startPayload: new URL(login.deepLink).searchParams.get('start') };
}
async function confirm(login, userId, displayName = 'Никита') {
  await telegram.handler({ provider: 'telegram', kind: 'start', userId, displayName, payload: login.startPayload });
  await telegram.handler({ provider: 'telegram', kind: 'callback', userId, payload: `login_ok:${login.id}`, callbackId: `cb-${login.id}` });
}
const createCenter = (login, body) => api(`/api/auth/login-requests/${login.id}/center`, { method: 'POST', headers: { 'x-login-secret': login.pollSecret }, body });

test('a new person creates a center in the messenger and becomes its owner', async () => {
  const signup = await request('signup');
  assert.equal(signup.purpose, 'signup');
  await telegram.handler({ provider: 'telegram', kind: 'start', userId: '7001', displayName: 'Никита', payload: signup.startPayload });
  const prompt = telegram.lastTo('7001');
  assert.match(prompt.text, /Создание центра/);
  assert.match(prompt.text, new RegExp(signup.shortCode));

  assert.equal((await createCenter(signup, { centerName: 'Детейлинг Север', ownerName: 'Никита Шиганов' })).status, 409, 'not before confirming in the messenger');
  await telegram.handler({ provider: 'telegram', kind: 'callback', userId: '7001', payload: `login_ok:${signup.id}`, callbackId: 'cb-1' });
  const status = await (await api(`/api/auth/login-requests/${signup.id}`, { headers: { 'x-login-secret': signup.pollSecret } })).json();
  assert.deepEqual([status.status, status.purpose, status.memberships.length], ['CONFIRMED', 'signup', 0]);

  assert.equal((await createCenter(signup, { centerName: 'Д', ownerName: 'Никита Шиганов' })).status, 422);
  assert.equal((await api(`/api/auth/login-requests/${signup.id}/center`, { method: 'POST', headers: { 'x-login-secret': 'wrong' }, body: { centerName: 'Детейлинг Север', ownerName: 'Никита' } })).status, 404);
  const created = await createCenter(signup, { centerName: '  Детейлинг   Север ', ownerName: 'Никита Шиганов' });
  assert.equal(created.status, 201);
  const session = await created.json();
  assert.equal(session.tenant.name, 'Детейлинг Север');
  assert.equal((await createCenter(signup, { centerName: 'Ещё один', ownerName: 'Никита' })).status, 409, 'a request makes one center');

  const context = await (await api('/api/session', { token: session.token })).json();
  assert.equal(context.tenant.name, 'Детейлинг Север');
  assert.equal(context.actor.displayName, 'Никита Шиганов');
  assert.ok(context.actor.roles.includes('owner'));
  assert.equal(context.capabilities.manageTeam, true);
  const team = await (await api('/api/tenants/current/team', { token: session.token })).json();
  assert.deepEqual(team.items.map((member) => [member.displayName, member.messengerLinks.map((link) => [link.provider, link.externalName])]),
    [['Никита Шиганов', [['telegram', 'Никита']]]]);

  // The new center works at once: schedule, catalog, classes, free time, lists.
  for (const path of ['/api/tenants/current/settings', '/api/tenants/current/catalog', '/api/tenants/current/vehicle-classes', '/api/orders?limit=50',
    '/api/bookings?view=upcoming&limit=50', `/api/bookings/availability?date=${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}&durationMinutes=60`, '/api/analytics/overview?from=2026-10-01&to=2026-10-30']) {
    const response = await api(path, { token: session.token });
    assert.equal(response.status, 200, path);
  }

  // Later the owner simply signs in with the same messenger account.
  const login = await request();
  await confirm(login, '7001');
  const opened = await api(`/api/auth/login-requests/${login.id}/session`, { method: 'POST', headers: { 'x-login-secret': login.pollSecret }, body: {} });
  assert.equal(opened.status, 201);
  assert.equal((await opened.json()).tenant.name, 'Детейлинг Север');
});

test('signing in still needs a center; a sign-in request cannot create one', async () => {
  const login = await request();
  await telegram.handler({ provider: 'telegram', kind: 'start', userId: '7002', displayName: 'Гость', payload: login.startPayload });
  assert.match(telegram.lastTo('7002').text, /не привязан.*создайте свой центр/s);
  assert.equal((await createCenter(login, { centerName: 'Чужой центр', ownerName: 'Гость' })).status, 409);
});

test('one messenger account creates a limited number of centers', async () => {
  for (let index = 1; index <= CENTERS_PER_ACCOUNT; index += 1) {
    const signup = await request('signup');
    await confirm(signup, '7003');
    assert.equal((await createCenter(signup, { centerName: `Центр ${index}`, ownerName: 'Олег' })).status, 201);
  }
  const extra = await request('signup');
  await confirm(extra, '7003');
  const refused = await createCenter(extra, { centerName: 'Ещё центр', ownerName: 'Олег' });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error.code, 'too_many_centers');

  // With several centers the owner chooses one at sign-in.
  const login = await request();
  await confirm(login, '7003');
  const choose = await api(`/api/auth/login-requests/${login.id}/session`, { method: 'POST', headers: { 'x-login-secret': login.pollSecret }, body: {} });
  assert.equal(choose.status, 409);
  assert.equal((await choose.json()).error.details.memberships.length, CENTERS_PER_ACCOUNT);
});

test('a fresh center works without price classes: a car typed in by hand is booked at the base price', async () => {
  const signup = await request('signup');
  await confirm(signup, '7004');
  const { token } = await (await createCenter(signup, { centerName: 'Мойка у дома', ownerName: 'Ирина' })).json();
  const call = async (path, method = 'GET', body, headers = {}) => {
    const response = await api(path, { token, method, body, headers });
    const payload = await response.json();
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(payload)}`);
    return payload;
  };
  assert.deepEqual((await call('/api/tenants/current/vehicle-classes')).items, [], 'no price classes yet');
  assert.deepEqual(await call('/api/tenants/current/setup'), { services: 0, members: 1, bookings: 0 }, 'first steps: nothing done but the owner');
  const section = await call('/api/tenants/current/catalog/sections', 'POST', { name: 'Мойка' });
  const service = await call('/api/tenants/current/catalog/simple-services', 'POST', {
    sectionId: section.id, name: 'Мойка кузова', description: '', pricingMode: 'fixed', basePrice: { amountMinor: 120000, durationMinutes: 30 }, classPrices: []
  });
  const customer = await call('/api/customers', 'POST', { name: 'Пётр', phone: '+7 900 111-22-33' });
  const { vehicle } = await call('/api/vehicles', 'POST', { customerId: customer.id, manual: { make: 'Lada', model: 'Vesta', bodyType: 'sedan' }, plateDisplay: 'М123ММ 77', color: 'серый' });
  const selections = [{ type: 'service', id: service.id }];
  const quote = await call('/api/bookings/quote-preview', 'POST', { vehicleId: vehicle.id, selections });
  assert.equal(quote.totalAmountMinor, 120000);
  const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const slot = (await call(`/api/bookings/availability?date=${date}&durationMinutes=30`)).slots.find((item) => item.available);
  const booking = await call('/api/bookings', 'POST', { customerId: customer.id, vehicleId: vehicle.id, channel: 'call', startAt: slot.startAt, selections }, { 'idempotency-key': 'fresh-center-booking' });
  assert.equal(booking.preliminaryAmountMinor, 120000);
  assert.deepEqual(await call('/api/tenants/current/setup'), { services: 1, members: 1, bookings: 1 });
});
