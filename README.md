# reqwatch

**Job-opening alerts for your AI agent.** reqwatch is an open-source MCP server that watches employers' own applicant-tracking systems (Greenhouse, Lever, Ashby) and tells your agent when a new opening matches what you care about.

## Why
Job boards repost, lag and go stale. reqwatch reads primary sources, verifies a role is still live, and exposes structured filters that generic boards lack. First wedge: **US new-grad and internship tech roles**, with **visa-sponsorship** and **graduation-window** filters.

## How it works
1. Ingest public ATS board APIs on a schedule; dedupe, detect new and closed postings.
2. You (or your agent) save *interests*: roles, locations, seniority, sponsorship, grad window.
3. New matching jobs are appended to a per-user event log.
4. Your agent calls the MCP tool `list_matches(since_cursor)` to fetch what is new.

## MCP Events support: honest status
- **Primary: cursor tool.** `list_matches(since_cursor)` is idempotent and works with every MCP client today.
- **Upgrade: push.** Server-initiated MCP notifications and webhooks are planned; most clients do not yet surface server notifications to the model, so push is an enhancement, never a requirement.

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
