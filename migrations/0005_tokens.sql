-- API tokens (only the SHA-256 hash is stored) and a fixed-window rate-limit counter.
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT 'read write',   -- space separated
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX idx_api_tokens_user ON api_tokens (user_id);

CREATE TABLE rate_limits (
  user_id TEXT NOT NULL,
  window_start INTEGER NOT NULL,               -- unix seconds, start of the fixed window
  count INTEGER NOT NULL,
  PRIMARY KEY (user_id, window_start)
);
