// MAX Bot API adapter (https://dev.max.ru/docs-api). Long polling via GET /updates with a
// marker; the token goes in the Authorization header. Deep links: https://max.ru/<bot>?start=<payload>.
// Field names follow the public OpenAPI schema (max-messenger/api-schema); verify against a live
// bot before production, because the official docs do not describe every field in prose.

function displayNameOf(user) {
  return user?.name || [user?.first_name, user?.last_name].filter(Boolean).join(' ') || user?.username || null;
}

/** Converts a MAX update into the provider-neutral event used by MessengerAuth. */
export function normalizeMaxUpdate(update) {
  if (update?.update_type === 'bot_started' && update.user?.user_id !== undefined) {
    return {
      provider: 'max', kind: 'start', userId: String(update.user.user_id), displayName: displayNameOf(update.user),
      payload: typeof update.payload === 'string' && update.payload ? update.payload : null
    };
  }
  if (update?.update_type === 'message_created') {
    const sender = update.message?.sender;
    const text = update.message?.body?.text;
    if (sender?.user_id === undefined || typeof text !== 'string' || sender.is_bot) return null;
    const base = { provider: 'max', userId: String(sender.user_id), displayName: displayNameOf(sender) };
    const start = /^\/start(?:\s+(\S+))?$/.exec(text.trim());
    return start ? { ...base, kind: 'start', payload: start[1] ?? null } : { ...base, kind: 'text', text: text.trim() };
  }
  if (update?.update_type === 'message_callback' && update.callback?.user?.user_id !== undefined) {
    return {
      provider: 'max', kind: 'callback', userId: String(update.callback.user.user_id), displayName: displayNameOf(update.callback.user),
      payload: typeof update.callback.payload === 'string' ? update.callback.payload : '', callbackId: update.callback.callback_id
    };
  }
  return null;
}

export function createMaxAdapter({ token, fetchImpl = fetch, apiBase = 'https://platform-api2.max.ru', logger = console, retryDelayMs = 3000 }) {
  let botName = null;
  let running = false;
  let controller = null;
  let marker = null;

  async function call(method, path, { query = {}, body, signal } = {}) {
    const search = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== null && value !== undefined).map(([key, value]) => [key, String(value)]));
    const response = await fetchImpl(`${apiBase}${path}${search.size ? `?${search}` : ''}`, {
      method,
      headers: { authorization: token, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal
    });
    if (!response.ok) throw new Error(`max ${method} ${path} failed: ${response.status}`);
    return response.json();
  }

  async function loop(onEvent) {
    while (running) {
      try {
        const result = await call('GET', '/updates', {
          query: { timeout: 25, marker, types: 'bot_started,message_created,message_callback' },
          signal: controller.signal
        });
        if (result.marker !== undefined && result.marker !== null) marker = result.marker;
        for (const update of result.updates ?? []) {
          const event = normalizeMaxUpdate(update);
          if (event) await onEvent(event).catch((error) => logger.error('max event failed', error));
        }
      } catch (error) {
        if (!running) return;
        logger.error('max polling failed', error.message);
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }

  return {
    provider: 'max',
    title: 'MAX',
    get botName() { return botName; },
    deepLink: (payload) => botName ? `https://max.ru/${botName}?start=${payload}` : null,
    async start(onEvent) {
      controller = new AbortController();
      const me = await call('GET', '/me', { signal: controller.signal });
      botName = me.username ?? null;
      running = true;
      void loop(onEvent);
    },
    stop() {
      running = false;
      controller?.abort();
    },
    async sendMessage(userId, text, buttons) {
      await call('POST', '/messages', {
        query: { user_id: userId },
        body: {
          text,
          ...(buttons ? { attachments: [{ type: 'inline_keyboard', payload: { buttons: buttons.map((row) => row.map((button) => ({ type: 'callback', text: button.text, payload: button.payload }))) } }] } : {})
        }
      });
    },
    async answerCallback(callbackId, text) {
      await call('POST', '/answers', { query: { callback_id: callbackId }, body: { notification: text } });
    }
  };
}
