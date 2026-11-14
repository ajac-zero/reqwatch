import { beforeEach, describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index";
import { RATE_LIMIT, createToken, sha256Hex } from "../src/auth";
import { addCompany, makeDb } from "./helpers";

let ctx: ReturnType<typeof makeDb>;
let env: Env;
let A: string; // tokens
let B: string;
let seq = 0;
const NOW = new Date().toISOString();

const call = (body: unknown, token: string | null, path = "/mcp", init: RequestInit = {}) =>
  worker.fetch(
    new Request(`https://rw.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
      ...init,
    }),
    env,
  );
const rpc = async (token: string | null, method: string, params?: unknown) => {
  const r = await call({ jsonrpc: "2.0", id: ++seq, method, params }, token);
  return { status: r.status, body: (await r.json()) as any };
};
const tool = async (token: string, name: string, args: unknown = {}) => {
  const { body } = await rpc(token, "tools/call", { name, arguments: args });
  return body.result as { isError: boolean; structuredContent: any; content: { text: string }[] };
};

function addJob(companyId: number, o: Record<string, unknown> = {}): number {
  const n = (ctx.raw.prepare("SELECT COUNT(*) n FROM jobs").get() as { n: number }).n;
  const j = { title: `Software Engineer ${n}`, status: "open", role_family: "software_engineering", seniority: "entry", country_set: ",US,", ...o };
  return Number(
    ctx.raw.prepare(
      `INSERT INTO jobs (company_id, ats, ext_id, title, locations_json, url, first_seen_at, last_seen_at, last_changed_at, status,
         content_hash, dedup_key, country_set, role_family, seniority, posted_at)
       VALUES (?, 'greenhouse', ?, ?, '["New York, NY"]', 'https://x/j', ?, ?, ?, ?, 'h', ?, ?, ?, ?, '2026-11-01')`,
    ).run(companyId, `e${n}`, j.title, NOW, NOW, NOW, j.status, `k${n}`, j.country_set, j.role_family, j.seniority).lastInsertRowid,
  );
}

let co: number;
beforeEach(async () => {
  ctx = makeDb();
  env = { DB: ctx.db, FETCH_QUEUE: { send: async () => {} } };
  co = addCompany(ctx.raw, "greenhouse", "Acme", "acme").id;
  A = (await createToken(ctx.db, "user-a", "a")).token;
  B = (await createToken(ctx.db, "user-b", "b")).token;
});

describe("protocol", () => {
  it("runs a full conversation", async () => {
    const init = await rpc(A, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(init.body.result).toMatchObject({
      protocolVersion: "2025-03-26", serverInfo: { name: "reqwatch" }, capabilities: { tools: {} },
    });
    expect((await rpc(A, "initialize", { protocolVersion: "1999-01-01" })).body.result.protocolVersion).toBe("2025-06-18");
    const note = await call({ jsonrpc: "2.0", method: "notifications/initialized" }, A);
    expect(note.status).toBe(202);
    expect((await rpc(A, "ping")).body.result).toEqual({});
    const list = await rpc(A, "tools/list");
    expect(list.body.result.tools.map((t: any) => t.name).sort()).toEqual([
      "create_interest", "delete_interest", "get_job", "get_stats", "list_companies", "list_interests", "list_matches",
      "search_jobs", "update_interest",
    ]);
    const lm = list.body.result.tools.find((t: any) => t.name === "list_matches");
    expect(lm.description).toMatch(/start of every session/);
    expect(lm.description).toMatch(/idempotent/);
    expect(lm.inputSchema.type).toBe("object");
    const r = await call({ jsonrpc: "2.0", id: 1, method: "nope" }, A);
    expect((await r.json() as any).error.code).toBe(-32601);
  });

  it("GET /mcp is 405", async () => {
    const r = await worker.fetch(new Request("https://rw.test/mcp", { headers: { authorization: `Bearer ${A}` } }), env);
    expect(r.status).toBe(405);
  });

  it("handles malformed input", async () => {
    let r = await call("{not json", A);
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error.code).toBe(-32700);
    r = await call([{ jsonrpc: "2.0", id: 1, method: "ping" }], A);
    expect(((await r.json()) as any).error.code).toBe(-32600);
    r = await call({ id: 1, method: "ping" }, A);
    expect(((await r.json()) as any).error.code).toBe(-32600);
    expect((await rpc(A, "tools/call", "bad")).body.error.code).toBe(-32602);
    expect((await rpc(A, "tools/call", { name: "nope" })).body.error.code).toBe(-32602);
    for (const args of [{ name: 5 }, { name: "x", filter: { roles: ["bogus"] } }, {}]) {
      const t = await tool(A, "create_interest", args);
      expect(t.isError).toBe(true);
      expect(t.content[0]!.text).toMatch(/invalid_arguments/);
    }
    expect((await tool(A, "search_jobs", { limit: 51 })).isError).toBe(true);
    expect((await tool(A, "get_job", { job_id: "x" })).isError).toBe(true);
    expect((await tool(A, "list_matches", { since_cursor: "abc" })).content[0]!.text).toMatch(/invalid_cursor/);
  });
});

describe("auth", () => {
  it("401 with WWW-Authenticate for missing, bad, and non-rw tokens", async () => {
    for (const t of [null, "rw_wrong", "other"]) {
      const r = await call({ jsonrpc: "2.0", id: 1, method: "ping" }, t);
      expect(r.status).toBe(401);
      expect(r.headers.get("www-authenticate")).toBe('Bearer resource_metadata="https://rw.test/.well-known/oauth-protected-resource"');
    }
  });

  it("serves protected resource metadata", async () => {
    const get = () => worker.fetch(new Request("https://rw.test/.well-known/oauth-protected-resource"), env);
    expect(await (await get()).json()).toMatchObject({ resource: "https://rw.test/mcp", authorization_servers: [] });
    env.AUTH_ISSUER = "https://auth.example";
    expect(((await (await get()).json()) as any).authorization_servers).toEqual(["https://auth.example"]);
  });

  it("stores only the token hash", async () => {
    const { token } = await createToken(ctx.db, "user-c", "c");
    expect(token).toMatch(/^rw_[A-Za-z0-9_-]{43}$/);
    const rows = ctx.raw.prepare("SELECT * FROM api_tokens").all() as any[];
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows.map((r) => r.token_hash)).toContain(await sha256Hex(token));
  });

  it("revoked tokens stop working and last_used_at is set", async () => {
    await rpc(A, "ping");
    expect((ctx.raw.prepare("SELECT last_used_at FROM api_tokens WHERE user_id='user-a'").get() as any).last_used_at).toBeTruthy();
    ctx.raw.prepare("UPDATE api_tokens SET revoked_at = ?").run(NOW);
    expect((await rpc(A, "ping")).status).toBe(401);
  });

  it("scopes gate write tools", async () => {
    const { token } = await createToken(ctx.db, "user-r", "ro", ["read"]);
    expect((await tool(token, "list_interests")).isError).toBe(false);
    const t = await tool(token, "create_interest", { name: "x", filter: {} });
    expect(t.isError).toBe(true);
    expect(t.content[0]!.text).toMatch(/forbidden/);
  });

  it("rate limits at 60/min with Retry-After", async () => {
    for (let i = 0; i < RATE_LIMIT; i++) expect((await rpc(A, "ping")).status).toBe(200);
    const r = await call({ jsonrpc: "2.0", id: 1, method: "ping" }, A);
    expect(r.status).toBe(429);
    const ra = Number(r.headers.get("retry-after"));
    expect(ra).toBeGreaterThanOrEqual(1);
    expect(ra).toBeLessThanOrEqual(60);
    expect((await rpc(B, "ping")).status).toBe(200); // per user
  });

  describe("POST /admin/tokens", () => {
    const admin = (secret: string | null, body: unknown, method = "POST") =>
      worker.fetch(
        new Request("https://rw.test/admin/tokens", {
          method, headers: secret ? { authorization: `Bearer ${secret}` } : {}, body: method === "POST" ? JSON.stringify(body) : undefined,
        }),
        env,
      );
    it("404s when ADMIN_SECRET is unset", async () => {
      expect((await admin("anything", { name: "x" })).status).toBe(404);
    });
    it("rejects wrong secrets, validates, and issues a working token", async () => {
      env.ADMIN_SECRET = "s3cret";
      expect((await admin(null, { name: "x" })).status).toBe(401);
      expect((await admin("s3cret!", { name: "x" })).status).toBe(401);
      expect((await admin("s3cret", {})).status).toBe(400);
      expect((await admin("s3cret", { name: "x" }, "GET")).status).toBe(405);
      const r = await admin("s3cret", { user_id: "first", name: "cli" });
      expect(r.status).toBe(201);
      const out = (await r.json()) as any;
      expect(out.user_id).toBe("first");
      expect((await rpc(out.token, "tools/call", { name: "list_interests" })).body.result.isError).toBe(false);
      const gen = (await (await admin("s3cret", { name: "cli2" })).json()) as any;
      expect(gen.user_id).toMatch(/^[0-9a-f-]{36}$/);
    });
  });
});

describe("tools", () => {
  it("interest CRUD + backfill + list_matches cursor idempotency", async () => {
    const j1 = addJob(co);
    const j2 = addJob(co);
    addJob(co, { role_family: "data" });
    const created = await tool(A, "create_interest", { name: "swe", filter: { roles: ["software_engineering"], min_score: 0 } });
    expect(created.isError).toBe(false);
    const iid = created.structuredContent.interest.id;
    expect(created.structuredContent.backfill.matched).toBe(2);
    expect((await tool(A, "list_interests")).structuredContent.interests.map((i: any) => i.id)).toEqual([iid]);

    const first = (await tool(A, "list_matches", { limit: 1 })).structuredContent;
    expect(first.items).toHaveLength(1);
    expect(first.items[0].job.status).toBe("open");
    const again = (await tool(A, "list_matches", { limit: 1 })).structuredContent;
    expect(again).toEqual(first);
    const next = (await tool(A, "list_matches", { since_cursor: first.next_cursor })).structuredContent;
    expect(next.items).toHaveLength(1);
    expect([first.items[0].job.id, next.items[0].job.id].sort()).toEqual([j1, j2]);
    const empty = (await tool(A, "list_matches", { since_cursor: next.next_cursor })).structuredContent;
    expect(empty).toEqual({ items: [], next_cursor: next.next_cursor });
    expect((await tool(A, "list_matches", { interest_id: "nope" })).structuredContent.items).toEqual([]);

    // closed jobs are flagged in matches
    ctx.raw.prepare("UPDATE jobs SET status='closed' WHERE id=?").run(j1);
    const all = (await tool(A, "list_matches")).structuredContent.items;
    expect(all.find((i: any) => i.job.id === j1).job.status).toBe("closed");

    const upd = await tool(A, "update_interest", { id: iid, patch: { name: "renamed", paused: true } });
    expect(upd.structuredContent.interest).toMatchObject({ name: "renamed", paused: true });
    expect((await tool(A, "delete_interest", { id: iid })).structuredContent).toEqual({ deleted: true });
    expect((await tool(A, "list_interests")).structuredContent.interests).toEqual([]);
    expect((await tool(A, "delete_interest", { id: iid })).isError).toBe(true);
  });

  it("get_job flags closed jobs prominently", async () => {
    const open = addJob(co);
    const closed = addJob(co, { status: "closed" });
    const o = await tool(A, "get_job", { job_id: open });
    expect(o.structuredContent).toMatchObject({
      id: open, company: "Acme", status: "open", locations: ["New York, NY"], countries: ["US"], posted_at: "2026-11-01",
      role_family: "software_engineering", first_seen_at: NOW, last_seen_at: NOW,
    });
    expect(o.structuredContent.closed).toBeUndefined();
    const c = await tool(A, "get_job", { job_id: closed });
    expect(c.structuredContent).toMatchObject({ status: "closed", closed: true });
    expect(c.content[0]!.text).toMatch(/^THIS JOB IS CLOSED/);
    expect((await tool(A, "get_job", { job_id: 9999 })).isError).toBe(true);
  });

  it("search_jobs covers only open jobs, with filters and limit", async () => {
    addJob(co, { title: "Backend 100%" });
    addJob(co, { title: "Closed thing", status: "closed" });
    addJob(co, { title: "Designer", role_family: "design", seniority: "senior", country_set: ",GB," });
    const titles = async (a: object) => (await tool(A, "search_jobs", a)).structuredContent.jobs.map((j: any) => j.title).sort();
    expect(await titles({})).toEqual(["Backend 100%", "Designer"]);
    expect(await titles({ query: "100%" })).toEqual(["Backend 100%"]);
    expect(await titles({ query: "%" })).toEqual(["Backend 100%"]); // wildcard is escaped
    expect(await titles({ query: "acme" })).toHaveLength(2);
    expect(await titles({ role_family: "design" })).toEqual(["Designer"]);
    expect(await titles({ seniority: "senior", country: "gb" })).toEqual(["Designer"]);
    expect(await titles({ country: "DE" })).toEqual([]);
    expect(await titles({ limit: 1 })).toHaveLength(1);
    expect(await titles({ query: "Closed" })).toEqual([]);
  });

  it("list_companies and get_stats", async () => {
    const b = addCompany(ctx.raw, "lever", "Beta", "beta").id;
    addJob(co);
    addJob(b, { status: "closed" });
    ctx.raw.prepare("UPDATE companies SET last_ok_at='2026-11-02T00:00:00Z' WHERE id=?").run(co);
    ctx.raw.prepare("UPDATE companies SET last_ok_at='2026-11-03T00:00:00Z' WHERE id=?").run(b);
    const cs = (await tool(A, "list_companies")).structuredContent.companies;
    expect(cs.map((c: any) => [c.name, c.open_jobs])).toEqual([["Acme", 1], ["Beta", 0]]);
    expect((await tool(A, "list_companies", { query: "bet", limit: 5 })).structuredContent.companies).toHaveLength(1);
    expect((await tool(A, "get_stats")).structuredContent).toEqual({ companies: 2, open_jobs: 1, newest_last_ok_at: "2026-11-03T00:00:00Z" });
  });
});

describe("cross-tenant isolation", () => {
  it("user A cannot read or modify B for every tool", async () => {
    addJob(co);
    const bi = (await tool(B, "create_interest", { name: "b-int", filter: { min_score: 0 } })).structuredContent.interest.id;
    expect((await tool(B, "list_matches")).structuredContent.items).toHaveLength(1);

    expect((await tool(A, "list_interests")).structuredContent.interests).toEqual([]);
    expect((await tool(A, "list_matches")).structuredContent.items).toEqual([]);
    expect((await tool(A, "list_matches", { interest_id: bi })).structuredContent.items).toEqual([]);
    expect((await tool(A, "update_interest", { id: bi, patch: { name: "hacked" } })).isError).toBe(true);
    expect((await tool(A, "delete_interest", { id: bi })).isError).toBe(true);

    const bs = (await tool(B, "list_interests")).structuredContent.interests;
    expect(bs).toHaveLength(1);
    expect(bs[0].name).toBe("b-int");
    expect((await tool(B, "list_matches")).structuredContent.items).toHaveLength(1);

    // user_id in input is ignored: extra keys can't redirect the tenant
    const sneaky = await tool(A, "list_matches", { user_id: "user-b" });
    expect(sneaky.structuredContent.items).toEqual([]);
    // A's backfill never records matches for B's interest
    const ai = (await tool(A, "create_interest", { name: "a", filter: { min_score: 0 } })).structuredContent.interest.id;
    expect(ai).not.toBe(bi);
    expect((ctx.raw.prepare("SELECT COUNT(*) n FROM matches WHERE interest_id=? AND user_id='user-a'").get(bi) as any).n).toBe(0);
  });

  it("shared catalog tools (jobs, companies, stats) expose no per-user data", async () => {
    const j = addJob(co);
    expect((await tool(A, "get_job", { job_id: j })).structuredContent).toEqual((await tool(B, "get_job", { job_id: j })).structuredContent);
    expect((await tool(A, "get_stats")).structuredContent).toEqual((await tool(B, "get_stats")).structuredContent);
  });
});
