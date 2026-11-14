CREATE TABLE waitlist (
  email TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  ip_hash TEXT,
  source TEXT
);

CREATE TABLE waitlist_rate (
  ip_hash TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (ip_hash, window_start)
);
