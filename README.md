# reqwatch

**Job-opening alerts for your AI agent.** reqwatch is an open-source MCP server that watches employers' own applicant-tracking systems (Greenhouse, Lever, Ashby) and tells your agent when a new opening matches what you care about.

## Why
Job boards repost, lag and go stale. reqwatch reads primary sources, verifies a role is still live, and exposes structured filters that generic boards lack. First wedge: **US new-grad and internship tech roles**, with **visa-sponsorship** and **graduation-window** filters.

## How it works
1. Ingest public ATS board APIs on a schedule; dedupe, detect new and closed postings.
2. You (or your agent) save *interests*: roles, locations, seniority, sponsorship, grad window.
3. New matching jobs are appended to a per-user event log.
4. Your agent calls the MCP tool `list_matches(since_cursor)` to fetch what is new.

## MCP server
Stateless Streamable HTTP endpoint at `POST /mcp` (JSON responses; `GET` returns 405). Auth is `Authorization: Bearer rw_...`
(API tokens, stored as SHA-256 hashes); unauthenticated calls get `401` with a `WWW-Authenticate` header pointing at
`/.well-known/oauth-protected-resource` (issuers from `AUTH_ISSUER`). 60 calls/min per user, then `429` + `Retry-After`.
Create the first token with `POST /admin/tokens` (`Authorization: Bearer $ADMIN_SECRET`, body `{"user_id"?, "name"}`); the route is 404 unless the `ADMIN_SECRET` secret is set.
For hosted use, an OAuth 2.1 server (GitHub login, PKCE, DCR) is also available: OAuth access tokens are accepted alongside API tokens. See [docs/self-host.md](docs/self-host.md).

Tools: `create_interest`, `update_interest`, `delete_interest`, `list_interests`, `list_matches` (call at session start and
periodically with the last `next_cursor`), `get_job`, `search_jobs` (open jobs), `list_companies`, `get_stats`, `set_delivery`, `delete_my_data`.

## Delivery: honest status
- **Primary: cursor tool.** `list_matches(since_cursor)` is idempotent and works with every MCP client today.
- **Fallback: signed webhook (implemented).** `set_delivery{mode:"webhook", webhook_url}` registers one HTTPS endpoint; `mode:"poll"` removes it.
  The signing secret is returned once (calling again rotates it) and stored AES-GCM encrypted with the `WEBHOOK_KEK` secret; without it webhook mode is refused.
  URLs must be https on port 443 with a public domain name (no IP literals, credentials, `localhost`/`.internal`/`.local`); redirects are never followed.
  Workers cannot check DNS resolution, so that is the extent of SSRF protection.
  The existing cron (every 5 min) POSTs `{event_id, cursor, matches}` with `X-Reqwatch-Signature: sha256=HMAC_SHA256(secret, timestamp + "." + body)`,
  `X-Reqwatch-Timestamp` and `X-Reqwatch-Event-Id`. Delivery is at-least-once: dedupe on `event_id` (stable per batch across retries).
  Non-2xx, redirects and timeouts (10 s) retry after 1m, 5m, 30m, 2h, 6h, then every 24h; 7 days of continuous failure disables the webhook. Granularity is the cron interval, so this is not real-time.
- **Not implemented: push.** Server-initiated MCP notifications / SSE are not built; most clients do not surface them to the model anyway.
- `delete_my_data{confirm:true}` removes your interests, matches, events, webhook, API tokens and OAuth tokens/codes.

## Self-host on Cloudflare (quickstart stub)
Runs on Cloudflare Workers + D1 + Queues + R2. Detailed steps will land with the first deployable release:
```
git clone https://github.com/ajac-zero/reqwatch && cd reqwatch
npm install
# create D1/R2/Queue bindings, then: npx wrangler deploy
```

## Hosted version
A hosted instance may be offered later; self-hosting stays free. Join the waitlist via the landing page (coming).

## Status
Early development. Milestones: ingestion, storage, matching, MCP `list_matches`, landing page.

## License
[AGPL-3.0](LICENSE). If you run a modified version as a network service, you must offer its source to users.
