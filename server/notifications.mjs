// Notifications for the people of a center: the feed in the app, copies through the member's bot, and the
// minute timer that reminds about upcoming bookings and sends the plan of the day as the center chose.
// Texts go to messengers (foreign services among them), so they carry no customers' names or phones:
// time, car model and length only; the details are one tap away in the app.
import { randomUUID } from 'node:crypto';
import { generateVapidKeys, sendWebPush } from './web-push.mjs';

export const REMINDER_BEFORE = [15, 30, 60, 120, 180];
const DEFAULTS = { beforeMinutes: 60, morning: { enabled: true, time: '09:00' }, evening: { enabled: false, time: '19:00' } };
const MEMBER_DEFAULTS = { reminders: true, news: true, viaMessenger: true };
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Local date, time and minutes of the day in a center's time zone. */
function localClock(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(date).map((part) => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

const minutesOf = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const plural = (count, one, few, many) => {
  const mod10 = count % 10;
  const mod100 = count % 100;
  return mod10 === 1 && mod100 !== 11 ? one : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many;
};
const duration = (minutes) => minutes >= 60 ? `${Math.floor(minutes / 60)} ч${minutes % 60 ? ` ${minutes % 60} мин` : ''}` : `${minutes} мин`;
const beforeLabel = (minutes) => minutes >= 60 ? `${minutes / 60} ${plural(minutes / 60, 'час', 'часа', 'часов')}` : `${minutes} минут`;

export function createNotificationCenter({ db, repository, adapters = new Map(), readyProviders = new Set(), now = () => new Date(), pushSender = sendWebPush, pushSubject = 'https://detailflow.ru' }) {
  const sentBefore = (key) => Boolean(db.prepare('SELECT 1 FROM notification_sends WHERE key = ?').get(key));
  const markSent = (key) => db.prepare('INSERT OR IGNORE INTO notification_sends (key) VALUES (?)').run(key);

  /** The VAPID key pair: made once on the first start and kept in the database. */
  function vapidKeys() {
    const stored = db.prepare("SELECT value FROM app_settings WHERE key = 'vapid'").get();
    if (stored) return JSON.parse(stored.value);
    const keys = generateVapidKeys();
    db.prepare("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('vapid', ?)").run(JSON.stringify(keys));
    return JSON.parse(db.prepare("SELECT value FROM app_settings WHERE key = 'vapid'").get().value);
  }

  function subscribePush(tenantId, memberId, input, userAgent = '') {
    const endpoint = String(input?.endpoint ?? '');
    const p256dh = String(input?.keys?.p256dh ?? '');
    const auth = String(input?.keys?.auth ?? '');
    if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !/^[\w-]{80,100}$/.test(p256dh) || !/^[\w-]{16,32}$/.test(auth)) return { kind: 'invalid' };
    db.prepare(`INSERT INTO push_subscriptions (endpoint, tenant_id, member_id, p256dh, auth, user_agent) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET tenant_id = excluded.tenant_id, member_id = excluded.member_id, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`)
      .run(endpoint, tenantId, memberId, p256dh, auth, String(userAgent).slice(0, 200));
    return { kind: 'subscribed' };
  }

  function unsubscribePush(memberId, endpoint) {
    return db.prepare('DELETE FROM push_subscriptions WHERE member_id = ? AND endpoint = ?').run(memberId, String(endpoint ?? '')).changes > 0;
  }

  /** Sends to every device of a member; a subscription the push service no longer knows is removed. */
  async function pushToDevices(memberId, message) {
    for (const subscription of db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE member_id = ?').all(memberId)) {
      try {
        const status = await pushSender(subscription, message, { vapid: vapidKeys(), subject: pushSubject });
        if (status === 404 || status === 410) db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(subscription.endpoint);
        else if (status >= 200 && status < 300) db.prepare('UPDATE push_subscriptions SET last_sent_at = CURRENT_TIMESTAMP WHERE endpoint = ?').run(subscription.endpoint);
        else console.error(`web push answered ${status}`);
      } catch (error) {
        console.error('web push failed:', error.message);
      }
    }
  }

  function reminderSettings(tenantId) {
    const row = db.prepare('SELECT * FROM tenant_reminder_settings WHERE tenant_id = ?').get(tenantId);
    if (!row) return structuredClone(DEFAULTS);
    return {
      beforeMinutes: row.before_minutes,
      morning: { enabled: Boolean(row.morning_enabled), time: row.morning_time },
      evening: { enabled: Boolean(row.evening_enabled), time: row.evening_time }
    };
  }

  function updateReminderSettings(tenantId, input) {
    const beforeMinutes = input?.beforeMinutes === null ? null : Number(input?.beforeMinutes);
    if (beforeMinutes !== null && !REMINDER_BEFORE.includes(beforeMinutes)) return { kind: 'invalid', field: 'beforeMinutes' };
    for (const key of ['morning', 'evening']) {
      if (typeof input?.[key]?.enabled !== 'boolean' || !TIME.test(String(input?.[key]?.time ?? ''))) return { kind: 'invalid', field: key };
    }
    db.prepare(`INSERT INTO tenant_reminder_settings (tenant_id, before_minutes, morning_enabled, morning_time, evening_enabled, evening_time, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(tenant_id) DO UPDATE SET before_minutes = excluded.before_minutes, morning_enabled = excluded.morning_enabled,
        morning_time = excluded.morning_time, evening_enabled = excluded.evening_enabled, evening_time = excluded.evening_time, updated_at = CURRENT_TIMESTAMP`)
      .run(tenantId, beforeMinutes, input.morning.enabled ? 1 : 0, input.morning.time, input.evening.enabled ? 1 : 0, input.evening.time);
    return { kind: 'updated', settings: reminderSettings(tenantId) };
  }

  function memberPrefs(memberId) {
    const row = db.prepare('SELECT reminders, news, via_messenger FROM member_notification_prefs WHERE member_id = ?').get(memberId);
    return row ? { reminders: Boolean(row.reminders), news: Boolean(row.news), viaMessenger: Boolean(row.via_messenger) } : { ...MEMBER_DEFAULTS };
  }

  function updateMemberPrefs(tenantId, memberId, input) {
    const next = { ...memberPrefs(memberId) };
    for (const key of Object.keys(MEMBER_DEFAULTS)) if (typeof input?.[key] === 'boolean') next[key] = input[key];
    db.prepare(`INSERT INTO member_notification_prefs (member_id, tenant_id, reminders, news, via_messenger, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(member_id) DO UPDATE SET reminders = excluded.reminders, news = excluded.news, via_messenger = excluded.via_messenger, updated_at = CURRENT_TIMESTAMP`)
      .run(memberId, tenantId, next.reminders ? 1 : 0, next.news ? 1 : 0, next.viaMessenger ? 1 : 0);
    return next;
  }

  function list(memberId, limit = 50) {
    const items = db.prepare(`SELECT id, kind, title, body, link, broadcast_id, created_at, read_at FROM notifications
      WHERE member_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(memberId, limit)
      .map((row) => ({ id: row.id, kind: row.kind, title: row.title, body: row.body, link: row.link, broadcastId: row.broadcast_id, createdAt: row.created_at, read: row.read_at !== null }));
    const unread = db.prepare('SELECT COUNT(*) AS count FROM notifications WHERE member_id = ? AND read_at IS NULL').get(memberId).count;
    return { items, unread };
  }

  function markRead(memberId, ids) {
    if (ids === 'all') return db.prepare('UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE member_id = ? AND read_at IS NULL').run(memberId).changes;
    let changes = 0;
    for (const id of ids) changes += db.prepare('UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE id = ? AND member_id = ? AND read_at IS NULL').run(id, memberId).changes;
    return changes;
  }

  /** Puts a notification into each member's feed and, if they want it, sends a copy through their bot. */
  async function deliver(tenantId, memberIds, { kind, title, body = '', link = null, broadcastId = null }) {
    const insert = db.prepare(`INSERT INTO notifications (id, tenant_id, member_id, kind, title, body, link, broadcast_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const memberId of memberIds) {
      insert.run(`ntf_${randomUUID()}`, tenantId, memberId, kind, title, body, link, broadcastId);
      await pushToDevices(memberId, { title, body, link, kind });
      if (!memberPrefs(memberId).viaMessenger) continue;
      for (const linkRow of db.prepare('SELECT provider, external_user_id FROM member_messenger_links WHERE tenant_id = ? AND member_id = ?').all(tenantId, memberId)) {
        const adapter = adapters.get(linkRow.provider);
        if (!adapter || !readyProviders.has(linkRow.provider)) continue;
        await adapter.sendMessage(linkRow.external_user_id, body ? `${title}\n${body}` : title)
          .catch((error) => console.error(`notification via ${linkRow.provider} failed:`, error.message));
      }
    }
  }

  /** Active members who keep the bookings and want reminders. */
  function bookingRecipients(tenantId) {
    return db.prepare(`SELECT id, roles_json FROM tenant_members WHERE tenant_id = ? AND status = 'active'`).all(tenantId)
      .filter((member) => repository.roles.permissionsFor(tenantId, JSON.parse(member.roles_json)).has('manageBookings'))
      .filter((member) => memberPrefs(member.id).reminders)
      .map((member) => member.id);
  }

  /** Confirmed bookings of a center from yesterday to the day after tomorrow (local dates), with their car. */
  function bookingsAround(tenantId, today) {
    const shift = (days) => new Date(Date.parse(`${today}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
    return db.prepare(`SELECT b.id, b.start_at, b.estimated_duration_minutes, v.make, v.model
      FROM bookings b JOIN vehicles v ON v.id = b.vehicle_id AND v.tenant_id = b.tenant_id
      WHERE b.tenant_id = ? AND b.status = 'CONFIRMED' AND substr(b.start_at, 1, 10) BETWEEN ? AND ?
      ORDER BY b.start_at`).all(tenantId, shift(-1), shift(2))
      .map((row) => ({ id: row.id, startAt: Date.parse(row.start_at), duration: row.estimated_duration_minutes, car: [row.make, row.model].filter(Boolean).join(' ') }));
  }

  const timeIn = (timestamp, timeZone) => localClock(new Date(timestamp), timeZone).time;
  const line = (booking, timeZone) => `${timeIn(booking.startAt, timeZone)} · ${booking.car} · ${duration(booking.duration)}`;

  /** Runs every minute: the reminder before each booking and the morning and evening digests. */
  async function tick() {
    const current = now();
    for (const tenant of db.prepare('SELECT id, timezone FROM tenants').all()) {
      const settings = reminderSettings(tenant.id);
      if (settings.beforeMinutes === null && !settings.morning.enabled && !settings.evening.enabled) continue;
      const clock = localClock(current, tenant.timezone);
      const bookings = bookingsAround(tenant.id, clock.day);
      if (!bookings.length && !settings.evening.enabled) continue;
      let recipients = null;
      const to = () => recipients ??= bookingRecipients(tenant.id);

      if (settings.beforeMinutes !== null) {
        for (const booking of bookings) {
          const left = (booking.startAt - current.getTime()) / 60_000;
          if (left <= 0 || left > settings.beforeMinutes) continue;
          const key = `before:${booking.id}:${settings.beforeMinutes}`;
          if (sentBefore(key)) continue;
          markSent(key);
          // A booking made 10 minutes before its time still gets one reminder, with the real time left.
          const title = left > settings.beforeMinutes - 2 ? `Через ${beforeLabel(settings.beforeMinutes)} запись` : `Скоро запись: в ${timeIn(booking.startAt, tenant.timezone)}`;
          await deliver(tenant.id, to(), { kind: 'booking_reminder', title, body: line(booking, tenant.timezone), link: `/bookings/${booking.id}` });
        }
      }

      for (const [part, label] of [['morning', 'План на сегодня'], ['evening', 'Завтра']]) {
        const digest = settings[part];
        if (!digest.enabled || clock.minutes < minutesOf(digest.time) || clock.minutes > minutesOf(digest.time) + 30) continue;
        const key = `${part}:${tenant.id}:${clock.day}`;
        if (sentBefore(key)) continue;
        markSent(key);
        const day = part === 'morning' ? clock.day : localClock(new Date(current.getTime() + 86_400_000), tenant.timezone).day;
        const ofDay = bookings.filter((booking) => localClock(new Date(booking.startAt), tenant.timezone).day === day);
        if (!ofDay.length && part === 'morning') continue;
        const title = ofDay.length ? `${label}: ${ofDay.length} ${plural(ofDay.length, 'запись', 'записи', 'записей')}` : `${label} записей нет`;
        const body = ofDay.slice(0, 8).map((booking) => line(booking, tenant.timezone)).join('\n') + (ofDay.length > 8 ? `\nи ещё ${ofDay.length - 8}` : '');
        await deliver(tenant.id, to(), { kind: 'day_plan', title, body, link: '/bookings' });
      }
    }
    // Retention: read notifications live 90 days, marks of what was sent 30.
    db.prepare(`DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < datetime('now', '-90 days')`).run();
    db.prepare(`DELETE FROM notification_sends WHERE sent_at < datetime('now', '-30 days')`).run();
  }

  return { vapidKeys, subscribePush, unsubscribePush, reminderSettings, updateReminderSettings, memberPrefs, updateMemberPrefs, list, markRead, deliver, tick };
}
