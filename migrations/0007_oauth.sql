-- OAuth 2.1 authorization server. Codes, access tokens and refresh tokens are stored as SHA-256 hashes only.
CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,                 -- JSON array
  created_at TEXT NOT NULL
);

CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,                -- PKCE S256
  scopes TEXT NOT NULL,                        -- space separated
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE oauth_tokens (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  access_hash TEXT NOT NULL UNIQUE,
  refresh_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  access_expires_at TEXT NOT NULL,
  refresh_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT                              -- set on revoke and when the refresh token is rotated
);
CREATE INDEX idx_oauth_tokens_user ON oauth_tokens (user_id);
