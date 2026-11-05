import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramAdapter, normalizeTelegramUpdate } from '../server/messenger/telegram.mjs';
import { createMaxAdapter, normalizeMaxUpdate } from '../server/messenger/max.mjs';
import { createPollWatch, sendWithRetry } from '../server/messenger/resilience.mjs';
import { captureConsole, createEventLog } from '../server/event-log.mjs';

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

/** A logger that remembers, and a clock the test moves by hand. */
function watchRig(options = {}) {
  const lines = [];
  const clock = { now: 1_000_000 };
  const logger = { error: (...args) => lines.push(args.join(' ')), log: (...args) => lines.push(args.join(' ')) };
  const events = [];
  const watch = createPollWatch({ provider: 'telegram', logger, now: () => clock.now, onDown: (why) => events.push(`down: ${why}`), onUp: () => events.push('up'), ...options });
  return { lines, clock, events, watch };
}
const broken = (message = 'fetch failed', status) => Object.assign(new Error(message), { ...(status ? { status } : {}), cause: status ? undefined : { code: 'ECONNRESET' } });

test('a short break in polling is retried quietly, and only a summary reaches the journal', () => {
  const { lines, clock, events, watch } = watchRig({ summaryMs: 3_600_000 });
  assert.deepEqual([watch.failed(broken()), watch.failed(broken()), watch.failed(broken())], [1000, 2000, 5000], 'the wait grows');
  clock.now += 10_000;
  watch.ok();
  assert.deepEqual(lines, [], 'nothing to tell about a break of a few seconds');
  assert.deepEqual(events, []);
  assert.equal(watch.failed(broken()), 1000, 'a new break starts from the short wait again');
  watch.ok();
  clock.now += 3_600_000;
  watch.ok();
  assert.deepEqual(lines, ['telegram polling had 2 short breaks, last: fetch failed (ECONNRESET)']);
});

test('a long outage is told once, marks the bot down, and its end is told too', () => {
  const { lines, clock, events, watch } = watchRig();
  watch.failed(broken());
  clock.now += 61_000;
  watch.failed(broken());
  clock.now += 30_000;
  watch.failed(broken());
  assert.deepEqual(lines, ['telegram polling failed for 61 s: fetch failed (ECONNRESET)'], 'not on every retry');
  assert.deepEqual(events, ['down: fetch failed (ECONNRESET)']);
  clock.now += 10 * 60_000;
  watch.failed(broken());
  assert.equal(lines.length, 2, 'reminded every 10 minutes');
  watch.ok();
  assert.match(lines.at(-1), /^telegram polling recovered after \d+ s$/);
  assert.deepEqual(events.at(-1), 'up');
});

test('a second copy of the bot and a refused token are told apart from a bad network', () => {
  const conflict = watchRig();
  for (let at = 0; at < 2; at += 1) { conflict.watch.failed(broken('Conflict', 409)); conflict.watch.ok(); }
  assert.deepEqual(conflict.lines.filter((line) => line.includes('conflict')), [], 'one or two can be a restart overlapping');
  conflict.watch.failed(broken('Conflict: terminated by other getUpdates request', 409));
  assert.match(conflict.lines.find((line) => line.includes('conflict')), /^telegram polling conflict:/, 'counted though successes come between');
  const refused = watchRig();
  refused.watch.failed(broken('Unauthorized', 401));
  assert.deepEqual(refused.lines, ['telegram polling refused: Unauthorized'], 'at once: waiting will not help');
  assert.equal(watchRig().watch.failed(Object.assign(broken('Too Many Requests', 429), { retryAfter: 7 })), 7000, 'the messenger says how long to wait');
});

test('a send is repeated over a break, but not when the messenger refused', async () => {
  let attempts = 0;
  assert.equal(await sendWithRetry(async () => { attempts += 1; if (attempts < 3) throw broken(); return 'sent'; }, [1, 1]), 'sent');
  assert.equal(attempts, 3);
  attempts = 0;
  await assert.rejects(sendWithRetry(async () => { attempts += 1; throw broken('Forbidden: bot was blocked by the user', 403); }, [1, 1]), /blocked/);
  assert.equal(attempts, 1, 'a person who blocked the bot is not asked three times');
  attempts = 0;
  await assert.rejects(sendWithRetry(async () => { attempts += 1; throw broken(); }, [1, 1]), /fetch failed/);
  assert.equal(attempts, 3, 'it gives up in the end');
});

test('the adapters ride out a broken connection: polling and sends go on, a hung poll has an end', async () => {
  let polls = 0;
  let sends = 0;
  const signals = [];
  const fetchImpl = async (url, init) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (url.endsWith('/getMe')) return { ok: true, status: 200, json: async () => ({ ok: true, result: { username: 'df_bot' } }) };
    if (url.endsWith('/getUpdates')) { polls += 1; signals.push(init.signal); if (polls <= 2) throw new TypeError('fetch failed'); return { ok: true, status: 200, json: async () => ({ ok: true, result: [] }) }; }
    sends += 1;
    if (sends === 1) throw new TypeError('fetch failed');
    return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) };
  };
  const lines = [];
  const logger = { error: (...args) => lines.push(args.join(' ')), log: (...args) => lines.push(args.join(' ')) };
  const adapter = createTelegramAdapter({ token: 'T', fetchImpl, apiBase: 'https://tg.test', logger, pollOptions: { delays: [1] }, sendRetryDelays: [1] });
  await adapter.start(async () => {});
  await new Promise((resolve) => setTimeout(resolve, 30));
  await adapter.sendMessage('1', 'Подтвердите вход');
  adapter.stop();
  assert.ok(polls > 2, 'polling went on after the breaks');
  assert.equal(sends, 2, 'the message went out on the second try');
  assert.ok(signals.every((signal) => signal instanceof AbortSignal), 'every poll can be ended');
  assert.deepEqual(lines, [], 'a break this short is not worth an entry');
});

test('a bot that lost the messenger is unavailable until it is back, then available again', async () => {
  const { createDetailFlowServer } = await import('../server/app.mjs');
  let line = null;
  const adapter = {
    provider: 'telegram', title: 'Telegram', botName: 'detailflow_bot', deepLink: () => null,
    async start(onEvent, hooks) { line = hooks; },
    stop() {}, async sendMessage() {}, async answerCallback() {}
  };
  const server = createDetailFlowServer({ databasePath: ':memory:', seed: true, messengers: [adapter] });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    const ready = async () => (await (await fetch(`http://127.0.0.1:${server.address().port}/api/ready`)).json()).messengers.telegram;
    for (let wait = 0; wait < 50 && await ready() !== 'ready'; wait += 1) await new Promise((done) => setTimeout(done, 10));
    assert.equal(await ready(), 'ready');
    line.onDown('fetch failed (ECONNRESET)');
    assert.equal(await ready(), 'unavailable');
    const providers = await (await fetch(`http://127.0.0.1:${server.address().port}/api/auth/providers`)).json();
    assert.deepEqual(providers.items, [], 'sign-in does not offer a bot that cannot hear');
    line.onUp();
    assert.equal(await ready(), 'ready');
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test('the journal explains each case in its own words', () => {
  const events = createEventLog();
  const target = { log() {}, warn() {}, error() {} };
  captureConsole(events, target);
  target.error('telegram polling failed for 61 s:', 'fetch failed');
  target.error('max polling conflict:', 'Conflict');
  target.log('telegram polling had 12 short breaks, last: fetch failed');
  target.log('telegram polling recovered after 90 s');
  assert.deepEqual(events.since(0).items.map((item) => [item.level, item.title]), [
    ['error', 'Нет связи с мессенджером'], ['error', 'Бот запущен в двух местах'],
    ['info', 'Короткие обрывы связи с мессенджером'], ['info', 'Связь с мессенджером восстановилась']
  ]);
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
