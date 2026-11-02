import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDetailFlowServer } from '../server/app.mjs';
import { openDatabase } from '../server/db.mjs';

const ADMIN = `dfa_${'a'.repeat(64)}`;

/** A server whose database has the service owner signed in to /admin, and three demo employees. */
async function start() {
  const folder = mkdtempSync(join(tmpdir(), 'df-broadcasts-'));
  const databasePath = join(folder, 'detailflow.db');
  const setup = openDatabase(databasePath, { seed: true });
  setup.prepare(`INSERT INTO platform_admins (provider, external_user_id) VALUES ('telegram', '5001')`).run();
  setup.prepare(`INSERT INTO admin_sessions (token_hash, provider, external_user_id, expires_at) VALUES (?, 'telegram', '5001', '2999-01-01 00:00:00')`)
    .run(createHash('sha256').update(ADMIN).digest('hex'));
  setup.close();
  const server = createDetailFlowServer({ databasePath, seed: false, authTokens: new Map([
    ['owner-token', { tenantId: 'tenant_demo', displayName: 'Анна Смирнова', roles: ['owner', 'admin'], memberId: 'member_demo_owner' }],
    ['master-token', { tenantId: 'tenant_demo', displayName: 'Дмитрий Соколов', roles: ['master'], memberId: 'member_demo_master' }],
    ['intake-token', { tenantId: 'tenant_demo', displayName: 'Ирина Лебедева', roles: ['intake'], memberId: 'member_demo_intake' }]
  ]) });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const api = async (path, token, init = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
    return { status: response.status, body: await response.json() };
  };
  const stop = async () => { await new Promise((done) => server.close(done)); rmSync(folder, { recursive: true, force: true }); };
  return { api, stop };
}

test('news go to everyone who keeps news on, or only to owners and administrators; only the service owner sends', async () => {
  const { api, stop } = await start();
  try {
    assert.equal((await api('/api/admin/broadcasts', 'owner-token', { method: 'POST', body: JSON.stringify({ kind: 'news', title: 'Привет', audience: 'all' }) })).status, 401, 'a center\'s owner is not the service owner');
    assert.equal((await api('/api/notifications/preferences', 'intake-token', { method: 'PUT', body: JSON.stringify({ news: false }) })).status, 200);

    const preview = await api('/api/admin/broadcasts/preview', ADMIN, { method: 'POST', body: JSON.stringify({ audience: 'all' }) });
    assert.deepEqual(preview.body, { kind: 'ok', recipients: 3, centers: 2 }, 'both centers; the one who turned news off is not counted');
    assert.equal((await api('/api/admin/broadcasts/preview', ADMIN, { method: 'POST', body: JSON.stringify({ audience: 'admins' }) })).body.recipients, 2, 'the owners of both centers');
    assert.equal((await api('/api/admin/broadcasts/preview', ADMIN, { method: 'POST', body: JSON.stringify({ audience: 'center', tenantId: 'tenant_demo' }) })).body.recipients, 2, 'one center');
    assert.equal((await api('/api/admin/broadcasts/preview', ADMIN, { method: 'POST', body: JSON.stringify({ audience: 'center', tenantId: 'tenant_nowhere' }) })).status, 422);

    const sent = await api('/api/admin/broadcasts', ADMIN, { method: 'POST', body: JSON.stringify({ kind: 'update', title: 'Напоминания о записях', body: 'Теперь DetailFlow напоминает о записях.', audience: 'all' }) });
    assert.equal(sent.status, 201);
    assert.equal(sent.body.recipients, 3);
    const owner = (await api('/api/notifications', 'owner-token')).body;
    assert.equal(owner.items[0].title, 'Обновление DetailFlow: Напоминания о записях');
    assert.equal(owner.items[0].kind, 'broadcast');
    assert.equal((await api('/api/notifications', 'intake-token')).body.items.length, 0, 'news turned off');

    await api('/api/notifications/read', 'owner-token', { method: 'POST', body: JSON.stringify({ all: true }) });
    const [listed] = (await api('/api/admin/broadcasts', ADMIN)).body.items;
    assert.deepEqual([listed.kind, listed.sent, listed.read, listed.answers], ['update', 3, 1, 0]);
  } finally {
    await stop();
  }
});

test('a survey is answered once from the feed; results show the shares and the center, not the person', async () => {
  const { api, stop } = await start();
  try {
    assert.equal((await api('/api/admin/broadcasts', ADMIN, { method: 'POST', body: JSON.stringify({ kind: 'survey', title: 'Опрос', audience: 'all', survey: { options: ['Одна'] } }) })).status, 422, 'one option is not a choice');
    const sent = await api('/api/admin/broadcasts', ADMIN, { method: 'POST', body: JSON.stringify({
      kind: 'survey', title: 'Удобно ли записывать клиентов?', body: 'Ответ займёт 10 секунд.', audience: 'all',
      survey: { options: ['Удобно', 'Нормально', 'Неудобно'], rating: true, comment: true }
    }) });
    const id = sent.body.id;
    const [card] = (await api('/api/notifications', 'master-token')).body.items;
    assert.deepEqual(card.survey, { options: ['Удобно', 'Нормально', 'Неудобно'], rating: true, comment: true });
    assert.equal(card.answered, false);

    const answer = (token, body) => api(`/api/notifications/surveys/${id}/answer`, token, { method: 'POST', body: JSON.stringify(body) });
    assert.equal((await answer('master-token', {})).status, 422, 'an empty answer');
    assert.equal((await answer('master-token', { option: 7 })).status, 422);
    assert.equal((await answer('master-token', { option: 0, rating: 5, comment: 'Быстро и понятно' })).status, 201);
    assert.equal((await answer('master-token', { option: 2 })).status, 409, 'one answer per person');
    assert.equal((await answer('owner-token', { option: 1, rating: 4 })).status, 201);
    assert.equal((await api('/api/notifications', 'master-token')).body.items[0].answered, true);
    assert.equal((await api(`/api/notifications/surveys/bc_other/answer`, 'master-token', { method: 'POST', body: JSON.stringify({ option: 0 }) })).status, 404);

    const results = (await api(`/api/admin/broadcasts/${id}`, ADMIN)).body;
    assert.equal(results.answers, 2);
    assert.deepEqual(results.options.map((option) => option.count), [1, 1, 0]);
    assert.equal(results.averageRating, 4.5);
    assert.deepEqual(results.comments.map((comment) => [comment.text, comment.center]), [['Быстро и понятно', 'DetailFlow Studio']]);
    assert.doesNotMatch(JSON.stringify(results), /Дмитрий|Соколов|member_/, 'no person in the results');
  } finally {
    await stop();
  }
});
