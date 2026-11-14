import { beforeEach, describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index";
import { createToken } from "../src/auth";
import { makeDb } from "./helpers";

const O = "https://rw.test";
const REDIR = "http://localhost:8123/cb";
let ctx: ReturnType<typeof makeDb>;
let env: Env;
let ghUser = 4242;
let ghCalls: string[];

const fakeGithub: typeof fetch = async (input, init) => {
  const url = String(input);
  ghCalls.push(url);
  if (url === "https://github.com/login/oauth/access_token") {
    return Response.json(JSON.parse(String(init?.body)).code === "gh-code" ? { access_token: "gho_x" } : { error: "bad_verification_code" });
  }
  if (url === "https://api.github.com/user") return Response.json({ id: ghUser, login: "someone" });
  return new Response("nope", { status: 500 });
};

const hit = (path: string, init: RequestInit = {}, e: Env = env) => import("../src/oauth").then((m) => m.handleOAuthRoute(new Request(O + path, init), e, fakeGithub));
const form = (o: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString() });
const b64u = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const pkce = async (verifier = "v".repeat(50)) => ({ verifier, challenge: b64u(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))) });

async function register(uris: string[] = [REDIR]) {
  const r = await hit("/register", { method: "POST", body: JSON.stringify({ client_name: "Test <Agent>", redirect_uris: uris }) });
  return ((await r.json()) as { client_id: string }).client_id;
}

/** Runs authorize -> approve -> GitHub callback; returns the final redirect to the client. */
async function login(clientId: string, challenge: string, opts: { redirect_uri?: string; state?: string } = {}) {
  const q = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: opts.redirect_uri ?? REDIR, state: opts.state ?? "xyz",
    code_challenge: challenge, code_challenge_method: "S256", scope: "read write",
  });
  const page = await hit(`/authorize?${q}`);
  expect(page.status).toBe(200);
  const html = await page.text();
  const cookie = page.headers.get("set-cookie")!.split(";")[0]!;
  const fields: Record<string, string> = {};
  for (const m of html.matchAll(/name="(\w+)" value="([^"]*)"/g)) fields[m[1]!] = m[2]!.replace(/&amp;/g, "&");
  const approve = await hit("/authorize", { ...form({ ...fields, decision: "approve" }), headers: { "content-type": "application/x-www-form-urlencoded", cookie } });
  expect(approve.status).toBe(302);
  const gh = new URL(approve.headers.get("location")!);
  expect(gh.origin + gh.pathname).toBe("https://github.com/login/oauth/authorize");
  expect(gh.searchParams.get("redirect_uri")).toBe(`${O}/oauth/callback`);
  const state = gh.searchParams.get("state")!;
  const cb = await hit(`/oauth/callback?${new URLSearchParams({ code: "gh-code", state })}`, { headers: { cookie } });
  return { cb, state, cookie, html };
}
const exchange = (clientId: string, code: string, verifier: string, redirect_uri = REDIR) =>
  hit("/token", form({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri }));
async function fullFlow(user = 4242) {
  ghUser = user;
  const client = await register();
  const { verifier, challenge } = await pkce();
  const { cb } = await login(client, challenge);
  const loc = new URL(cb.headers.get("location")!);
  const code = loc.searchParams.get("code")!;
  return { client, verifier, code, loc };
}
const mcp = (token: string, method = "tools/list") =>
  worker.fetch(new Request(`${O}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }) }), env);

beforeEach(() => {
  ctx = makeDb();
  env = { DB: ctx.db, FETCH_QUEUE: { send: async () => {} }, GITHUB_CLIENT_ID: "gh-id", GITHUB_CLIENT_SECRET: "gh-secret" };
  ghCalls = [];
});

describe("oauth", () => {
  it("full PKCE flow ends in a working tools/list, API tokens still work, and nothing secret is stored in plaintext", async () => {
    const { client, verifier, code, loc } = await fullFlow();
    expect(loc.origin + loc.pathname).toBe(REDIR);
    expect(loc.searchParams.get("state")).toBe("xyz");
    expect(ctx.raw.prepare("SELECT id FROM users WHERE id = 'github:4242'").get()).toBeTruthy();
    const tr = await exchange(client, code, verifier);
    expect(tr.status).toBe(200);
    const t = (await tr.json()) as { access_token: string; refresh_token: string; expires_in: number; token_type: string };
    expect(t).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
    const r = await mcp(t.access_token);
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).result.tools.length).toBeGreaterThan(0);

    const api = (await createToken(ctx.db, "self-hosted", "x")).token;
    expect((await mcp(api)).status).toBe(200);
    expect((await mcp("rwo_garbage")).status).toBe(401);

    const dump = JSON.stringify(["oauth_codes", "oauth_tokens", "oauth_clients"].map((tb) => ctx.raw.prepare(`SELECT * FROM ${tb}`).all()));
    for (const secret of [code, t.access_token, t.refresh_token]) expect(dump).not.toContain(secret);
  });

  it("rejects a bad PKCE verifier and a reused code", async () => {
    const { client, verifier, code } = await fullFlow();
    const bad = await exchange(client, code, "w".repeat(50));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error).toBe("invalid_grant");
    // the failed attempt burned the code
    expect((await exchange(client, code, verifier)).status).toBe(400);

    const again = await fullFlow();
    expect((await exchange(again.client, again.code, again.verifier)).status).toBe(200);
    expect((await exchange(again.client, again.code, again.verifier)).status).toBe(400);
  });

  it("rejects a code exchanged with a different redirect_uri or client", async () => {
    const { client, verifier, code } = await fullFlow();
    expect((await exchange(client, code, verifier, "http://localhost:9/other")).status).toBe(400);
    const f = await fullFlow();
    const other = await register();
    expect((await exchange(other, f.code, f.verifier)).status).toBe(400);
  });

  it("returns 401 for an expired access token", async () => {
    const { client, verifier, code } = await fullFlow();
    const t = (await (await exchange(client, code, verifier)).json()) as { access_token: string };
    ctx.raw.prepare("UPDATE oauth_tokens SET access_expires_at = ?").run(new Date(Date.now() - 1000).toISOString());
    expect((await mcp(t.access_token)).status).toBe(401);
  });

  it("rotates refresh tokens: the old one is rejected and the new pair works", async () => {
    const { client, verifier, code } = await fullFlow();
    const t1 = (await (await exchange(client, code, verifier)).json()) as { access_token: string; refresh_token: string };
    const rf = (rt: string) => hit("/token", form({ grant_type: "refresh_token", client_id: client, refresh_token: rt }));
    const r2 = await rf(t1.refresh_token);
    expect(r2.status).toBe(200);
    const t2 = (await r2.json()) as { access_token: string; refresh_token: string };
    expect(t2.refresh_token).not.toBe(t1.refresh_token);
    expect((await rf(t1.refresh_token)).status).toBe(400);
    expect((await mcp(t1.access_token)).status).toBe(401);
    expect((await mcp(t2.access_token)).status).toBe(200);
    // wrong client cannot use the refresh token
    expect((await hit("/token", form({ grant_type: "refresh_token", client_id: await register(), refresh_token: t2.refresh_token }))).status).toBe(400);
    expect((await rf(t2.refresh_token)).status).toBe(200);
  });

  it("revokes tokens via /revoke (always 200)", async () => {
    const { client, verifier, code } = await fullFlow();
    const t = (await (await exchange(client, code, verifier)).json()) as { access_token: string; refresh_token: string };
    expect((await hit("/revoke", form({ token: t.refresh_token, client_id: client }))).status).toBe(200);
    expect((await mcp(t.access_token)).status).toBe(401);
    expect((await hit("/token", form({ grant_type: "refresh_token", client_id: client, refresh_token: t.refresh_token }))).status).toBe(400);
    expect((await hit("/revoke", form({ token: "unknown", client_id: client }))).status).toBe(200);
  });

  it("revoke by another client does not revoke", async () => {
    const { client, verifier, code } = await fullFlow();
    const t = (await (await exchange(client, code, verifier)).json()) as { access_token: string };
    await hit("/revoke", form({ token: t.access_token, client_id: await register() }));
    expect((await mcp(t.access_token)).status).toBe(200);
  });

  it("validates the authorize request: redirect_uri mismatch, PKCE, state", async () => {
    const client = await register();
    const { challenge } = await pkce();
    const base = { response_type: "code", client_id: client, redirect_uri: REDIR, state: "s", code_challenge: challenge, code_challenge_method: "S256" };
    const get = (o: Record<string, string>) => hit(`/authorize?${new URLSearchParams({ ...base, ...o })}`);
    for (const redirect_uri of ["http://localhost:8123/cb2", "http://localhost:8124/cb", "https://evil.test/cb"]) {
      const r = await get({ redirect_uri });
      expect(r.status).toBe(400); // never redirected
      expect(r.headers.get("location")).toBeNull();
    }
    expect((await get({ client_id: "nope" })).status).toBe(400);
    for (const o of <Record<string, string>[]>[{ code_challenge_method: "plain" }, { code_challenge: "" }, { state: "" }, { scope: "admin" }, { response_type: "token" }]) {
      const r = await get(o);
      expect(r.status).toBe(302);
      expect(new URL(r.headers.get("location")!).searchParams.get("error")).toBeTruthy();
    }
    const page = await (await get({})).text();
    expect(page).toContain("Authorize Test &lt;Agent&gt; to read and manage your reqwatch interests");
  });

  it("deny redirects with access_denied; POST without the CSRF cookie is refused", async () => {
    const client = await register();
    const { challenge } = await pkce();
    const q = { response_type: "code", client_id: client, redirect_uri: REDIR, state: "s", code_challenge: challenge, code_challenge_method: "S256", scope: "read" };
    const page = await hit(`/authorize?${new URLSearchParams(q)}`);
    const html = await page.text();
    const cookie = page.headers.get("set-cookie")!.split(";")[0]!;
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
    const post = (decision: string, c?: string) =>
      hit("/authorize", { ...form({ ...q, csrf, decision }), headers: { "content-type": "application/x-www-form-urlencoded", ...(c ? { cookie: c } : {}) } });
    expect((await post("approve")).status).toBe(403);
    expect((await post("approve", "rw_oauth=other")).status).toBe(403);
    const d = await post("deny", cookie);
    expect(new URL(d.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
  });

  it("rejects tampered, foreign-browser and expired state at the callback", async () => {
    const client = await register();
    const { challenge } = await pkce();
    const { state, cookie } = await login(client, challenge);
    const cb = (s: string, c = cookie) => hit(`/oauth/callback?${new URLSearchParams({ code: "gh-code", state: s })}`, { headers: { cookie: c } });
    const [body, sig] = state.split(".");
    const forged = JSON.parse(atob(body!.replace(/-/g, "+").replace(/_/g, "/")));
    forged.redirect_uri = "https://evil.test/cb";
    const tampered = `${btoa(JSON.stringify(forged)).replace(/=+$/, "")}.${sig}`;
    expect((await cb(tampered)).status).toBe(400);
    expect((await cb(`${body}.AAAA`)).status).toBe(400);
    expect((await cb("garbage")).status).toBe(400);
    expect((await cb(state, "rw_oauth=different")).status).toBe(400); // login CSRF: not the browser that approved
    expect((await cb(state)).status).toBe(302);
  });

  it("returns an error to the client when GitHub rejects the code", async () => {
    const client = await register();
    const { challenge } = await pkce();
    const { state, cookie } = await login(client, challenge);
    const r = await hit(`/oauth/callback?${new URLSearchParams({ code: "wrong", state })}`, { headers: { cookie } });
    expect(new URL(r.headers.get("location")!).searchParams.get("error")).toBe("server_error");
    expect(ctx.raw.prepare("SELECT COUNT(*) n FROM oauth_codes").get()).toEqual({ n: 1 }); // only from login()'s successful callback
  });

  it("validates dynamic client registration", async () => {
    const reg = (b: unknown) => hit("/register", { method: "POST", body: typeof b === "string" ? b : JSON.stringify(b) });
    const ok = await reg({ client_name: "X", redirect_uris: ["https://app.test/cb", "http://127.0.0.1:1/cb"] });
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] });
    for (const bad of [
      "not json", [], {}, { redirect_uris: [] }, { redirect_uris: "https://a.test/cb" },
      { redirect_uris: ["http://example.com/cb"] }, { redirect_uris: ["https://a.test/cb#frag"] }, { redirect_uris: ["myapp://cb"] },
      { redirect_uris: ["https://a.test/cb"], token_endpoint_auth_method: "client_secret_basic" },
      { redirect_uris: ["https://a.test/cb"], grant_types: ["password"] },
      { redirect_uris: ["https://a.test/cb"], client_name: "x".repeat(101) },
    ]) {
      const r = await reg(bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("isolates tenants: user A's token only sees A's data", async () => {
    const a = await fullFlow(1);
    const ta = (await (await exchange(a.client, a.code, a.verifier)).json()) as { access_token: string };
    const b = await fullFlow(2);
    const tb = (await (await exchange(b.client, b.code, b.verifier)).json()) as { access_token: string };
    const call = async (tok: string, name: string, args: unknown) =>
      ((await (await worker.fetch(new Request(`${O}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), env)).json()) as any).result;
    const made = await call(ta.access_token, "create_interest", { name: "mine", role_families: ["software_engineering"] });
    expect(made.isError).toBe(false);
    expect(JSON.stringify((await call(ta.access_token, "list_interests", {})).structuredContent)).toContain("mine");
    expect(JSON.stringify((await call(tb.access_token, "list_interests", {})).structuredContent)).not.toContain("mine");
    expect(ctx.raw.prepare("SELECT user_id FROM interests").all()).toEqual([{ user_id: "github:1" }]);
  });

  it("is off when GitHub is not configured: 503 on /authorize, other routes 404, no advertised issuer", async () => {
    const bare: Env = { DB: ctx.db, FETCH_QUEUE: env.FETCH_QUEUE };
    const r = await hit("/authorize?client_id=x", {}, bare);
    expect(r.status).toBe(503);
    expect(await r.text()).toContain("Hosted login not configured");
    expect((await hit("/register", { method: "POST", body: "{}" }, bare)).status).toBe(404);
    const prm = async (e: Env) => ((await (await worker.fetch(new Request(`${O}/.well-known/oauth-protected-resource`), e)).json()) as any).authorization_servers;
    expect(await prm(bare)).toEqual([]);
    expect(await prm(env)).toEqual([O]);
    expect(await prm({ ...env, AUTH_ISSUER: "https://issuer.test" })).toEqual(["https://issuer.test"]);
  });

  it("serves authorization server metadata", async () => {
    const m = (await (await worker.fetch(new Request(`${O}/.well-known/oauth-authorization-server`), env)).json()) as any;
    expect(m).toMatchObject({ issuer: O, authorization_endpoint: `${O}/authorize`, token_endpoint: `${O}/token`, registration_endpoint: `${O}/register`, code_challenge_methods_supported: ["S256"] });
  });
});
