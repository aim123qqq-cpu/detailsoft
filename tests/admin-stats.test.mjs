import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDetailFlowServer } from '../server/app.mjs';
import { openDatabase } from '../server/db.mjs';
import { LEGAL_VERSION } from '../server/legal.mjs';
import { createEventLog } from '../server/event-log.mjs';
import { classifyRequest, clientOf, describeRequestKey } from '../server/request-catalog.mjs';

function setup() {
  const folder = mkdtempSync(join(tmpdir(), 'df-admin-stats-'));
  const databasePath = join(folder, 'detailflow.db');
  const first = openDatabase(databasePath, { seed: false });
  first.prepare(`INSERT INTO platform_admins (provider, external_user_id) VALUES ('telegram', '995001')`).run();
  first.close();
  const telegram = {
    provider: 'telegram', title: 'Telegram', botName: 'test_bot', handler: null,
    deepLink(payload) { return `https://bots.example/test_bot?start=${payload}`; },
    async start(handler) { this.handler = handler; }, stop() {}, async answerCallback() {}, async sendMessage() {}
  };
  return { folder, databasePath, telegram };
}

async function start({ databasePath, telegram, folder }) {
  const server = createDetailFlowServer({ databasePath, seed: false, authTokens: new Map(), messengers: [telegram], backupDirectory: join(folder, 'backups') });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  await new Promise((done) => setImmediate(done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const api = (path, { token, method = 'GET', body, headers = {} } = {}) => fetch(`${baseUrl}${path}`, {
    method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  const confirm = async (userId, purpose) => {
    const login = await (await api('/api/auth/login-requests', { method: 'POST', body: { provider: 'telegram', ...(purpose ? { purpose } : {}) } })).json();
    await telegram.handler({ provider: 'telegram', kind: 'start', userId, displayName: 'Никита', payload: new URL(login.deepLink).searchParams.get('start') });
    await telegram.handler({ provider: 'telegram', kind: 'callback', userId, payload: `login_ok:${login.id}`, callbackId: `cb-${login.id}` });
    return login;
  };
  return { server, api, confirm, stop: () => new Promise((done) => server.close(done)) };
}

test('what people do reaches the journal with the center and the role, never a name or a customer, and survives a restart', async () => {
  const context = setup();
  let running = await start(context);
  try {
    const signup = await running.confirm('700123', 'signup');
    const created = await (await running.api(`/api/auth/login-requests/${signup.id}/center`, { method: 'POST', headers: { 'x-login-secret': signup.pollSecret },
      body: { centerName: 'Детейлинг Север', ownerName: 'Олег Владелец', acceptedLegal: LEGAL_VERSION } })).json();
    const token = created.token;
    const customer = { name: 'Пётр Клиентов', phone: '+79990001122', checkDuplicatePhone: true };
    assert.equal((await running.api('/api/customers', { token, method: 'POST', body: customer })).status, 201);
    const duplicate = await running.api('/api/customers', { token, method: 'POST', body: customer });
    assert.equal(duplicate.status, 409);
    assert.match((await duplicate.json()).error.message, /Пётр/, 'the person at the desk does see the name');
    assert.equal((await running.api('/api/customers?phone=7999', { token })).status, 200);
    assert.equal((await running.api('/api/customers?phone=7998', { token })).status, 200);

    const owner = await running.confirm('995001');
    const admin = (await (await running.api(`/api/admin/login-requests/${owner.id}/session`, { method: 'POST', headers: { 'x-login-secret': owner.pollSecret } })).json()).token;
    const items = (await (await running.api('/api/admin/events', { token: admin })).json()).items;

    const added = items.find((item) => item.kind === 'action' && item.title === 'Новый клиент');
    assert.equal(added.center, 'Детейлинг Север');
    assert.match(added.actor, /^Владелец #.{4}$/);
    assert.match(added.detail, /POST \/api\/customers → 201/);
    const refused = items.find((item) => item.title === 'Не получилось: новый клиент');
    assert.equal(refused.level, 'warn');
    assert.match(refused.detail, /customer_phone_exists/);
    const views = items.filter((item) => item.kind === 'view' && item.title === 'Поиск клиентов');
    assert.equal(views.length, 1, 'looking at the same section is written once in a while');

    const everything = JSON.stringify(items);
    for (const secret of ['Пётр', 'Клиентов', '79990001122', 'Олег', 'Никита', '700123', token, admin]) assert.ok(!everything.includes(secret), `no ${secret} in the journal`);

    // Filters on the server: by center, by kind, by words, and older pages.
    const tenant = created.tenant.id;
    const onlyCenter = await (await running.api(`/api/admin/events?tenant=${tenant}`, { token: admin })).json();
    assert.ok(onlyCenter.items.length && onlyCenter.items.every((item) => item.tenantId === tenant));
    const onlyProblems = await (await running.api('/api/admin/events?levels=warn,error', { token: admin })).json();
    assert.ok(onlyProblems.items.every((item) => item.level !== 'info'));
    const found = await (await running.api(`/api/admin/events?search=${encodeURIComponent('customer_phone')}`, { token: admin })).json();
    assert.equal(found.items.length, 1);

    await running.stop();
    running = await start(context);
    const kept = await (await running.api('/api/admin/events', { token: admin })).json();
    assert.ok(kept.items.some((item) => item.title === 'Новый клиент'), 'an update of the server does not clear the journal');
  } finally {
    await running.stop();
    rmSync(context.folder, { recursive: true, force: true });
  }
});

test('stats answer for any period, show what requests come and what a center really does', async () => {
  const context = setup();
  const running = await start(context);
  try {
    const signup = await running.confirm('700124', 'signup');
    const created = await (await running.api(`/api/auth/login-requests/${signup.id}/center`, { method: 'POST', headers: { 'x-login-secret': signup.pollSecret },
      body: { centerName: 'Детейлинг Юг', ownerName: 'Олег', acceptedLegal: LEGAL_VERSION } })).json();
    await running.api('/api/customers', { token: created.token, method: 'POST', body: { name: 'Клиент', phone: '+79990001133' } });
    await running.api('/api/orders', { token: created.token });
    await running.api('/wp-login.php');
    const owner = await running.confirm('995001');
    const admin = (await (await running.api(`/api/admin/login-requests/${owner.id}/session`, { method: 'POST', headers: { 'x-login-secret': owner.pollSecret } })).json()).token;
    const stats = async (query) => (await running.api(`/api/admin/stats?${query}`, { token: admin })).json();

    const today = await stats('preset=today');
    assert.equal(today.period.preset, 'today');
    assert.equal(today.summary.newCenters, 1);
    assert.equal(today.summary.newCustomers, 1);
    assert.equal(today.activityGranularity, 'hour');
    assert.equal(today.activity.length, 24);
    const center = today.centers.list.find((item) => item.name === 'Детейлинг Юг');
    assert.deepEqual([center.status, center.statusTitle], ['active', 'Активен'], 'a customer added today is an action');
    assert.deepEqual([center.reached, center.reachedTitle], ['customer', 'Клиент'], 'the deepest step so far');
    assert.deepEqual(today.centers.funnel.map((step) => [step.id, step.centers]).slice(0, 4), [['signup', 1], ['services', 0], ['customer', 1], ['booking', 0]], 'how many centers have done each step');
    assert.equal(center.activePeople, 1, 'the owner worked today');
    assert.equal(center.changes, 1);
    assert.equal(center.signedUpWith, 'telegram');
    assert.ok(center.lastSeenAt);
    assert.equal(today.centers.workedInPeriod, 1);
    // The customer is saved on the first step of a booking: one with no booking yet is told apart.
    assert.deepEqual([center.newCustomers, center.customers, center.customersWithoutBooking, center.bookings, center.allBookings], [1, 1, 1, 0, 0]);
    assert.equal(center.createdAt, center.signedUpAt);

    assert.equal((await stats('preset=7d')).activity.length, 7);
    assert.equal((await stats('preset=90d')).activityGranularity, 'day');
    assert.equal((await stats('preset=365d')).activityGranularity, 'week');
    assert.equal((await stats('')).period.preset, '30d', 'nothing chosen: the last 30 days');
    const past = await stats('from=2020-01-01&to=2020-01-31');
    assert.deepEqual([past.period.preset, past.period.from, past.period.to], ['custom', '2020-01-01', '2020-01-31']);
    assert.equal(past.summary.newCustomers, 0);
    assert.equal(past.centers.list[0].activePeople, 0);
    assert.equal(past.activity.length, 31);
    const swapped = await stats('from=2020-01-31&to=2020-01-01');
    assert.deepEqual([swapped.period.from, swapped.period.to], ['2020-01-01', '2020-01-31'], 'dates in the wrong order still work');
    assert.equal((await stats('from=вчера&to=2020-01-01')).period.preset, '30d', 'nonsense falls back');

    const breakdown = today.requestBreakdown;
    const group = (id) => breakdown.groups.find((item) => item.id === id);
    const work = group('work');
    assert.ok(work.routes.some((route) => route.label === 'Новый клиент' && route.address === 'POST /api/customers'));
    assert.ok(work.routes.some((route) => route.label === 'Список заказов'));
    assert.ok(group('signin').routes.some((route) => route.label === 'Начало входа через мессенджер'));
    assert.ok(group('unknown').routes.some((route) => route.label === 'Роботы ищут уязвимости'));
    assert.equal(breakdown.people, work.requests + group('signin').requests + (group('site')?.requests ?? 0), 'the people exclude the admin and the robots');
    assert.ok(breakdown.series.length > 1);

    // A center of the owner's own tests: listed, but out of the totals.
    const tenant = created.tenant.id;
    assert.equal((await running.api(`/api/admin/centers/${tenant}`, { method: 'PATCH', token: created.token, body: { excluded: true } })).status, 401);
    assert.equal((await running.api(`/api/admin/centers/${tenant}`, { method: 'PATCH', token: admin, body: { excluded: true } })).status, 200);
    const without = await stats('preset=today');
    assert.equal(without.centers.total, 0);
    assert.equal(without.summary.newCustomers, 0);
    assert.equal(without.centers.list[0].skipped, true);
    await running.api(`/api/admin/centers/${tenant}`, { method: 'PATCH', token: admin, body: { excluded: false } });
    assert.equal((await stats('preset=today')).centers.total, 1);
    assert.equal((await running.api('/api/admin/centers/nope', { method: 'PATCH', token: admin, body: { excluded: true } })).status, 404);
  } finally {
    await running.stop();
    rmSync(context.folder, { recursive: true, force: true });
  }
});

test('the admin tells the app from the site: where a center was created, where people work, in the journal too', async () => {
  const context = setup();
  const running = await start(context);
  const APP = { 'user-agent': 'DetailFlow/1.1.0' };
  const SITE = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130' };
  try {
    const signup = await running.confirm('700125', 'signup');
    const created = await (await running.api(`/api/auth/login-requests/${signup.id}/center`, { method: 'POST', headers: { 'x-login-secret': signup.pollSecret, ...APP },
      body: { centerName: 'Детейлинг Север', ownerName: 'Олег', acceptedLegal: LEGAL_VERSION } })).json();
    const token = created.token;
    const owner = await running.confirm('995001');
    const admin = (await (await running.api(`/api/admin/login-requests/${owner.id}/session`, { method: 'POST', headers: { 'x-login-secret': owner.pollSecret } })).json()).token;
    const center = async () => (await (await running.api('/api/admin/stats?preset=today', { token: admin })).json());

    // Only looking, and housekeeping that happens by itself: nothing was done in the center yet.
    await running.api('/api/orders', { token, headers: APP });
    await running.api('/api/notifications/read', { token, method: 'POST', headers: APP, body: {} });
    await running.api('/api/bookings/quote-preview', { token, method: 'POST', headers: APP, body: {} });
    let stats = await center();
    let row = stats.centers.list.find((item) => item.name === 'Детейлинг Север');
    assert.equal(row.origin, 'app');
    assert.equal(row.usedIn, 'app');
    assert.deepEqual([row.status, row.changes, row.workedInPeriod], ['idle', 0, false], 'opening the app and counting a price are not actions');
    assert.equal(stats.summary.newCentersIn.app, 1);
    assert.equal(stats.summary.peopleIn.app, 1);

    await running.api('/api/customers', { token, method: 'POST', headers: SITE, body: { name: 'Клиент', phone: '+79990001144' } });
    stats = await center();
    row = stats.centers.list.find((item) => item.name === 'Детейлинг Север');
    assert.equal(row.usedIn, 'both');
    assert.equal(row.clients.site.changes, 1);
    assert.equal(row.status, 'active');

    const journal = async (query) => (await (await running.api(`/api/admin/events?${query}`, { token: admin })).json()).items;
    assert.ok((await journal('client=site')).every((item) => item.client === 'site'));
    assert.ok((await journal('client=site')).some((item) => item.title === 'Новый клиент'));
    assert.ok((await journal('client=app')).some((item) => item.title.startsWith('Создан центр')), 'creating a center says where');
    assert.ok(!(await journal('client=app')).some((item) => item.title === 'Новый клиент'));
    // A robot or a script is neither.
    await running.api('/api/orders', { token, headers: { 'user-agent': 'curl/8.0' } });
    assert.equal((await center()).summary.peopleIn.site, 1);
  } finally {
    await running.stop();
    rmSync(context.folder, { recursive: true, force: true });
  }
});

test('the admin session lasts 30 days from the last use, not 12 hours', async () => {
  const context = setup();
  const running = await start(context);
  const hours = (at) => (Date.parse(`${at.replace(' ', 'T')}Z`) - Date.now()) / 3_600_000;
  const look = new DatabaseSync(context.databasePath);
  try {
    const owner = await running.confirm('995001');
    const { token, expiresAt } = await (await running.api(`/api/admin/login-requests/${owner.id}/session`, { method: 'POST', headers: { 'x-login-secret': owner.pollSecret } })).json();
    assert.ok((Date.parse(expiresAt) - Date.now()) / 3_600_000 > 29 * 24);

    // Almost over: a day of use moves it forward again.
    look.prepare(`UPDATE admin_sessions SET expires_at = datetime('now', '+1 hour')`).run();
    assert.equal((await running.api('/api/admin/stats?preset=hour', { token })).status, 200);
    assert.ok(hours(look.prepare('SELECT expires_at FROM admin_sessions').get().expires_at) > 29 * 24);

    // Over is over, and signing out still ends it at once.
    look.prepare(`UPDATE admin_sessions SET expires_at = datetime('now', '-1 hour')`).run();
    assert.equal((await running.api('/api/admin/stats?preset=hour', { token })).status, 401);
    look.prepare(`UPDATE admin_sessions SET expires_at = datetime('now', '+1 hour')`).run();
    await running.api('/api/admin/logout', { method: 'POST', token });
    assert.equal((await running.api('/api/admin/stats?preset=hour', { token })).status, 401);
  } finally {
    look.close();
    await running.stop();
    rmSync(context.folder, { recursive: true, force: true });
  }
});

test('a broadcast goes without a title, but not without any words', async () => {
  const context = setup();
  const running = await start(context);
  try {
    const owner = await running.confirm('995001');
    const { token } = await (await running.api(`/api/admin/login-requests/${owner.id}/session`, { method: 'POST', headers: { 'x-login-secret': owner.pollSecret } })).json();
    const send = (body) => running.api('/api/admin/broadcasts', { method: 'POST', token, body });
    assert.equal((await send({ kind: 'news', title: '', body: '', audience: 'all' })).status, 422);
    assert.equal((await send({ kind: 'news', title: '', body: 'Теперь можно без заголовка', audience: 'all' })).status, 201);
    assert.equal((await send({ kind: 'news', title: 'Да', body: '', audience: 'all' })).status, 201, 'a short title is fine too');
    const { items } = await (await running.api('/api/admin/broadcasts', { token })).json();
    assert.ok(items.some((item) => item.title === '' && item.excerpt === 'Теперь можно без заголовка'));
  } finally {
    await running.stop();
    rmSync(context.folder, { recursive: true, force: true });
  }
});

test('a journal made before the app and the site were told apart gets its new column on start', () => {
  const folder = mkdtempSync(join(tmpdir(), 'df-journal-upgrade-'));
  const path = join(folder, 'old.db');
  const old = openDatabase(path, { seed: false });
  old.exec(`INSERT INTO platform_events (at, level, kind, title) VALUES ('2026-01-01T00:00:00Z', 'info', 'server', 'Старая запись'); ALTER TABLE platform_events DROP COLUMN client`);
  old.close();
  const upgraded = openDatabase(path, { seed: false });
  assert.deepEqual({ ...upgraded.prepare('SELECT title, client FROM platform_events').get() }, { title: 'Старая запись', client: null });
  upgraded.close();
  openDatabase(path, { seed: false }).close();
  rmSync(folder, { recursive: true, force: true });
});

test('only real work counts as an action, and the app is told from a browser', () => {
  assert.equal(classifyRequest('POST', '/api/customers').work, true);
  for (const path of ['/api/bookings/quote-preview', '/api/notifications/read', '/api/notifications/push', '/api/legal/accept', '/api/auth/logout']) assert.equal(classifyRequest('POST', path).work, false, path);
  assert.equal(clientOf('Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile'), 'site', 'a phone with a browser is the site');
  for (const agent of ['DetailFlow/1.1.0 (Android)', 'ru.detailflow.app/1.1.0', 'okhttp/4.12.0']) assert.equal(clientOf(agent), 'app', agent);
  for (const agent of ['curl/8.0', 'node', '', undefined]) assert.equal(clientOf(agent), null);
});

test('the catalog names known requests and never counts ids', () => {
  assert.deepEqual(['key', 'group', 'label', 'change'].map((name) => classifyRequest('POST', '/api/orders/ord_123/handover')[name]),
    ['POST /api/orders/:id/handover', 'work', 'Выдача автомобиля', true]);
  assert.equal(classifyRequest('GET', '/api/orders/ord_123').key, 'GET /api/orders/:id');
  assert.equal(classifyRequest('GET', '/api/nobody/knows').key, 'unknown:api');
  assert.equal(classifyRequest('GET', '/.env').key, 'unknown:probe');
  assert.equal(classifyRequest('GET', '/nothing', 404).key, 'unknown:missing');
  assert.equal(classifyRequest('GET', '/').key, 'site:pages');
  assert.equal(classifyRequest('GET', '/assets/app.js').key, 'site:files');
  assert.equal(describeRequestKey('GET /api/orders/:id').label, 'Карточка заказа');
  assert.equal(describeRequestKey('site:pages').group, 'site');
});

test('every route the server answers has a name in the journal', async () => {
  // A new route without a name would show as «Другой запрос к API»: the list of routes is read from the server's code.
  const { readFileSync } = await import('node:fs');
  const code = readFileSync(new URL('../server/app.mjs', import.meta.url), 'utf8');
  const missing = [];
  for (const [, method, path] of code.matchAll(/request\.method === '(POST|PUT|PATCH|DELETE)' && url\.pathname === '(\/api\/[^']+)'/g)) {
    if (classifyRequest(method, path).group === 'unknown') missing.push(`${method} ${path}`);
  }
  assert.deepEqual(missing, []);
});

test('an event log moves to the database and keeps what it heard before it', () => {
  const events = createEventLog();
  events.add({ kind: 'server', title: 'До базы' });
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE tenants (id TEXT, name TEXT); CREATE TABLE platform_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, level TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, meaning TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', tenant_id TEXT, actor TEXT, client TEXT)`);
  events.attach(db);
  events.add({ kind: 'server', title: 'В базе' });
  assert.deepEqual(events.since(0).items.map((item) => item.title), ['До базы', 'В базе']);
  db.close();
});
