// Messages to the owner of the DetailFlow service through the bots: a new center, a bot or the server
// in trouble, a failed backup, and a short summary every morning. Counts only, no customer data.
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { systemHealth } from './platform-stats.mjs';

const MINUTE = 60_000;
const formatBytes = (bytes) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} ГБ` : `${Math.round(bytes / 1024 ** 2)} МБ`;

/** Moscow date and hour, for the morning summary. */
const moscow = (date = new Date()) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(date).map((part) => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
};

export function createAdminNotifier({ db, auth, adapters, readyProviders, botDownSince, metrics, databasePath, backupDirectory, summaryHour = 9 }) {
  const lastSent = new Map();
  let overloadedMinutes = 0;
  let summaryDay = null;

  /** Sends to every admin account whose bot is up; the same alert (key) at most once an hour. */
  async function notify(text, key = null) {
    if (key) {
      if (Date.now() - (lastSent.get(key) ?? 0) < 60 * MINUTE) return;
      lastSent.set(key, Date.now());
    }
    for (const admin of auth.listPlatformAdmins()) {
      const adapter = adapters.get(admin.provider);
      if (!adapter || !readyProviders.has(admin.provider)) continue;
      await adapter.sendMessage(admin.externalUserId, text).catch((error) => console.error('admin notification failed:', error.message));
    }
  }

  function summary() {
    const one = (sql) => db.prepare(sql).get().count;
    const day = "datetime('now', '-1 day')";
    const health = systemHealth({ databasePath, backupDirectory });
    const lines = [
      'DetailFlow · сводка за сутки',
      `Центров: ${one('SELECT COUNT(*) AS count FROM tenants')} (новых: ${one(`SELECT COUNT(*) AS count FROM center_signups WHERE created_at > ${day}`)})`,
      `Входов: ${one(`SELECT COUNT(*) AS count FROM auth_sessions WHERE created_at > ${day}`)}`,
      `Записей: ${one(`SELECT COUNT(*) AS count FROM bookings WHERE created_at > ${day}`)} · заказов: ${one(`SELECT COUNT(*) AS count FROM orders WHERE created_at > ${day}`)} · актов: ${one(`SELECT COUNT(*) AS count FROM order_documents WHERE created_at > ${day}`)}`,
      `Сервер: нагрузка ${health.loadAverage[0].toFixed(2)} на ${health.cpuCount} ядр., свободно памяти ${formatBytes(health.memory.freeBytes)}${health.disk ? `, диска ${formatBytes(health.disk.freeBytes)}` : ''}`,
      `Резервных копий: ${health.backups.count}${health.backups.latestAt ? `, последняя ${new Date(health.backups.latestAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}` : ''}`
    ];
    return lines.join('\n');
  }

  /** Runs every minute: overload, low disk or memory, a bot down for 10 minutes, errors, the summary. */
  async function check() {
    const load = loadavg()[0] / cpus().length;
    overloadedMinutes = load > 1.5 ? overloadedMinutes + 1 : 0;
    if (overloadedMinutes >= 5) await notify(`⚠️ DetailFlow: сервер перегружен 5 минут подряд (нагрузка ${loadavg()[0].toFixed(2)} на ${cpus().length} ядр.)`, 'load');
    if (freemem() / totalmem() < 0.05) await notify(`⚠️ DetailFlow: осталось мало памяти — ${formatBytes(freemem())}`, 'memory');
    const disk = systemHealth({ databasePath, backupDirectory }).disk;
    if (disk && disk.freeBytes / disk.totalBytes < 0.1) await notify(`⚠️ DetailFlow: на диске меньше 10% места — свободно ${formatBytes(disk.freeBytes)}`, 'disk');
    for (const [provider, since] of botDownSince) {
      if (Date.now() - since > 10 * MINUTE) await notify(`⚠️ DetailFlow: бот ${provider === 'max' ? 'MAX' : 'Telegram'} недоступен больше 10 минут — вход через него не работает`, `bot-${provider}`);
    }
    const errors = metrics.lastHour().slice(-5).reduce((sum, minute) => sum + minute.errors, 0);
    if (errors >= 20) await notify(`⚠️ DetailFlow: ${errors} ошибок сервера за 5 минут`, 'errors');
    const now = moscow();
    if (now.hour === summaryHour && summaryDay !== now.day) {
      summaryDay = now.day;
      await notify(summary());
    }
  }

  return { notify, check, summary };
}
