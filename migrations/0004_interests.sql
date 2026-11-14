-- Tenant-scoped interests, matches and an append-only event log.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE interests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  filter_json TEXT NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_interests_user ON interests (user_id);

CREATE TABLE matches (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  interest_id TEXT NOT NULL REFERENCES interests(id),
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  score REAL NOT NULL,
  flags_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  UNIQUE (interest_id, job_id)
);
CREATE INDEX idx_matches_user_created ON matches (user_id, created_at);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_events_user_seq ON events (user_id, seq);
