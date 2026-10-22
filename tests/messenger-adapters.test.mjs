import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramAdapter, normalizeTelegramUpdate } from '../server/messenger/telegram.mjs';
import { createMaxAdapter, normalizeMaxUpdate } from '../server/messenger/max.mjs';

test('telegram updates normalize to start, text and callback events; group chats are ignored', () => {
  const from = { id: 42, first_name: 'Анна', last_name: 'Смирнова' };
  assert.deepEqual(normalizeTelegramUpdate({ message: { from, chat: { type: 'private' }, text: '/start login_abc' } }),
    { provider: 'telegram', userId: '42', displayName: 'Анна Смирнова', kind: 'start', payload: 'login_abc' });
  assert.equal(normalizeTelegramUpdate({ message: { from, chat: { type: 'private' }, text: '/start' } }).payload, null);
  assert.equal(normalizeTelegramUpdate({ message: { from, chat: { type: 'private' }, text: ' K7M2PQ ' } }).text, 'K7M2PQ');
  assert.equal(normalizeTelegramUpdate({ message: { from, chat: { type: 'group' }, text: '/start x' } }), null);
  assert.deepEqual(normalizeTelegramUpdate({ callback_query: { id: 'q1', from, data: 'login_ok:x' } }),
    { provider: 'telegram', kind: 'callback', userId: '42', displayName: 'Анна Смирнова', payload: 'login_ok:x', callbackId: 'q1' });
});

test('MAX updates normalize bot_started payloads, /start text and callbacks', () => {
  assert.deepEqual(normalizeMaxUpdate({ update_type: 'bot_started', user: { user_id: 900, name: 'Дмитрий' }, payload: 'login_abc' }),
    { provider: 'max', kind: 'start', userId: '900', displayName: 'Дмитрий', payload: 'login_abc' });
  assert.equal(normalizeMaxUpdate({ update_type: 'message_created', message: { sender: { user_id: 900, name: 'Д' }, body: { text: '/start invite_x' } } }).payload, 'invite_x');
  assert.equal(normalizeMaxUpdate({ update_type: 'message_created', message: { sender: { user_id: 900, is_bot: true }, body: { text: 'hi' } } }), null);
  assert.deepEqual(normalizeMaxUpdate({ update_type: 'message_callback', callback: { callback_id: 'c9', payload: 'login_no:y', user: { user_id: 900, name: 'Д' } } }),
    { provider: 'max', kind: 'callback', userId: '900', displayName: 'Д', payload: 'login_no:y', callbackId: 'c9' });
});

function recordingFetch(responder) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const count = calls.length;
    // Real network calls are macrotasks; without this the polling loop would starve timers.
    await new Promise((resolve) => setTimeout(resolve, 2));
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return { ok: true, status: 200, json: async () => responder(url, count) };
  };
  return { calls, fetchImpl };
}

test('telegram adapter polls with an advancing offset and sends inline keyboards', async () => {
  const events = [];
  const { calls, fetchImpl } = recordingFetch((url, count) => {
    if (url.endsWith('/getMe')) return { ok: true, result: { username: 'df_bot' } };
    if (url.endsWith('/getUpdates') && count === 2) return { ok: true, result: [{ update_id: 10, message: { from: { id: 1 }, chat: { type: 'private' }, text: '/start login_z' } }] };
    if (url.endsWith('/getUpdates')) return { ok: true, result: [] };
    return { ok: true, result: true };
  });
  const adapter = createTelegramAdapter({ token: 'T', fetchImpl, apiBase: 'https://tg.test' });
  await adapter.start(async (event) => { events.push(event); });
  await new Promise((resolve) => setTimeout(resolve, 20));
  adapter.stop();
  assert.equal(adapter.botName, 'df_bot');
  assert.equal(adapter.deepLink('login_z'), 'https://t.me/df_bot?start=login_z');
  assert.equal(events[0].payload, 'login_z');
  const polls = calls.filter((call) => call.url.endsWith('/getUpdates'));
  assert.equal(polls[0].body.offset, 0);
  assert.equal(polls[1].body.offset, 11);
  assert.ok(calls[0].url.startsWith('https://tg.test/botT/'));

  await adapter.sendMessage('1', 'Привет', [[{ text: 'Войти', payload: 'login_ok:x' }]]);
  const sent = calls.at(-1);
  assert.ok(sent.url.endsWith('/sendMessage'));
  assert.deepEqual(sent.body, { chat_id: '1', text: 'Привет', reply_markup: { inline_keyboard: [[{ text: 'Войти', callback_data: 'login_ok:x' }]] } });
});

test('MAX adapter authenticates with the Authorization header and sends callback keyboards', async () => {
  const { calls, fetchImpl } = recordingFetch((url) => url.includes('/me') ? { user_id: 1, username: 'df_max_bot' } : url.includes('/updates') ? { updates: [], marker: 5 } : {});
  const adapter = createMaxAdapter({ token: 'M', fetchImpl, apiBase: 'https://max.test' });
  await adapter.start(async () => {});
  await new Promise((resolve) => setTimeout(resolve, 20));
  adapter.stop();
  assert.equal(calls[0].init.headers.authorization, 'M');
  assert.equal(adapter.deepLink('login_z'), 'https://max.ru/df_max_bot?start=login_z');
  const secondPoll = calls.filter((call) => call.url.includes('/updates'))[1];
  assert.match(secondPoll.url, /marker=5/);

  await adapter.sendMessage('77', 'Код', [[{ text: 'Войти', payload: 'login_ok:x' }]]);
  const sent = calls.at(-1);
  assert.equal(sent.url, 'https://max.test/messages?user_id=77');
  assert.deepEqual(sent.body.attachments, [{ type: 'inline_keyboard', payload: { buttons: [[{ type: 'callback', text: 'Войти', payload: 'login_ok:x' }]] } }]);
  await adapter.answerCallback('c1', 'Готово');
  assert.equal(calls.at(-1).url, 'https://max.test/answers?callback_id=c1');
  assert.deepEqual(calls.at(-1).body, { notification: 'Готово' });
});

test('a bot that cannot start (no network yet after a reboot) is tried again until it is ready', async () => {
  const { createDetailFlowServer } = await import('../server/app.mjs');
  let attempts = 0;
  const flaky = {
    provider: 'telegram', title: 'Telegram', botName: 'detailflow_bot', deepLink: () => null,
    async start() { attempts += 1; if (attempts < 3) throw new Error('fetch failed'); },
    stop() {}, async sendMessage() {}, async answerCallback() {}
  };
  const errors = console.error;
  console.error = () => {};
  const server = createDetailFlowServer({ databasePath: ':memory:', seed: true, messengers: [flaky], botRetryMs: 20 });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    const ready = async () => (await (await fetch(`http://127.0.0.1:${server.address().port}/api/ready`)).json()).messengers.telegram;
    assert.equal(await ready(), 'unavailable');
    for (let wait = 0; wait < 50 && await ready() !== 'ready'; wait += 1) await new Promise((done) => setTimeout(done, 20));
    assert.equal(await ready(), 'ready');
    assert.equal(attempts, 3);
  } finally {
    console.error = errors;
    await new Promise((done) => server.close(done));
  }
});
