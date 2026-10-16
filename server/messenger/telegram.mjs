// Telegram Bot API adapter. Uses long polling (getUpdates), so the server needs only
// outbound HTTPS access to api.telegram.org — no public domain or webhook.

function displayNameOf(user) {
  return [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || null;
}

/** Converts a Telegram update into the provider-neutral event used by MessengerAuth. */
export function normalizeTelegramUpdate(update) {
  const message = update?.message;
  if (message?.from && message.chat?.type === 'private' && typeof message.text === 'string') {
    const base = { provider: 'telegram', userId: String(message.from.id), displayName: displayNameOf(message.from) };
    const text = message.text.trim();
    const start = /^\/start(?:@\w+)?(?:\s+(\S+))?$/.exec(text);
    return start ? { ...base, kind: 'start', payload: start[1] ?? null } : { ...base, kind: 'text', text };
  }
  const query = update?.callback_query;
  if (query?.from && typeof query.id === 'string') {
    return {
      provider: 'telegram', kind: 'callback', userId: String(query.from.id), displayName: displayNameOf(query.from),
      payload: typeof query.data === 'string' ? query.data : '', callbackId: query.id
    };
  }
  return null;
}

export function createTelegramAdapter({ token, fetchImpl = fetch, apiBase = 'https://api.telegram.org', logger = console, retryDelayMs = 3000 }) {
  let botName = null;
  let running = false;
  let controller = null;
  let offset = 0;

  async function call(method, body = {}, signal) {
    const response = await fetchImpl(`${apiBase}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal
    });
    const payload = await response.json();
    if (!payload.ok) throw new Error(`telegram ${method} failed: ${payload.description ?? response.status}`);
    return payload.result;
  }

  async function loop(onEvent) {
    while (running) {
      try {
        const updates = await call('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, controller.signal);
        for (const update of updates) {
          offset = update.update_id + 1;
          const event = normalizeTelegramUpdate(update);
          if (event) await onEvent(event).catch((error) => logger.error('telegram event failed', error));
        }
      } catch (error) {
        if (!running) return;
        logger.error('telegram polling failed', error.message);
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }

  return {
    provider: 'telegram',
    title: 'Telegram',
    get botName() { return botName; },
    deepLink: (payload) => botName ? `https://t.me/${botName}?start=${payload}` : null,
    async start(onEvent) {
      controller = new AbortController();
      const me = await call('getMe', {}, controller.signal);
      botName = me.username;
      running = true;
      void loop(onEvent);
    },
    stop() {
      running = false;
      controller?.abort();
    },
    async sendMessage(userId, text, buttons) {
      await call('sendMessage', {
        chat_id: userId,
        text,
        ...(buttons ? { reply_markup: { inline_keyboard: buttons.map((row) => row.map((button) => ({ text: button.text, callback_data: button.payload }))) } } : {})
      });
    },
    async answerCallback(callbackId, text) {
      await call('answerCallbackQuery', { callback_query_id: callbackId, text });
    }
  };
}
