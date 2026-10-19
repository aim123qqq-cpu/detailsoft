import test from 'node:test';
import assert from 'node:assert/strict';
import { configureSync, enqueue, pruneCache, readCache, writeCache } from '../src/offline/sync.ts';

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-10-19T12:00:00Z');
const daysAgo = (days) => new Date(now - days * DAY).toISOString();

test('cleanup drops old finished and stale copies but never what waits to be sent or what the app needs offline', async () => {
  let scope = 'employee-a';
  configureSync({ scope: () => scope, send: async () => { throw new TypeError('offline'); } });
  await writeCache('/api/session', { actor: {} }, daysAgo(40));
  await writeCache('/api/offline/booking-pack', { busy: [] }, daysAgo(40));
  await writeCache('/api/orders/closed-old', { id: 'closed-old', status: 'CLOSED' }, daysAgo(3));
  await writeCache('/api/orders/closed-new', { id: 'closed-new', status: 'CLOSED' }, daysAgo(1));
  await writeCache('/api/orders/active', { id: 'active', status: 'IN_PROGRESS' }, daysAgo(10));
  await writeCache('/api/orders/ancient', { id: 'ancient', status: 'IN_PROGRESS' }, daysAgo(30));
  await writeCache('/api/bookings/cancelled', { id: 'cancelled', status: 'CANCELLED' }, daysAgo(5));
  await writeCache('/api/orders/pending-closed', { id: 'pending-closed', status: 'CLOSED' }, daysAgo(30));
  await writeCache('/api/customers?phone=913', { items: [] }, daysAgo(8));
  await writeCache('/api/bookings?view=upcoming&limit=50', { items: [] }, daysAgo(2));
  await enqueue({ method: 'POST', path: '/api/orders/pending-closed/handover', body: '{}', key: 'k', label: 'Выдача', entity: 'order:pending-closed' });
  scope = 'employee-b';
  await writeCache('/api/session', { actor: {} }, daysAgo(9));
  scope = 'employee-a';

  const removed = await pruneCache(now);
  const kept = async (path) => (await readCache(path)) !== undefined;
  assert.equal(await kept('/api/session'), true);
  assert.equal(await kept('/api/offline/booking-pack'), true);
  assert.equal(await kept('/api/orders/closed-old'), false, 'finished 3 days ago');
  assert.equal(await kept('/api/orders/closed-new'), true, 'finished yesterday');
  assert.equal(await kept('/api/orders/active'), true);
  assert.equal(await kept('/api/orders/ancient'), false, 'not refreshed for 30 days');
  assert.equal(await kept('/api/bookings/cancelled'), false);
  assert.equal(await kept('/api/orders/pending-closed'), true, 'waits to be sent');
  assert.equal(await kept('/api/customers?phone=913'), false, 'an old search');
  assert.equal(await kept('/api/bookings?view=upcoming&limit=50'), true);
  scope = 'employee-b';
  assert.equal(await kept('/api/session'), false, 'another employee, not seen for 9 days');
  scope = 'employee-a';
  assert.equal(removed, 5);
});

test('beyond the size limit the oldest copies go first, the protected ones stay', async () => {
  configureSync({ scope: () => 'size-scope', send: async () => { throw new TypeError('offline'); } });
  const big = 'x'.repeat(1000);
  await writeCache('/api/session', { big }, daysAgo(0.5));
  await writeCache('/api/orders/one', { id: 'one', big }, daysAgo(0.3));
  await writeCache('/api/orders/two', { id: 'two', big }, daysAgo(0.2));
  await writeCache('/api/orders/three', { id: 'three', big }, daysAgo(0.1));
  // The first test's copies are another employee's here and old: they go too.
  assert.ok(await pruneCache(now, 2500) >= 2);
  assert.equal(await readCache('/api/session') !== undefined, true);
  assert.equal(await readCache('/api/orders/one'), undefined);
  assert.equal(await readCache('/api/orders/two'), undefined);
  assert.notEqual(await readCache('/api/orders/three'), undefined);
});
