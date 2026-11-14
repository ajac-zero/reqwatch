# Self-hosting and hosted OAuth

## Simple setup: API tokens
Set the `ADMIN_SECRET` secret and create tokens with `POST /admin/tokens`. Clients send `Authorization: Bearer rw_...`.
No OAuth configuration is needed; `/authorize` answers `503 Hosted login not configured`.

## Hosted setup: OAuth 2.1 with GitHub login
reqwatch includes an MCP-spec OAuth 2.1 authorization server (authorization code + PKCE S256, refresh-token rotation,
Dynamic Client Registration). GitHub is the upstream identity provider; users are stored as `github:<id>`.
The `/mcp` endpoint accepts either an `rw_` API token or an OAuth access token.

1. Apply migrations (`0007_oauth.sql` adds the OAuth tables; only hashes of codes and tokens are stored).
2. Create a GitHub OAuth app (Settings > Developer settings > OAuth Apps) with
   - Authorization callback URL: `https://<your-origin>/oauth/callback`
3. Store the credentials as secrets (never commit them):
   ```
   wrangler secret put GITHUB_CLIENT_ID
   wrangler secret put GITHUB_CLIENT_SECRET
   ```
   `GITHUB_CLIENT_SECRET` also signs the login state and CSRF tokens; rotating it invalidates in-flight logins.
4. Set the required `WEBHOOK_KEK` secret (encrypts webhook signing secrets). Generate it and store it:
   ```
   openssl rand -hex 32
   wrangler secret put WEBHOOK_KEK
   ```
   `GET /health` returns `{ok, db, last_cron_at, webhook_kek}` and HTTP 503 (`webhook_kek: "missing"`) while it is unset, so point smoke checks and uptime monitors at it.
5. Deploy. OAuth is enabled when both secrets are set.

Endpoints: `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource` (advertises the request
origin as authorization server unless `AUTH_ISSUER` is set), `/register`, `/authorize`, `/token`, `/revoke`, `/oauth/callback`.
Scopes: `read`, `write`. Access tokens last 1 hour, refresh tokens 30 days (rotated on every use).
Redirect URIs must match exactly and be `https` or loopback `http` (`localhost`, `127.0.0.1`, `[::1]`).
