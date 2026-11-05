// The service owner's live journal (/admin → «Журнал»): what people do and what happens on the server, each
// entry with a plain explanation of what it means and what to do. Kept in the database for 90 days.
//
// No names, no customers' data and no secrets go in: people are a role and a short tag, messenger ids and
// addresses are masked, bot tokens and session tokens are cut out of every text, sign-in codes are never written.

import { DatabaseSync } from 'node:sqlite';

const LIMIT = 1000;

/** Explanations for the server's own messages (console), matched by text. The first match wins. */
const CONSOLE_MEANINGS = [
  [/(telegram|max) bot is unavailable/i, 'warn', 'Бот не подключается',
    'Сервер не достучался до мессенджера — вход через этот бот сейчас не работает. Сервер повторяет попытку сам. Если это дольше 10 минут — проверьте VPN/прокси на сервере и токен бота в .env.'],
  [/(telegram|max) polling conflict/i, 'error', 'Бот запущен в двух местах',
    'С этим токеном работает ещё одна копия бота, например на другом компьютере или старом сервере. Копии перехватывают сообщения друг у друга, и люди могут не дождаться ответа при входе. Остановите лишнюю копию.'],
  [/(telegram|max) polling refused/i, 'error', 'Мессенджер отказал боту',
    'Telegram/MAX не принимает токен бота. Пока это не исправить, вход через этого бота не работает. Проверьте токен в .env.'],
  [/(telegram|max) polling failed/i, 'error', 'Нет связи с мессенджером',
    'Сервер больше минуты не может достучаться до Telegram/MAX. Вход через этого бота пока не предлагается, сообщения дойдут после восстановления. Сервер повторяет попытки сам; если это надолго, проверьте сеть и прокси сервера.'],
  [/(telegram|max) polling recovered/i, 'info', 'Связь с мессенджером восстановилась',
    'Бот снова на связи и получил сообщения, накопившиеся за время обрыва.'],
  [/(telegram|max) polling had \d+ short breaks/i, 'info', 'Короткие обрывы связи с мессенджером',
    'Бот сам переподключился, сообщения не потерялись. Сводка за последний час. Делать ничего не нужно, если число не растёт изо дня в день; иначе проверьте сеть и прокси сервера.'],
  [/(telegram|max) event failed|bot dialog failed/i, 'error', 'Бот не смог ответить',
    'Сообщение человеку от бота не обработалось. Человек мог не получить ответ — пусть попробует ещё раз. Если повторяется, пришлите этот текст разработчику.'],
  [/SMTP (greeting|EHLO): (no answer|connect|.*ETIMEDOUT|.*ECONNREFUSED)/i, 'error', 'Почтовый сервер не отвечает',
    'Письмо с кодом не ушло: исходящий порт 465 закрыт или почтовый сервер недоступен. Проверьте, не блокирует ли хостинг SMTP (у Timeweb открывается через поддержку).'],
  [/SMTP AUTH( user| password)?: \d{3}/i, 'error', 'Почта не приняла пароль',
    'Письмо с кодом не ушло: неверный SMTP_USER или SMTP_PASSWORD. Для mail.ru нужен «пароль для внешних приложений», а не обычный пароль.'],
  [/SMTP RCPT TO/i, 'warn', 'Почта не приняла адрес получателя',
    'Такого адреса, скорее всего, нет — человек ошибся в email. Пусть проверит адрес.'],
  [/Sign-in letter was not sent/i, 'error', 'Письмо с кодом не отправлено',
    'Человек не получит код для входа по email. Проверьте настройки SMTP в .env и подробность ниже.'],
  [/Scheduled backup failed/i, 'error', 'Резервная копия не создалась',
    'Ежедневная копия базы не сохранилась. Проверьте место на диске и права на папку резервных копий.'],
  [/Scheduled backup:|Backup before start:/i, 'info', 'Резервная копия создана', 'Копия базы сохранена — всё в порядке.'],
  [/web push (failed|answered)/i, 'warn', 'Уведомление на устройство не доставлено',
    'Push-сервис браузера отказал или недоступен. Обычно человек отключил уведомления или удалил приложение — подписка удалится сама.'],
  [/notification via (telegram|max) failed/i, 'warn', 'Напоминание в мессенджер не доставлено',
    'Человек, возможно, заблокировал бота. Остальные уведомления это не затрагивает.'],
  [/admin notification failed/i, 'warn', 'Сообщение владельцу сервиса не ушло', 'Бот не смог прислать вам оповещение. Проверьте, что бот работает.'],
  [/Health check failed|Reminders failed|Purging expired/i, 'error', 'Фоновая задача упала',
    'Плановая проверка сервера (здоровье, напоминания или очистка старых данных) завершилась ошибкой. Сервер работает дальше; если повторяется каждую минуту — пришлите текст разработчику.'],
  [/idempotency store failed/i, 'error', 'Ошибка защиты от повторных запросов', 'Редкая ошибка базы данных. Если повторяется — пришлите текст разработчику.'],
  [/DetailFlow is running/i, 'info', 'Сервер запущен', 'DetailFlow запустился и принимает запросы — например, после обновления.'],
  [/received, stopping DetailFlow/i, 'info', 'Сервер останавливается', 'Плановая остановка — обычно перед обновлением. Через несколько секунд сервер запустится снова.'],
  [/Messenger sign-in:/i, 'info', 'Боты подключены', 'Список мессенджеров, через которые работает вход.']
];

/** Bot tokens, session and admin tokens, long secrets: never shown, even to the owner. */
export function redact(text) {
  return String(text ?? '')
    .replace(/bot\d{5,}:[\w-]{20,}/g, 'bot<токен>')
    .replace(/\b(dfs|dfa)_[0-9a-f]{16,}/g, '$1_<токен>')
    .replace(/\b[0-9a-f]{32,}\b/g, '<секрет>')
    .slice(0, 2000);
}

/** «…4567» for a messenger account, «ni***@mail.ru» for an address: enough to tell attempts apart. */
export function maskAccount(provider, externalUserId) {
  const value = String(externalUserId ?? '');
  if (provider === 'email') {
    const [name, domain] = value.split('@');
    return domain ? `${name.slice(0, 2)}***@${domain}` : '***';
  }
  return value.length > 4 ? `…${value.slice(-4)}` : '…';
}

export const PROVIDER_TITLES = { telegram: 'Telegram', max: 'MAX', email: 'email' };

const ROLE_TITLES = { owner: 'Владелец', admin: 'Администратор', intake: 'Приёмщик', master: 'Мастер', qc: 'Контроль качества' };

/** «Мастер #a1b2»: who acted, enough to tell people apart, without a name. */
export function actorTag(roles, memberId) {
  // The senior role of several: an owner is usually an administrator too.
  const held = Array.isArray(roles) ? roles : [];
  const role = Object.entries(ROLE_TITLES).find(([name]) => held.includes(name))?.[1] ?? 'Сотрудник';
  return memberId ? `${role} #${String(memberId).slice(-4)}` : role;
}

const TABLE = `CREATE TABLE IF NOT EXISTS platform_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, level TEXT NOT NULL,
  kind TEXT NOT NULL, title TEXT NOT NULL, meaning TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', tenant_id TEXT, actor TEXT)`;

/**
 * Starts in its own memory (the server's first messages come before the database opens), moves to the
 * main database on attach(), so the journal survives restarts and updates. A failure here never reaches a request.
 */
export function createEventLog({ limit = LIMIT, now = () => new Date() } = {}) {
  let store = new DatabaseSync(':memory:');
  store.exec(TABLE);
  let attached = false;
  const insert = (target, item) => target.prepare(`INSERT INTO platform_events (at, level, kind, title, meaning, detail, tenant_id, actor)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(item.at, item.level, item.kind, item.title, item.meaning, item.detail, item.tenant_id, item.actor);
  return {
    /** level: info | warn | error. `meaning` is the explanation shown under the title. */
    add({ level = 'info', kind, title, meaning = '', detail = '', tenantId = null, actor = null }) {
      try {
        insert(store, { at: now().toISOString(), level, kind, title, meaning, detail: redact(detail), tenant_id: tenantId, actor });
        if (!attached) store.prepare('DELETE FROM platform_events WHERE seq <= (SELECT MAX(seq) FROM platform_events) - ?').run(limit);
      } catch { /* the journal never breaks the work */ }
    },
    attach(db) {
      for (const item of store.prepare('SELECT * FROM platform_events ORDER BY seq').all()) insert(db, item);
      store.close();
      store = db;
      attached = true;
    },
    /** Back to memory when the database closes: the last messages of a stopping server have nowhere else to go. */
    detach() {
      if (!attached) return;
      attached = false;
      store = new DatabaseSync(':memory:');
      store.exec(TABLE);
    },
    /** Newest `max` entries that fit, oldest first. `after` asks for what is new, `before` for older pages. */
    query({ after = 0, before = 0, max = 300, levels = [], kinds = [], tenantId = '', search = '' } = {}) {
      const where = ['e.seq > ?']; const params = [after];
      const anyOf = (column, values) => { where.push(`${column} IN (${values.map(() => '?').join(', ')})`); params.push(...values); };
      if (before) { where.push('e.seq < ?'); params.push(before); }
      if (levels.length) anyOf('e.level', levels);
      if (kinds.length) anyOf('e.kind', kinds);
      if (tenantId) { where.push('e.tenant_id = ?'); params.push(tenantId); }
      if (search) {
        where.push("(e.title LIKE ? ESCAPE '!' OR e.meaning LIKE ? ESCAPE '!' OR e.detail LIKE ? ESCAPE '!' OR e.actor LIKE ? ESCAPE '!')");
        const like = `%${String(search).replace(/[!%_]/g, '!$&')}%`;
        params.push(like, like, like, like);
      }
      // The center's current name, so a renamed center reads the same through its whole history.
      const center = attached ? '(SELECT name FROM tenants t WHERE t.id = e.tenant_id)' : 'NULL';
      const rows = store.prepare(`SELECT e.seq, e.at, e.level, e.kind, e.title, e.meaning, e.detail, e.tenant_id AS tenantId, e.actor, ${center} AS center
        FROM platform_events e WHERE ${where.join(' AND ')} ORDER BY e.seq DESC LIMIT ?`).all(...params, Math.min(max + 1, 1001));
      const more = rows.length > max;
      return { items: rows.slice(0, max).reverse().map((row) => ({ ...row })), last: store.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM platform_events').get().seq, more };
    },
    since(after = 0, max = 300) { return this.query({ after, max }); },
    purge(days = 90) {
      try { store.prepare('DELETE FROM platform_events WHERE at < ?').run(new Date(now().getTime() - days * 86_400_000).toISOString()); } catch { /* next hour */ }
    }
  };
}

/** Copies the server's console output into the journal, with an explanation where the message is known. */
export function captureConsole(events, target = console) {
  for (const [method, fallback] of [['log', 'info'], ['warn', 'warn'], ['error', 'error']]) {
    const original = target[method].bind(target);
    target[method] = (...args) => {
      original(...args);
      try {
        const text = args.map((arg) => arg instanceof Error ? (arg.stack ?? arg.message) : typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ');
        const known = CONSOLE_MEANINGS.find(([pattern]) => pattern.test(text));
        events.add(known
          ? { level: known[1], kind: 'server', title: known[2], meaning: known[3], detail: text }
          : { level: fallback, kind: 'server', title: fallback === 'error' ? 'Ошибка сервера' : 'Сообщение сервера',
            meaning: fallback === 'error' ? 'Непредвиденная ошибка. Если повторяется — пришлите этот текст разработчику.' : 'Техническое сообщение сервера.', detail: text });
      } catch { /* the journal never breaks logging */ }
    };
  }
}
