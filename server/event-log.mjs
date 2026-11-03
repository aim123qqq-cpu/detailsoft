// The service owner's live journal (/admin → «Журнал»): what happens on the server, each entry with a plain
// explanation of what it means and what to do. Kept in memory only (the last entries, gone on restart):
// the system journal on the server stays the full record.
//
// No personal data and no secrets go in: messenger ids and addresses are masked, bot tokens and
// session tokens are cut out of every text, sign-in codes are never written.

const LIMIT = 1000;

/** Explanations for the server's own messages (console), matched by text. The first match wins. */
const CONSOLE_MEANINGS = [
  [/(telegram|max) bot is unavailable/i, 'warn', 'Бот не подключается',
    'Сервер не достучался до мессенджера — вход через этот бот сейчас не работает. Сервер повторяет попытку сам. Если это дольше 10 минут — проверьте VPN/прокси на сервере и токен бота в .env.'],
  [/(telegram|max) polling failed/i, 'warn', 'Связь с мессенджером прервалась',
    'Бот на секунду потерял связь с Telegram/MAX. Обычно восстанавливается сам за несколько секунд; если повторяется постоянно — проблема с сетью или прокси сервера.'],
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

export function createEventLog({ limit = LIMIT, now = () => new Date() } = {}) {
  const items = [];
  let seq = 0;
  return {
    /** level: info | warn | error. `meaning` is the explanation shown under the title. */
    add({ level = 'info', kind, title, meaning = '', detail = '' }) {
      seq += 1;
      items.push({ seq, at: now().toISOString(), level, kind, title, meaning, detail: redact(detail) });
      if (items.length > limit) items.splice(0, items.length - limit);
    },
    since(after = 0, max = 300) {
      const fresh = items.filter((item) => item.seq > after);
      return { items: fresh.slice(-max), last: seq };
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
