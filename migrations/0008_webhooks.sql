-- Signed webhook delivery fallback. One webhook per user; secret_enc is AES-GCM ciphertext (base64 iv||ct), never plaintext.
CREATE TABLE webhooks (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  url TEXT NOT NULL,
  secret_enc TEXT NOT NULL,
  created_at TEXT NOT NULL,
  disabled_at TEXT,
  fail_since TEXT,                        -- start of the current run of consecutive failures
  last_event_seq INTEGER NOT NULL DEFAULT 0
);

-- The in-flight batch (events in (event_seq_from, event_seq_to]) and its retry state; absent when nothing is pending.
-- The batch bounds are frozen at first attempt so the event id stays stable across retries.
CREATE TABLE webhook_attempts (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  event_seq_from INTEGER NOT NULL,
  event_seq_to INTEGER NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,     -- failed attempts so far
  next_attempt_at TEXT NOT NULL,
  last_status INTEGER,
  last_error TEXT
);
