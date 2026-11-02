PRAGMA foreign_keys = ON;

-- Notifications on the device (Web Push): each browser or home-screen app a member allowed to notify.
-- The endpoint belongs to the browser's push service; the keys encrypt messages for that browser only.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  member_id TEXT NOT NULL REFERENCES tenant_members(id),
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_sent_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_member ON push_subscriptions(member_id);

-- Values the server makes for itself once and keeps (the VAPID key pair).
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
