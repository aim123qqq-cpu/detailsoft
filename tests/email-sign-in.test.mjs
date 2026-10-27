import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDetailFlowServer } from '../server/app.mjs';
import { openDatabase } from '../server/db.mjs';
import { LEGAL_VERSION } from '../server/legal.mjs';
import { createSmtpMailer } from '../server/mailer.mjs';

function fakeMailer() {
  return { letters: [], async send(letter) { this.letters.push(letter); } };
}
const codeIn = (letter) => letter.text.match(/Ваш код: (\d{6})/)[1];

async function start(options = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'df-email-'));
  const server = createDetailFlowServer({ databasePath: join(folder, 'detailflow.db'), seed: false, authTokens: new Map(), backupDirectory: join(folder, 'backups'), ...options });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const api = (path, { token, method = 'GET', body, secret } = {}) => fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(secret ? { 'x-login-secret': secret } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { api, stop: async () => { await new Promise((done) => server.close(done)); rmSync(folder, { recursive: true, force: true }); } };
}

test('a person creates a center with only an email: a code by letter, then the center; later signs in the same way', async () => {
  const mailer = fakeMailer();
  const { api, stop } = await start({ mailer });
  try {
    assert.equal((await (await api('/api/auth/providers')).json()).email, true);
    assert.equal((await api('/api/auth/email-requests', { method: 'POST', body: { email: 'not an address' } })).status, 422);

    const request = await api('/api/auth/email-requests', { method: 'POST', body: { email: ' Owner@Example.RU ', purpose: 'signup' } });
    assert.equal(request.status, 201);
    const signup = await request.json();
    assert.equal(signup.email, 'owner@example.ru');
    assert.equal(signup.purpose, 'signup');
    assert.equal(JSON.stringify(signup).includes(codeIn(mailer.letters[0])), false, 'the code goes only to the mailbox');
    assert.equal(mailer.letters[0].to, 'owner@example.ru');
    assert.match(mailer.letters[0].subject, /Код для создания центра в DetailFlow: \d{6}/);

    const confirm = (login, code) => api(`/api/auth/email-requests/${login.id}/confirm`, { method: 'POST', secret: login.pollSecret, body: { code } });
    const wrong = await confirm(signup, codeIn(mailer.letters[0]) === '000000' ? '111111' : '000000');
    assert.equal(wrong.status, 422);
    assert.equal((await wrong.json()).error.details.attemptsLeft, 4);
    assert.equal((await confirm({ ...signup, pollSecret: 'not-the-secret' }, codeIn(mailer.letters[0]))).status, 404, 'the code alone is not enough');
    const confirmed = await confirm(signup, codeIn(mailer.letters[0]));
    assert.equal(confirmed.status, 200);
    assert.equal((await confirmed.json()).status, 'CONFIRMED');

    const created = await api(`/api/auth/login-requests/${signup.id}/center`, { method: 'POST', secret: signup.pollSecret,
      body: { centerName: 'Детейлинг Почта', ownerName: 'Ольга', acceptedLegal: LEGAL_VERSION } });
    assert.equal(created.status, 201);
    const { token } = await created.json();
    const session = await (await api('/api/session', { token })).json();
    assert.equal(session.actor.authProvider, 'email');
    assert.equal(session.tenant.name, 'Детейлинг Почта');
    const team = await (await api('/api/tenants/current/team', { token })).json();
    assert.deepEqual(team.items[0].messengerLinks.map((link) => [link.provider, link.externalName]), [['email', 'owner@example.ru']]);

    // Later: a sign-in with the same address opens this center.
    const login = await (await api('/api/auth/email-requests', { method: 'POST', body: { email: 'owner@example.ru' } })).json();
    assert.match(mailer.letters.at(-1).subject, /^Код для входа в DetailFlow/);
    assert.equal((await confirm(login, codeIn(mailer.letters.at(-1)))).status, 200);
    const opened = await api(`/api/auth/login-requests/${login.id}/session`, { method: 'POST', secret: login.pollSecret, body: {} });
    assert.equal(opened.status, 201);
    assert.equal((await opened.json()).tenant.name, 'Детейлинг Почта');
    assert.equal((await confirm(login, codeIn(mailer.letters.at(-1)))).status, 409, 'a used code does not work again');
  } finally {
    await stop();
  }
});

test('an address nobody linked gets a code but no center; five wrong codes close the request; letters are limited', async () => {
  const mailer = fakeMailer();
  const { api, stop } = await start({ mailer });
  try {
    const confirm = (login, code) => api(`/api/auth/email-requests/${login.id}/confirm`, { method: 'POST', secret: login.pollSecret, body: { code } });
    const stranger = await (await api('/api/auth/email-requests', { method: 'POST', body: { email: 'nobody@example.ru' } })).json();
    assert.equal((await confirm(stranger, codeIn(mailer.letters.at(-1)))).status, 200);
    const opened = await api(`/api/auth/login-requests/${stranger.id}/session`, { method: 'POST', secret: stranger.pollSecret, body: {} });
    assert.equal(opened.status, 409);
    assert.equal((await opened.json()).error.code, 'no_active_membership');

    const guessed = await (await api('/api/auth/email-requests', { method: 'POST', body: { email: 'nobody@example.ru' } })).json();
    const right = codeIn(mailer.letters.at(-1));
    const wrongCode = right === '000000' ? '111111' : '000000';
    for (let attempt = 0; attempt < 4; attempt += 1) assert.equal((await confirm(guessed, wrongCode)).status, 422);
    const closed = await confirm(guessed, wrongCode);
    assert.equal(closed.status, 409);
    assert.match((await closed.json()).error.message, /Запросите новый/);
    assert.equal((await confirm(guessed, right)).status, 409, 'the right code is too late after five wrong ones');

    assert.equal((await api('/api/auth/email-requests', { method: 'POST', body: { email: 'nobody@example.ru' } })).status, 201);
    const flood = await api('/api/auth/email-requests', { method: 'POST', body: { email: 'NOBODY@example.ru' } });
    assert.equal(flood.status, 429, 'no more than three letters to one address in 10 minutes');
    assert.equal(mailer.letters.length, 3);
  } finally {
    await stop();
  }
});

test('the owner gives an employee an email; the employee signs in with it; a letter that fails is reported', async () => {
  const mailer = fakeMailer();
  const { api, stop } = await start({ mailer });
  try {
    const confirm = (login) => api(`/api/auth/email-requests/${login.id}/confirm`, { method: 'POST', secret: login.pollSecret, body: { code: codeIn(mailer.letters.at(-1)) } });
    const signup = await (await api('/api/auth/email-requests', { method: 'POST', body: { email: 'boss@example.ru', purpose: 'signup' } })).json();
    await confirm(signup);
    const { token } = await (await api(`/api/auth/login-requests/${signup.id}/center`, { method: 'POST', secret: signup.pollSecret,
      body: { centerName: 'Центр', ownerName: 'Борис', acceptedLegal: LEGAL_VERSION } })).json();
    const { member } = await (await api('/api/tenants/current/team', { token, method: 'POST', body: { displayName: 'Мастер Иван', roles: ['master'] } })).json();

    const setEmail = (memberId, email) => api(`/api/tenants/current/team/${memberId}/email`, { token, method: 'PUT', body: { email } });
    assert.equal((await setEmail(member.id, 'плохой')).status, 422);
    assert.equal((await setEmail(member.id, 'boss@example.ru')).status, 409, 'one address, one member of a center');
    assert.equal((await setEmail(member.id, 'Ivan@Example.ru')).status, 200);

    const login = await (await api('/api/auth/email-requests', { method: 'POST', body: { email: 'ivan@example.ru' } })).json();
    await confirm(login);
    const opened = await api(`/api/auth/login-requests/${login.id}/session`, { method: 'POST', secret: login.pollSecret, body: {} });
    assert.equal(opened.status, 201);
    const employee = await opened.json();
    assert.equal(employee.member.displayName, 'Мастер Иван');

    // A changed address ends the sessions opened with the old one.
    assert.equal((await api('/api/session', { token: employee.token })).status, 200);
    assert.equal((await setEmail(member.id, 'ivan.new@example.ru')).status, 200);
    assert.equal((await api('/api/session', { token: employee.token })).status, 401);

    mailer.send = async () => { throw new Error('SMTP RCPT TO: 550 no such mailbox'); };
    const failed = await api('/api/auth/email-requests', { method: 'POST', body: { email: 'other@example.ru' } });
    assert.equal(failed.status, 502);
    assert.match((await failed.json()).error.message, /Не удалось отправить письмо/);
  } finally {
    await stop();
  }
});

test('without SMTP settings there is no sign-in by email', async () => {
  const { api, stop } = await start();
  try {
    assert.equal((await (await api('/api/auth/providers')).json()).email, false);
    assert.equal((await api('/api/auth/email-requests', { method: 'POST', body: { email: 'a@example.ru' } })).status, 422);
  } finally {
    await stop();
  }
});

test('an older database gets email in its sign-in tables and keeps every row', () => {
  const folder = mkdtempSync(join(tmpdir(), 'df-email-upgrade-'));
  const databasePath = join(folder, 'detailflow.db');
  try {
    // The database as it was before sign-in by email: migrations up to 028 only.
    const old = new DatabaseSync(databasePath);
    const migrations = resolve('migrations');
    for (const name of readdirSync(migrations).filter((file) => file.endsWith('.sql') && file < '029').sort()) old.exec(readFileSync(join(migrations, name), 'utf8'));
    old.exec(`INSERT INTO tenants (id, name) VALUES ('t1', 'Центр');
      INSERT INTO tenant_members (id, tenant_id, display_name, roles_json) VALUES ('m1', 't1', 'Олег', '["owner"]');
      INSERT INTO member_messenger_links (id, tenant_id, member_id, provider, external_user_id) VALUES ('l1', 't1', 'm1', 'telegram', '42');
      INSERT INTO login_requests (id, provider, start_token_hash, short_code, poll_secret_hash, expires_at) VALUES ('r1', 'telegram', 'h', 'ABCDEF', 'p', '2999-01-01 00:00:00');
      INSERT INTO login_request_purposes (login_request_id, purpose) VALUES ('r1', 'signup');
      INSERT INTO center_signups (tenant_id, provider, external_user_id) VALUES ('t1', 'telegram', '42');`);
    assert.throws(() => old.exec(`INSERT INTO member_messenger_links (id, tenant_id, member_id, provider, external_user_id) VALUES ('l2', 't1', 'm1', 'email', 'a@b.ru')`));
    old.close();

    const db = openDatabase(databasePath);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM member_messenger_links').get().count, 1);
    assert.equal(db.prepare('SELECT purpose FROM login_request_purposes WHERE login_request_id = ?').get('r1').purpose, 'signup', 'the rebuild did not cascade');
    assert.equal(db.prepare('SELECT COUNT(*) count FROM center_signups').get().count, 1);
    db.exec(`INSERT INTO member_messenger_links (id, tenant_id, member_id, provider, external_user_id) VALUES ('l2', 't1', 'm1', 'email', 'a@b.ru')`);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_member_messenger_links_external'").get(), 'indexes are back');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    db.exec(`DELETE FROM login_requests WHERE id = 'r1'`);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM login_request_purposes').get().count, 0, 'the purpose still follows its request');
    db.close();
    // A second start changes nothing.
    openDatabase(databasePath).close();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('the SMTP client signs in to the mailbox and sends the letter, and reports a refusal without the password', async () => {
  const transcript = [];
  let refuse = false;
  const fake = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.write('220 smtp.example ESMTP\r\n');
    let data = false;
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        transcript.push(line);
        if (data) { if (line === '.') { data = false; socket.write('250 2.0.0 queued\r\n'); } continue; }
        if (line.startsWith('EHLO')) socket.write('250-smtp.example\r\n250-AUTH LOGIN PLAIN\r\n250 8BITMIME\r\n');
        else if (line === 'AUTH LOGIN') socket.write('334 VXNlcm5hbWU6\r\n');
        else if (line === Buffer.from('robot@example.ru').toString('base64')) socket.write('334 UGFzc3dvcmQ6\r\n');
        else if (line === Buffer.from('app-password').toString('base64')) socket.write(refuse ? '535 5.7.8 authentication failed\r\n' : '235 2.7.0 ok\r\n');
        else if (line.startsWith('MAIL FROM') || line.startsWith('RCPT TO')) socket.write('250 ok\r\n');
        else if (line === 'DATA') { data = true; socket.write('354 go ahead\r\n'); }
        else if (line === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
      }
    });
  });
  await new Promise((done) => fake.listen(0, '127.0.0.1', done));
  const mailer = createSmtpMailer({ host: '127.0.0.1', port: fake.address().port, user: 'robot@example.ru', password: 'app-password', from: 'robot@example.ru',
    openSocket: ({ host, port }) => net.connect({ host, port }) });
  try {
    await mailer.send({ to: 'owner@example.ru', subject: 'Код для входа в DetailFlow: 123456', text: 'Ваш код: 123456\nСтрока два' });
    assert.ok(transcript.includes('RCPT TO:<owner@example.ru>'));
    const body = transcript.slice(transcript.indexOf('') + 1, transcript.indexOf('.')).join('');
    assert.equal(Buffer.from(body, 'base64').toString(), 'Ваш код: 123456\r\nСтрока два');
    assert.ok(transcript.some((line) => line === `Subject: =?UTF-8?B?${Buffer.from('Код для входа в DetailFlow: 123456').toString('base64')}?=`));

    refuse = true;
    const error = await mailer.send({ to: 'owner@example.ru', subject: 'x', text: 'y' }).then(() => null, (failure) => failure);
    assert.match(error.message, /SMTP AUTH password: 535/);
    assert.equal(error.message.includes(Buffer.from('app-password').toString('base64')), false);
    await assert.rejects(mailer.send({ to: 'a@b.ru\r\nBcc: x@y.ru', subject: 'x', text: 'y' }), /bad recipient/);
  } finally {
    await new Promise((done) => fake.close(done));
  }
});
