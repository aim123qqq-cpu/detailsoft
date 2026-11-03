import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDetailFlowServer } from '../server/app.mjs';
import { openDatabase } from '../server/db.mjs';
import { captureConsole, createEventLog, maskAccount, redact } from '../server/event-log.mjs';

test('the journal explains known server messages and never keeps secrets', () => {
  const events = createEventLog({ limit: 3 });
  const lines = [];
  const target = { log: (...args) => lines.push(args), warn: (...args) => lines.push(args), error: (...args) => lines.push(args) };
  captureConsole(events, target);
  target.error('telegram bot is unavailable, next try in 5 s:', 'fetch https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/getMe failed');
  target.error('Sign-in letter was not sent:', 'SMTP AUTH password: 535 authentication failed');
  target.log('something new');
  assert.equal(lines.length, 3, 'the console still gets everything');

  const { items, last } = events.since(0);
  assert.equal(last, 3);
  assert.deepEqual(items.map((item) => [item.level, item.title]), [
    ['warn', 'Бот не подключается'], ['error', 'Почта не приняла пароль'], ['info', 'Сообщение сервера']]);
  assert.match(items[0].meaning, /VPN/);
  assert.doesNotMatch(items[0].detail, /AAHdqTcv/, 'a bot token is cut out');
  assert.match(items[0].detail, /bot<токен>/);

  target.log('one more');
  assert.equal(events.since(0).items.length, 3, 'only the last entries are kept');
  assert.deepEqual(events.since(3).items.map((item) => item.seq), [4]);

  assert.equal(redact(`token dfs_${'a'.repeat(64)}`), 'token dfs_<токен>');
  assert.equal(maskAccount('telegram', '123456789'), '…6789');
  assert.equal(maskAccount('email', 'nikita@mail.ru'), 'ni***@mail.ru');
});

test('/admin sees sign-in steps live, with no names or codes; others do not see the journal', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'df-journal-'));
  const databasePath = join(folder, 'detailflow.db');
  const setup = openDatabase(databasePath, { seed: false });
  setup.prepare(`INSERT INTO platform_admins (provider, external_user_id) VALUES ('telegram', '995001')`).run();
  setup.close();
  const telegram = {
    provider: 'telegram', title: 'Telegram', botName: 'detailflow_test_bot', sent: [], handler: null,
    deepLink(payload) { return `https://bots.example/detailflow_test_bot?start=${payload}`; },
    async start(handler) { this.handler = handler; }, stop() {}, async answerCallback() {},
    async sendMessage(userId, text, buttons) { this.sent.push({ userId, text, buttons }); }
  };
  const server = createDetailFlowServer({ databasePath, seed: false, authTokens: new Map(), messengers: [telegram], backupDirectory: join(folder, 'backups') });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  await new Promise((done) => setImmediate(done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const api = (path, { token, method = 'GET', body, headers = {} } = {}) => fetch(`${baseUrl}${path}`, {
    method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  const startLogin = async () => {
    const login = await (await api('/api/auth/login-requests', { method: 'POST', body: { provider: 'telegram' } })).json();
    return { ...login, payload: new URL(login.deepLink).searchParams.get('start') };
  };
  try {
    assert.equal((await api('/api/admin/events')).status, 401);

    // The case from the field: a newcomer writes /start to the bot by hand, then presses «Войти».
    await telegram.handler({ provider: 'telegram', kind: 'start', userId: '700123', displayName: 'Никита Шиганов', payload: '' });
    const newcomer = await startLogin();
    await telegram.handler({ provider: 'telegram', kind: 'start', userId: '700123', displayName: 'Никита Шиганов', payload: newcomer.payload });

    const admin = await startLogin();
    await telegram.handler({ provider: 'telegram', kind: 'start', userId: '995001', payload: admin.payload });
    await telegram.handler({ provider: 'telegram', kind: 'callback', userId: '995001', payload: `login_ok:${admin.id}`, callbackId: 'cb-admin' });
    const { token } = await (await api(`/api/admin/login-requests/${admin.id}/session`, { method: 'POST', headers: { 'x-login-secret': admin.pollSecret } })).json();

    const journal = await (await api('/api/admin/events', { token })).json();
    const titles = journal.items.map((item) => item.title);
    assert.ok(titles.includes('Telegram …0123: написал /start без ссылки входа — бот показал подсказку'), titles.join('\n'));
    assert.ok(titles.includes('Telegram …0123: новый аккаунт нажал «Войти» — предложено создать центр'));
    assert.ok(titles.includes('Telegram …5001: подтвердил в боте'));
    assert.ok(journal.items.every((item) => item.meaning), 'every entry says what it means');
    const everything = JSON.stringify(journal);
    for (const secret of ['Никита', '700123', newcomer.shortCode, newcomer.payload, admin.pollSecret]) assert.ok(!everything.includes(secret), `no ${secret} in the journal`);

    const later = await (await api(`/api/admin/events?after=${journal.last}`, { token })).json();
    assert.deepEqual(later.items, [], 'the page asks only for what is new');
  } finally {
    await new Promise((done) => server.close(done));
    rmSync(folder, { recursive: true, force: true });
  }
});
