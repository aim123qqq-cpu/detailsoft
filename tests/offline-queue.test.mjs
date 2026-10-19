import test from 'node:test';
import assert from 'node:assert/strict';
import { configureSync, discardFailed, enqueue, flush, readCache, retryFailed, syncState, writeCache } from '../src/offline/sync.ts';

// Node has no IndexedDB: the store keeps the queue in memory, which is enough to check the rules.
const respond = (status, body) => ({ ok: status < 400, status, json: async () => body });
const settled = async () => { while (syncState().syncing) await new Promise((done) => setTimeout(done, 1)); };

/** A fake server: throws like fetch while offline, otherwise answers through `answer`. */
function fakeServer(scope) {
  const server = { online: false, sent: [], answer: (item) => respond(200, { id: item.entity.split(':')[1], estimateVersions: [], from: item.label }) };
  configureSync({
    scope: () => scope,
    send: async (item) => {
      if (!server.online) throw new TypeError('Failed to fetch');
      server.sent.push(item);
      return server.answer(item);
    }
  });
  return server;
}

async function queueOffline(server, items) {
  server.online = false;
  await flush();
  await settled();
  for (const [label, entity] of items) {
    await enqueue({ method: 'POST', path: `/api/orders/${entity.split(':')[1]}/x`, body: '{}', key: `key-${label}`, label, entity });
  }
  await settled();
  await flush();
  await settled();
}

test('the queue sends in order, stops at a refused change, retries it, and discard drops it with later changes of the same order', async () => {
  const server = fakeServer('scope-order');
  await writeCache('/api/orders/A', { id: 'A', local: true });
  await queueOffline(server, [['A-1', 'order:A'], ['A-2', 'order:A'], ['B-1', 'order:B'], ['A-3', 'order:A']]);
  assert.equal(syncState().reachable, false);
  assert.equal(syncState().pending, 4);
  assert.deepEqual(server.sent, [], 'nothing is sent while offline');

  server.online = true;
  server.answer = (item) => item.label === 'A-2'
    ? respond(409, { error: { code: 'invalid_order_state', message: 'Работы уже начаты' } })
    : respond(200, { id: item.entity.split(':')[1], estimateVersions: [], from: item.label });
  await flush();
  assert.deepEqual(server.sent.map((item) => item.label), ['A-1', 'A-2'], 'stops at the refused change, order kept');
  assert.equal(syncState().failed?.label, 'A-2');
  assert.equal(syncState().failed?.error, 'Работы уже начаты');
  assert.deepEqual(await readCache('/api/orders/A'), { id: 'A', estimateVersions: [], from: 'A-1' }, 'the server answer replaced the local copy');

  await retryFailed();
  await settled();
  assert.deepEqual(server.sent.slice(2).map((item) => item.label), ['A-2'], 'retry sends the same change again');
  assert.equal(syncState().pending, 3);

  // A-3 was made on top of the refused A-2, so it goes too; B-1 belongs to another order and is sent.
  assert.equal(await discardFailed(), 2);
  await settled();
  assert.deepEqual(server.sent.slice(3).map((item) => item.label), ['B-1']);
  assert.equal(syncState().pending, 0);
  assert.equal(syncState().failed, null);
  assert.equal(await readCache('/api/orders/A'), undefined, 'the order is reloaded from the server next time');
});

test('a change resent after a network failure keeps its idempotency key', async () => {
  const server = fakeServer('scope-network');
  await queueOffline(server, [['start', 'order:C']]);
  await flush();
  await settled();
  assert.equal(syncState().pending, 1, 'still waiting while offline');

  server.online = true;
  await flush();
  await settled();
  assert.equal(syncState().pending, 0);
  assert.equal(syncState().reachable, true);
  assert.deepEqual(server.sent.map((item) => item.key), ['key-start']);
});
