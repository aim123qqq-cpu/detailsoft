import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDetailFlowServer } from '../server/app.mjs';
import { openDatabase } from '../server/db.mjs';
import { LEGAL_VERSION } from '../server/legal.mjs';
import { createRequestMetrics } from '../server/platform-stats.mjs';

function fakeTelegram() {
  return {
    provider: 'telegram', title: 'Telegram', botName: 'detailflow_test_bot', sent: [], handler: null,
    deepLink(payload) { return `https://bots.example/detailflow_test_bot?start=${payload}`; },
    async start(handler) { this.handler = handler; },
    stop() {}, async answerCallback() {},
    async sendMessage(userId, text, buttons) { this.sent.push({ userId, text, buttons }); }
  };
}

test('the service owner signs in to /admin through the bot and sees counts across centers, never customers', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'df-admin-'));
  const databasePath = join(folder, 'detailflow.db');
  // What scripts/platform-admin.mjs does on the server: the owner's Telegram account becomes an admin.
  const setup = openDatabase(databasePath, { seed: false });
  setup.prepare(`INSERT INTO platform_admins (provider, external_user_id) VALUES ('telegram', '5001')`).run();
  setup.close();

  const telegram = fakeTelegram();
  const server = createDetailFlowServer({ databasePath, seed: false, authTokens: new Map(), messengers: [telegram], backupDirectory: join(folder, 'backups') });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  await new Promise((done) => setImmediate(done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const api = (path, { token, method = 'GET', body, headers = {} } = {}) => fetch(`${baseUrl}${path}`, {
    method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  const confirmInBot = async (userId, purpose) => {
    const login = await (await api('/api/auth/login-requests', { method: 'POST', body: { provider: 'telegram', ...(purpose ? { purpose } : {}) } })).json();
    await telegram.handler({ provider: 'telegram', kind: 'start', userId, displayName: 'Никита', payload: new URL(login.deepLink).searchParams.get('start') });
    await telegram.handler({ provider: 'telegram', kind: 'callback', userId, payload: `login_ok:${login.id}`, callbackId: `cb-${login.id}` });
    return login;
  };
  const adminSession = (login) => api(`/api/admin/login-requests/${login.id}/session`, { method: 'POST', headers: { 'x-login-secret': login.pollSecret } });

  try {
    assert.equal((await api('/api/admin/stats')).status, 401, 'no admin session, no stats');

    // A center appears; the owner of the service gets a message about it.
    const signup = await confirmInBot('7001', 'signup');
    const created = await api(`/api/auth/login-requests/${signup.id}/center`, { method: 'POST', headers: { 'x-login-secret': signup.pollSecret },
      body: { centerName: 'Детейлинг Север', ownerName: 'Олег', acceptedLegal: LEGAL_VERSION } });
    assert.equal(created.status, 201);
    await new Promise((done) => setTimeout(done, 50));
    assert.match(telegram.sent.filter((message) => message.userId === '5001').at(-1)?.text ?? '', /Новый центр.*«Детейлинг Север».*Всего центров: 1/s);

    // The center's owner confirms a sign-in, but is not the service owner: no admin session.
    const stranger = await confirmInBot('7001');
    assert.equal((await adminSession(stranger)).status, 403);

    // The service owner has no center of their own, yet the bot lets them confirm.
    const owner = await confirmInBot('5001');
    const opened = await adminSession(owner);
    assert.equal(opened.status, 201);
    const { token } = await opened.json();
    assert.match(token, /^dfa_/);
    assert.equal((await adminSession(owner)).status, 409, 'a sign-in opens one session');

    const stats = await (await api('/api/admin/stats', { token })).json();
    assert.equal(stats.centers.total, 1);
    assert.equal(stats.centers.list[0].name, 'Детейлинг Север');
    assert.equal(stats.centers.list[0].members, 1);
    assert.equal(stats.users.members, 1);
    assert.equal(stats.activity.length, 30);
    assert.equal(stats.requests.length, 60);
    assert.ok(stats.system.cpuCount >= 1);
    assert.ok(stats.system.databaseBytes > 0);
    assert.equal(stats.bots.telegram.status, 'ready');
    assert.doesNotMatch(JSON.stringify(stats), /phone|plate|Олег/i, 'no people and no customer data, only counts and center names');

    // A center session is not an admin session, and signing out ends the admin one.
    assert.equal((await api('/api/admin/stats', { token: (await created.json()).token })).status, 401);
    assert.equal((await api('/api/admin/logout', { method: 'POST', token })).status, 200);
    assert.equal((await api('/api/admin/stats', { token })).status, 401);
  } finally {
    await new Promise((done) => server.close(done));
    rmSync(folder, { recursive: true, force: true });
  }
});

test('request metrics count responses and server errors per minute for the last hour', () => {
  let now = Date.UTC(2026, 9, 27, 10, 0, 0);
  const metrics = createRequestMetrics(() => now);
  metrics.record(200, 10);
  metrics.record(500, 3000);
  now += 60_000;
  metrics.record(200, 5);
  const hour = metrics.lastHour();
  assert.equal(hour.length, 60);
  assert.deepEqual(hour.at(-2), { minute: new Date(Date.UTC(2026, 9, 27, 10, 0, 0)).toISOString(), requests: 2, errors: 1, slow: 1 });
  assert.equal(hour.at(-1).requests, 1);
});
