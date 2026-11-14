import { beforeEach, describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index";
import { scheduled } from "../src/worker";
import { createToken, sha256Hex } from "../src/auth";
import { BACKOFF_MS, deliverWebhooks, sign, validateWebhookUrl } from "../src/webhook";
import { addCompany, makeDb } from "./helpers";

const KEK = "test-kek";
const T0 = "2026-11-14T00:00:00.000Z";
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();
let ctx: ReturnType<typeof makeDb>;
let env: Env;
let tokA: string;
let tokB: string;
let n = 0;

const tool = async (token: string, name: string, args: unknown = {}) => {
  const r = await worker.fetch(
    new Request("https://rw.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } }),
    }),
    env,
  );
  return ((await r.json()) as any).result as { isError: boolean; structuredContent: any; content: { text: string }[] };
};

/** Adds an interest + job + match event for the user; returns the event seq. */
function addMatch(user: string): number {
  const co = addCompany(ctx.raw, "greenhouse", `Co${++n}`, `co${n}`).id;
  const iid = `i${n}`;
  ctx.raw.prepare("INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)").run(user, T0);
  ctx.raw.prepare("INSERT INTO interests (id, user_id, name, filter_json, created_at, updated_at) VALUES (?,?,?,?,?,?)").run(iid, user, "x", "{}", T0, T0);
  const job = ctx.raw
    .prepare(
      `INSERT INTO jobs (company_id, ats, ext_id, title, url, first_seen_at, last_seen_at, last_changed_at, content_hash, dedup_key)
       VALUES (?, 'greenhouse', ?, 'Eng', 'https://x/j', ?, ?, ?, 'h', ?)`,
    )
    .run(co, `e${n}`, T0, T0, T0, `k${n}`).lastInsertRowid;
  return Number(
    ctx.raw
      .prepare("INSERT INTO events (user_id, type, payload_json, created_at) VALUES (?, 'match', ?, ?)")
      .run(user, JSON.stringify({ interest_id: iid, job_id: Number(job), score: 1, flags: [] }), T0).lastInsertRowid,
  );
}

const hooks = (user = "user-a") => ctx.raw.prepare("SELECT * FROM webhooks WHERE user_id = ?").get(user) as any;
const attempts = (user = "user-a") => ctx.raw.prepare("SELECT * FROM webhook_attempts WHERE user_id = ?").get(user) as any;

type Call = { url: string; init: RequestInit };
const fakeFetch = (responses: (() => Response | Promise<Response>)[]) => {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return (responses[Math.min(calls.length - 1, responses.length - 1)] ?? (() => new Response("", { status: 200 })))();
  }) as unknown as typeof fetch;
  return { f, calls };
};
const ok = () => new Response("", { status: 200 });
const err500 = () => new Response("", { status: 500 });

let secretA: string;
beforeEach(async () => {
  ctx = makeDb();
  env = { DB: ctx.db, FETCH_QUEUE: { send: async () => {} }, WEBHOOK_KEK: KEK };
  tokA = (await createToken(ctx.db, "user-a", "a")).token;
  tokB = (await createToken(ctx.db, "user-b", "b")).token;
  const r = await tool(tokA, "set_delivery", { mode: "webhook", webhook_url: "https://hooks.example.com/rw" });
  secretA = r.structuredContent.signing_secret;
});

describe("validateWebhookUrl", () => {
  const bad = [
    "http://hooks.example.com/x", "https://127.0.0.1/x", "https://10.0.0.5/x", "https://169.254.169.254/latest", "https://[::1]/x",
    "https://[2001:db8::1]/x", "https://2130706433/x", "https://0x7f.1/x", "https://localhost/x", "https://localhost./x",
    "https://foo.localhost/x", "https://svc.internal/x", "https://printer.local/x", "https://user:pw@hooks.example.com/x",
    "https://hooks.example.com:8443/x", "https://hooks.example.com:80/x", "https://intranet/x", "not a url", "ftp://a.example.com",
  ];
  it.each(bad)("rejects %s", (u) => expect(validateWebhookUrl(u)).not.toBeNull());
  it.each(["https://hooks.example.com/x", "https://hooks.example.com:443/x?a=1", "https://a.b.example.co.uk/p"])("accepts %s", (u) =>
    expect(validateWebhookUrl(u)).toBeNull());
});

describe("set_delivery", () => {
  it("returns the secret once, stores it encrypted, and rotation yields a new one", async () => {
    expect(secretA).toMatch(/^whsec_[0-9a-f]{64}$/);
    const row = hooks();
    expect(row.secret_enc).not.toContain(secretA);
    expect(JSON.stringify(ctx.raw.prepare("SELECT * FROM webhooks").all())).not.toContain(secretA);
    const again = await tool(tokA, "set_delivery", { mode: "webhook", webhook_url: "https://hooks.example.com/rw" });
    expect(again.structuredContent.signing_secret).not.toBe(secretA);
    // nothing else ever exposes it
    for (const name of ["list_interests", "get_stats"]) expect(JSON.stringify(await tool(tokA, name))).not.toMatch(/whsec_/);
  });

  it("errors clearly without WEBHOOK_KEK, rejects bad URLs, and poll removes the webhook", async () => {
    const saved = env.WEBHOOK_KEK;
    env.WEBHOOK_KEK = undefined;
    const r = await tool(tokB, "set_delivery", { mode: "webhook", webhook_url: "https://hooks.example.com/rw" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/WEBHOOK_KEK/);
    env.WEBHOOK_KEK = saved;
    const bad = await tool(tokB, "set_delivery", { mode: "webhook", webhook_url: "https://127.0.0.1/" });
    expect(bad.isError).toBe(true);
    expect((await tool(tokB, "set_delivery", { mode: "webhook" })).isError).toBe(true);
    expect((await tool(tokA, "set_delivery", { mode: "poll" })).structuredContent).toEqual({ mode: "poll" });
    expect(hooks()).toBeUndefined();
  });

  it("only touches the caller's webhook", async () => {
    await tool(tokB, "set_delivery", { mode: "webhook", webhook_url: "https://b.example.com/" });
    await tool(tokB, "set_delivery", { mode: "poll" });
    expect(hooks().url).toBe("https://hooks.example.com/rw");
  });
});

describe("deliverWebhooks", () => {
  it("sends a signature that verifies independently, with stable headers, and advances the cursor on 2xx", async () => {
    const s1 = addMatch("user-a");
    const s2 = addMatch("user-a");
    const { f, calls } = fakeFetch([ok]);
    expect(await deliverWebhooks(env, T0, { fetchImpl: f })).toEqual({ delivered: 1, failed: 0 });
    const { url, init } = calls[0]!;
    expect(url).toBe("https://hooks.example.com/rw");
    expect(init.redirect).toBe("manual");
    expect(init.method).toBe("POST");
    const h = init.headers as Record<string, string>;
    const body = init.body as string;
    // independent verification with node crypto
    const { createHmac } = await import("node:crypto");
    expect(h["x-reqwatch-signature"]).toBe(`sha256=${createHmac("sha256", secretA).update(`${h["x-reqwatch-timestamp"]}.${body}`).digest("hex")}`);
    expect(h["x-reqwatch-timestamp"]).toBe(String(Date.parse(T0) / 1000));
    const parsed = JSON.parse(body);
    expect(parsed).toMatchObject({ event_id: h["x-reqwatch-event-id"], cursor: String(s2) });
    expect(parsed.matches.map((m: any) => m.event_seq)).toEqual([s1, s2]);
    expect(parsed.matches[0]).toMatchObject({ job: { title: "Eng", company: expect.any(String) }, interest_id: expect.any(String), flags: [] });
    expect(hooks().last_event_seq).toBe(s2);
    // nothing new => no further call
    expect(await deliverWebhooks(env, at(1000), { fetchImpl: f })).toEqual({ delivered: 0, failed: 0 });
    expect(calls).toHaveLength(1);
    // a wrong secret does not verify
    expect(await sign("whsec_other", h["x-reqwatch-timestamp"]!, body)).not.toBe(h["x-reqwatch-signature"]!.slice(7));
  });

  it("retries 500 then succeeds with the same event id, even if new events arrived meanwhile", async () => {
    addMatch("user-a");
    const { f, calls } = fakeFetch([err500, ok]);
    expect(await deliverWebhooks(env, T0, { fetchImpl: f })).toEqual({ delivered: 0, failed: 1 });
    expect(attempts()).toMatchObject({ attempt: 1, next_attempt_at: at(BACKOFF_MS[0]!), last_status: 500 });
    expect(hooks().last_event_seq).toBe(0);
    const late = addMatch("user-a");
    // not due yet
    await deliverWebhooks(env, at(30_000), { fetchImpl: f });
    expect(calls).toHaveLength(1);
    await deliverWebhooks(env, at(60_000), { fetchImpl: f });
    expect(calls).toHaveLength(2);
    expect((calls[1]!.init.headers as any)["x-reqwatch-event-id"]).toBe((calls[0]!.init.headers as any)["x-reqwatch-event-id"]);
    expect(JSON.parse(calls[1]!.init.body as string).matches).toHaveLength(1);
    expect(attempts()).toBeUndefined();
    expect(hooks().fail_since).toBeNull();
    // the late event goes out in its own batch
    await deliverWebhooks(env, at(61_000), { fetchImpl: f });
    expect(JSON.parse(calls[2]!.init.body as string).cursor).toBe(String(late));
  });

  it("follows the 1m,5m,30m,2h,6h,24h backoff schedule and then stays at 24h", async () => {
    addMatch("user-a");
    const { f } = fakeFetch([err500]);
    let now = T0;
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      await deliverWebhooks(env, now, { fetchImpl: f });
      const next = attempts().next_attempt_at as string;
      delays.push(Date.parse(next) - Date.parse(now));
      now = next;
    }
    expect(delays).toEqual([60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 86_400_000, 86_400_000, 86_400_000]);
  });

  it("treats redirects, timeouts and network errors as failures", async () => {
    addMatch("user-a");
    const redirect = () => new Response("", { status: 302, headers: { location: "https://evil.example.com/" } });
    const timeout = () => { throw Object.assign(new Error("aborted"), { name: "TimeoutError" }); };
    const { f, calls } = fakeFetch([redirect, timeout, () => { throw new Error("boom"); }]);
    await deliverWebhooks(env, T0, { fetchImpl: f });
    expect(attempts()).toMatchObject({ last_status: 302, last_error: expect.stringMatching(/redirect/) });
    expect(hooks().last_event_seq).toBe(0);
    await deliverWebhooks(env, at(60_000), { fetchImpl: f });
    expect(attempts().last_error).toBe("timeout");
    await deliverWebhooks(env, at(60_000 + 300_000), { fetchImpl: f });
    expect(attempts()).toMatchObject({ attempt: 3, last_error: "boom" });
    expect(calls.every((c) => c.init.redirect === "manual")).toBe(true);
  });

  it("auto-disables after 7 days of continuous failure and then stops sending", async () => {
    addMatch("user-a");
    const { f, calls } = fakeFetch([err500]);
    await deliverWebhooks(env, T0, { fetchImpl: f });
    expect(hooks().fail_since).toBe(T0);
    ctx.raw.prepare("UPDATE webhook_attempts SET next_attempt_at = ?").run(T0);
    await deliverWebhooks(env, at(7 * 86_400_000 - 1), { fetchImpl: f });
    expect(hooks().disabled_at).toBeNull();
    ctx.raw.prepare("UPDATE webhook_attempts SET next_attempt_at = ?").run(T0);
    await deliverWebhooks(env, at(7 * 86_400_000), { fetchImpl: f });
    expect(hooks().disabled_at).toBe(at(7 * 86_400_000));
    const before = calls.length;
    await deliverWebhooks(env, at(8 * 86_400_000), { fetchImpl: f });
    expect(calls).toHaveLength(before);
    // reconfiguring re-enables
    await tool(tokA, "set_delivery", { mode: "webhook", webhook_url: "https://hooks.example.com/rw" });
    expect(hooks().disabled_at).toBeNull();
  });

  it("isolates tenants and respects the per-run bound", async () => {
    await tool(tokB, "set_delivery", { mode: "webhook", webhook_url: "https://b.example.com/hook" });
    const sa = addMatch("user-a");
    const sb = addMatch("user-b");
    const { f, calls } = fakeFetch([ok]);
    await deliverWebhooks(env, T0, { fetchImpl: f, limit: 1 });
    expect(calls).toHaveLength(1);
    await deliverWebhooks(env, T0, { fetchImpl: f, limit: 5 });
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      const m = JSON.parse(c.init.body as string).matches as any[];
      expect(m.map((x) => x.event_seq)).toEqual(c.url.startsWith("https://b.") ? [sb] : [sa]);
    }
    expect(hooks("user-b").last_event_seq).toBe(sb);
  });

  it("is a no-op without WEBHOOK_KEK and runs from the cron handler", async () => {
    addMatch("user-a");
    const { f, calls } = fakeFetch([ok]);
    expect(await deliverWebhooks({ DB: ctx.db }, T0, { fetchImpl: f })).toEqual({ delivered: 0, failed: 0 });
    expect(calls).toHaveLength(0);
    const orig = globalThis.fetch;
    globalThis.fetch = f;
    try { await scheduled(env, T0); } finally { globalThis.fetch = orig; }
    expect(calls).toHaveLength(1);
  });
});

describe("delete_my_data", () => {
  it("requires confirm and deletes only the caller's data", async () => {
    await tool(tokB, "set_delivery", { mode: "webhook", webhook_url: "https://b.example.com/hook" });
    addMatch("user-a");
    addMatch("user-b");
    ctx.raw.prepare("INSERT INTO matches (user_id, interest_id, job_id, score, created_at) SELECT user_id, id, 1, 1, ? FROM interests").run(T0);
    await deliverWebhooks(env, T0, { fetchImpl: fakeFetch([err500]).f });
    expect((await tool(tokA, "delete_my_data", { confirm: false })).isError).toBe(true);
    expect((await tool(tokA, "delete_my_data")).isError).toBe(true);
    expect((await tool(tokA, "delete_my_data", { confirm: true })).structuredContent).toEqual({ deleted: true });
    const count = (t: string, u: string) => (ctx.raw.prepare(`SELECT COUNT(*) n FROM ${t} WHERE ${t === "users" ? "id" : "user_id"} = ?`).get(u) as any).n;
    for (const t of ["interests", "matches", "events", "webhooks", "webhook_attempts", "api_tokens", "users"]) {
      expect([t, count(t, "user-a")]).toEqual([t, 0]);
      expect(count(t, "user-b")).toBeGreaterThan(0);
    }
    // old token no longer works
    expect((await worker.fetch(new Request("https://rw.test/mcp", { method: "POST", headers: { authorization: `Bearer ${tokA}` }, body: "{}" }), env)).status).toBe(401);
  });

  it("also revokes the user's OAuth data", async () => {
    ctx.raw.prepare("INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES ('c1','c','[]',?)").run(T0);
    const future = "2999-01-01T00:00:00.000Z";
    const oauth: Record<string, string> = {};
    for (const u of ["user-a", "user-b"]) {
      oauth[u] = `rwo_${u}`;
      ctx.raw.prepare("INSERT INTO oauth_tokens (id, client_id, user_id, access_hash, refresh_hash, scopes, access_expires_at, refresh_expires_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(`t-${u}`, "c1", u, await sha256Hex(oauth[u]!), await sha256Hex(`rwr_${u}`), "read write", future, future, T0);
      ctx.raw.prepare("INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scopes, expires_at) VALUES (?,?,?,?,?,?,?)")
        .run(`code-${u}`, "c1", u, "http://localhost/cb", "x", "read write", future);
    }
    expect((await tool(oauth["user-a"]!, "list_interests")).isError).toBe(false);
    expect((await tool(oauth["user-a"]!, "delete_my_data", { confirm: true })).structuredContent).toEqual({ deleted: true });
    const status = async (t: string) =>
      (await worker.fetch(new Request("https://rw.test/mcp", { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) }), env)).status;
    expect(await status(oauth["user-a"]!)).toBe(401);
    expect(await status(oauth["user-b"]!)).toBe(200);
    const n = (t: string, u: string) => (ctx.raw.prepare(`SELECT COUNT(*) n FROM ${t} WHERE user_id = ?`).get(u) as any).n;
    expect([n("oauth_tokens", "user-a"), n("oauth_codes", "user-a")]).toEqual([0, 0]);
    expect([n("oauth_tokens", "user-b"), n("oauth_codes", "user-b")]).toEqual([1, 1]);
  });
});
