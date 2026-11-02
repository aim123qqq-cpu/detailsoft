PRAGMA foreign_keys = ON;

-- Notifications for the people of a center: reminders about upcoming bookings and the plan of the day,
-- and messages from the DetailFlow service (news, updates, surveys). Each lands in the member's feed in
-- the app; a member with a linked bot also gets it there. Texts carry no customers' names or phones.

-- What the center wants to be reminded of (the owner decides). No row: the defaults in notifications.mjs.
CREATE TABLE IF NOT EXISTS tenant_reminder_settings (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
  before_minutes INTEGER CHECK(before_minutes IS NULL OR before_minutes IN (15, 30, 60, 120, 180)),
  morning_enabled INTEGER NOT NULL CHECK(morning_enabled IN (0, 1)),
  morning_time TEXT NOT NULL,
  evening_enabled INTEGER NOT NULL CHECK(evening_enabled IN (0, 1)),
  evening_time TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

-- What a member wants for themself: reminders, news from DetailFlow, copies through the bot.
CREATE TABLE IF NOT EXISTS member_notification_prefs (
  member_id TEXT PRIMARY KEY REFERENCES tenant_members(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  reminders INTEGER NOT NULL DEFAULT 1 CHECK(reminders IN (0, 1)),
  news INTEGER NOT NULL DEFAULT 1 CHECK(news IN (0, 1)),
  via_messenger INTEGER NOT NULL DEFAULT 1 CHECK(via_messenger IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  member_id TEXT NOT NULL REFERENCES tenant_members(id),
  kind TEXT NOT NULL CHECK(kind IN ('booking_reminder', 'day_plan', 'broadcast')),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT,
  broadcast_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  read_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_notifications_member ON notifications(member_id, created_at DESC);

-- What has already gone out (a reminder per booking and interval, a digest per center and day): the
-- minute timer must never send the same thing twice, even after a restart.
CREATE TABLE IF NOT EXISTS notification_sends (
  key TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
