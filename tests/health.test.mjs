import test from 'node:test';
import assert from 'node:assert/strict';
import { createDetailFlowServer } from '../server/app.mjs';

function fakeAdapter(provider, start) {
  return { provider, title: provider, botName: `${provider}_bot`, start, stop() {}, sendMessage: async () => {}, answerCallback: async () => {}, deepLink: () => '' };
}

test('health is public liveness; ready checks the database and reports bots without requiring them', async () => {
  const originalError = console.error;
  console.error = () => {};
  const server = createDetailFlowServer({
    databasePath: ':memory:', seed: false,
    messengers: [
      fakeAdapter('telegram', async () => {}),
      fakeAdapter('max', async () => { throw new Error('bad token'); })
    ]
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await new Promise((resolve) => setTimeout(resolve, 10));
    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });

    const ready = await fetch(`${baseUrl}/api/ready`);
    assert.equal(ready.status, 200, 'a broken bot does not make the center unavailable');
    const { version, ...state } = await ready.json();
    assert.deepEqual(state, { status: 'ready', database: 'ok', messengers: { telegram: 'ready', max: 'unavailable' } });
    assert.match(version, /^([0-9a-f]{7,}|unknown)$/, 'the running commit is reported');
  } finally {
    await new Promise((done) => server.close(done));
    console.error = originalError;
  }
});
