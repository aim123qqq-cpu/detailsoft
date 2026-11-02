import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.mjs';
import { DetailFlowRepository } from '../server/repository.mjs';
import { createNotificationCenter } from '../server/notifications.mjs';
import { createDetailFlowServer } from '../server/app.mjs';

function setup(clock) {
  const db = openDatabase(':memory:', { seed: true });
  const repository = new DetailFlowRepository(db);
  const sent = [];
  const telegram = { provider: 'telegram', sendMessage: async (userId, text) => { sent.push({ userId, text }); } };
  db.prepare(`INSERT INTO member_messenger_links (id, tenant_id, member_id, provider, external_user_id) VALUES ('ml_1', 'tenant_demo', 'member_demo_owner', 'telegram', '501')`).run();
  const center = createNotificationCenter({ db, repository, adapters: new Map([['telegram', telegram]]), readyProviders: new Set(['telegram']), now: () => clock.now });
  const book = (id, startAt, status = 'CONFIRMED') => db.prepare(`INSERT INTO bookings (id, tenant_id, customer_id, vehicle_id, channel, start_at, estimated_duration_minutes, status, preliminary_amount_minor, idempotency_key, request_hash)
    VALUES (?, 'tenant_demo', 'cust_alexey', 'veh_camry', 'call', ?, 90, ?, 150000, ?, 'h')`).run(id, startAt, status, `key-${id}`);
  return { db, center, sent, book };
}

test('a reminder goes out once before a booking, to those who keep bookings, without the customer\'s name', async () => {
  const clock = { now: new Date('2026-11-03T11:20:00+03:00') };
  const { center, sent, book } = setup(clock);
  book('bk_soon', '2026-11-03T12:00:00+03:00');
  book('bk_later', '2026-11-03T15:00:00+03:00');
  book('bk_cancelled', '2026-11-03T12:10:00+03:00', 'CANCELLED');

  await center.tick();
  await center.tick();
  const owner = center.list('member_demo_owner');
  assert.equal(owner.items.length, 1, 'one reminder, once, only for the booking within the hour');
  assert.equal(owner.items[0].kind, 'booking_reminder');
  assert.equal(owner.items[0].link, '/bookings/bk_soon');
  assert.match(owner.items[0].body, /^12:00 · Toyota Camry · 1 ч 30 мин$/);
  assert.equal(center.list('member_demo_master').items.length, 0, 'a master without bookings rights is not reminded');
  assert.equal(sent.length, 1, 'a copy through the linked bot');
  assert.doesNotMatch(sent[0].text, /Алексей|Морозов|\+7/, 'no customer\'s name or phone goes to a messenger');

  clock.now = new Date('2026-11-03T14:05:00+03:00');
  await center.tick();
  assert.equal(center.list('member_demo_owner').items.length, 2, 'the next booking in its turn');
  assert.equal(center.list('member_demo_owner').unread, 2);
  center.markRead('member_demo_owner', 'all');
  assert.equal(center.list('member_demo_owner').unread, 0);
});

test('the plan of the day in the morning, as the center set it; a member can turn reminders off', async () => {
  const clock = { now: new Date('2026-11-03T08:59:00+03:00') };
  const { center, book } = setup(clock);
  book('bk_a', '2026-11-03T10:00:00+03:00');
  book('bk_b', '2026-11-03T16:30:00+03:00');
  assert.equal(center.updateReminderSettings('tenant_demo', { beforeMinutes: null, morning: { enabled: true, time: '09:00' }, evening: { enabled: false, time: '19:00' } }).kind, 'updated');
  assert.equal(center.updateReminderSettings('tenant_demo', { beforeMinutes: 45, morning: { enabled: true, time: '09:00' }, evening: { enabled: false, time: '19:00' } }).kind, 'invalid');

  await center.tick();
  assert.equal(center.list('member_demo_owner').items.length, 0, 'not before nine');
  clock.now = new Date('2026-11-03T09:01:00+03:00');
  await center.tick();
  await center.tick();
  const [plan] = center.list('member_demo_owner').items;
  assert.equal(plan.title, 'План на сегодня: 2 записи');
  assert.equal(plan.body, '10:00 · Toyota Camry · 1 ч 30 мин\n16:30 · Toyota Camry · 1 ч 30 мин');
  assert.equal(center.list('member_demo_owner').items.length, 1, 'once a day');

  center.updateMemberPrefs('tenant_demo', 'member_demo_owner', { reminders: false });
  clock.now = new Date('2026-11-04T09:02:00+03:00');
  book('bk_c', '2026-11-04T11:00:00+03:00');
  await center.tick();
  assert.equal(center.list('member_demo_owner').items.length, 1, 'turned off for themself');
});

test('the feed, preferences and center settings over the API; the demo has an empty feed', async () => {
  const server = createDetailFlowServer({ databasePath: ':memory:', seed: true, authTokens: new Map([
    ['demo-session-token', { tenantId: 'tenant_demo', displayName: 'Анна', roles: ['owner', 'admin'] }],
    ['owner-token', { tenantId: 'tenant_demo', displayName: 'Анна Смирнова', roles: ['owner', 'admin'], memberId: 'member_demo_owner' }],
    ['master-token', { tenantId: 'tenant_demo', displayName: 'Дмитрий Соколов', roles: ['master'], memberId: 'member_demo_master' }]
  ]) });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const api = (path, token, init = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
  try {
    assert.deepEqual(await (await api('/api/notifications', 'demo-session-token')).json(), { items: [], unread: 0 });
    assert.deepEqual(await (await api('/api/notifications/preferences', 'owner-token')).json(), { reminders: true, news: true, viaMessenger: true });
    assert.deepEqual(await (await api('/api/notifications/preferences', 'owner-token', { method: 'PUT', body: JSON.stringify({ viaMessenger: false }) })).json(), { reminders: true, news: true, viaMessenger: false });
    const defaults = await (await api('/api/tenants/current/reminders', 'owner-token')).json();
    assert.deepEqual(defaults, { beforeMinutes: 60, morning: { enabled: true, time: '09:00' }, evening: { enabled: false, time: '19:00' } });
    const changed = await api('/api/tenants/current/reminders', 'owner-token', { method: 'PUT', body: JSON.stringify({ ...defaults, beforeMinutes: 30, evening: { enabled: true, time: '20:00' } }) });
    assert.equal((await changed.json()).evening.time, '20:00');
    assert.equal((await api('/api/tenants/current/reminders', 'master-token')).status, 403, 'only the owner or an administrator sets the center\'s reminders');
  } finally {
    await new Promise((done) => server.close(done));
  }
});
