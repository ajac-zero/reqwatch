CREATE TABLE companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  ats TEXT NOT NULL CHECK (ats IN ('greenhouse','lever','ashby')),
  board_token TEXT NOT NULL,
  tier INTEGER NOT NULL DEFAULT 2,
  last_ok_at TEXT,
  next_poll_at TEXT,
  etag TEXT,
  fail_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (ats, board_token)
);

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  ats TEXT NOT NULL,
  ext_id TEXT NOT NULL,
  title TEXT NOT NULL,
  locations_json TEXT NOT NULL DEFAULT '[]',
  url TEXT NOT NULL,
  posted_at TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_changed_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  content_hash TEXT NOT NULL,
  dedup_key TEXT NOT NULL,
  missed_polls INTEGER NOT NULL DEFAULT 0,
  reposted INTEGER NOT NULL DEFAULT 0,
  cross_posted INTEGER NOT NULL DEFAULT 0,
  UNIQUE (ats, company_id, ext_id)
);

CREATE INDEX idx_jobs_dedup ON jobs (dedup_key);
CREATE INDEX idx_jobs_company_status ON jobs (company_id, status);
