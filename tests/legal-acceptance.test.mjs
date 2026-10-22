import test from 'node:test';
import assert from 'node:assert/strict';
import { createDetailFlowServer } from '../server/app.mjs';
import { LEGAL_VERSION } from '../server/legal.mjs';

test('a person accepts the agreement and the separate consent once per edition; the demo is not asked', async () => {
  const server = createDetailFlowServer({ databasePath: ':memory:', seed: true });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const api = (path, token, init = {}) => fetch(`${baseUrl}${path}`, {
    ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers }
  });
  try {
    const demo = await (await api('/api/session', 'demo-session-token')).json();
    assert.equal(demo.actor.legalAccepted, true, 'the demo has no person behind it');
    assert.equal(demo.legalVersion, LEGAL_VERSION);

    const created = await (await api('/api/tenants/current/team', 'demo-session-token', {
      method: 'POST', body: JSON.stringify({ displayName: 'Мария Орлова', roles: ['intake'] })
    })).json();
    const employee = created.accessToken;
    assert.equal((await (await api('/api/session', employee)).json()).actor.legalAccepted, false, 'an employee is asked first');

    const outdated = await api('/api/legal/accept', employee, { method: 'POST', body: JSON.stringify({ version: '2000-01-01' }) });
    assert.equal(outdated.status, 409, 'only the current edition can be accepted');
    const accepted = await api('/api/legal/accept', employee, { method: 'POST', body: JSON.stringify({ version: LEGAL_VERSION }) });
    assert.equal(accepted.status, 200);
    assert.equal((await (await api('/api/session', employee)).json()).actor.legalAccepted, true);
    assert.equal((await api('/api/legal/accept', employee, { method: 'POST', body: JSON.stringify({ version: LEGAL_VERSION }) })).status, 200, 'accepting again is harmless');
    assert.equal((await api('/api/legal/accept', 'demo-session-token', { method: 'POST', body: JSON.stringify({ version: LEGAL_VERSION }) })).status, 409);
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test('the app asks for the same edition the server expects', async () => {
  const { readFile } = await import('node:fs/promises');
  const app = await readFile(new URL('../src/legal.ts', import.meta.url), 'utf8');
  assert.match(app, new RegExp(`LEGAL_VERSION = '${LEGAL_VERSION}'`), 'src/legal.ts and server/legal.mjs name the same edition');
});
