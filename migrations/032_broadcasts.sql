PRAGMA foreign_keys = ON;

-- Messages from the DetailFlow service owner (/admin) to the people of the centers: news, updates,
-- surveys. Each reaches the members' feeds as a notification with this broadcast_id.
CREATE TABLE IF NOT EXISTS broadcasts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('news', 'update', 'survey')),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  audience TEXT NOT NULL CHECK(audience IN ('all', 'admins', 'center')),
  tenant_id TEXT REFERENCES tenants(id),
  -- A survey: { options: [...], rating: bool, comment: bool }.
  survey_json TEXT,
  sent_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

-- One answer per person and survey; kept for a year. Results show the center, never the person.
CREATE TABLE IF NOT EXISTS broadcast_answers (
  broadcast_id TEXT NOT NULL REFERENCES broadcasts(id),
  member_id TEXT NOT NULL REFERENCES tenant_members(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  option_index INTEGER,
  rating INTEGER CHECK(rating IS NULL OR rating BETWEEN 1 AND 5),
  comment TEXT,
  answered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (broadcast_id, member_id)
) STRICT;
