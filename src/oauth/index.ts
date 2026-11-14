import { bearerToken, sha256Hex, safeEqual, type AuthResult, type Authenticator, authenticateApiToken } from "../auth";
import type { Env } from "../index";

export const ACCESS_PREFIX = "rwo_";
export const REFRESH_PREFIX = "rwr_";
export const ACCESS_TTL_S = 3600;
export const REFRESH_TTL_S = 30 * 86400;
const CODE_TTL_S = 600;
const STATE_TTL_S = 600;
export const SCOPES = ["read", "write"];

export const oauthConfigured = (env: Env) => !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
const origin = (req: Request) => new URL(req.url).origin;
const iso = (ms: number) => new Date(ms).toISOString();

const b64u = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64uDecode = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const randomToken = (prefix: string) => prefix + b64u(crypto.getRandomValues(new Uint8Array(32)));

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`reqwatch-oauth:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data))));
}

async function signState(secret: string, payload: object): Promise<string> {
  const body = b64u(new TextEncoder().encode(JSON.stringify(payload)));
  return `${body}.${await hmac(secret, body)}`;
}
async function verifyState<T>(secret: string, state: string): Promise<T | null> {
  const [body, sig] = state.split(".");
  if (!body || !sig || !(await safeEqual(sig, await hmac(secret, body)))) return null;
  try {
    return JSON.parse(new TextDecoder().decode(b64uDecode(body))) as T;
  } catch {
    return null;
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const page = (status: number, title: string, body: string, headers: Record<string, string> = {}) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:30rem;margin:12vh auto;padding:0 1rem;color:#1a1a1a}h1{font-size:1.25rem}
button{font:inherit;padding:.5rem 1.2rem;border-radius:6px;border:1px solid #888;background:#f4f4f4;cursor:pointer;margin-right:.5rem}
button.go{background:#1a1a1a;color:#fff;border-color:#1a1a1a}</style></head><body>${body}</body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", ...headers } },
  );

const oerr = (error: string, description: string, status = 400) =>
  Response.json({ error, error_description: description }, { status, headers: { "cache-control": "no-store" } });

/** https, or http on a loopback host; no fragment. */
export function validRedirectUri(u: unknown): u is string {
  if (typeof u !== "string" || u.length > 2000) return false;
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

export function authorizationServerMetadata(req: Request): Response {
  const o = origin(req);
  return Response.json({
    issuer: o,
    authorization_endpoint: `${o}/authorize`,
    token_endpoint: `${o}/token`,
    registration_endpoint: `${o}/register`,
    revocation_endpoint: `${o}/revoke`,
    scopes_supported: SCOPES,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
  });
}

async function register(req: Request, env: Env): Promise<Response> {
  let b: Record<string, unknown>;
  try {
    b = (await req.json()) as Record<string, unknown>;
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error();
  } catch {
    return oerr("invalid_client_metadata", "body must be a JSON object");
  }
  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > 10 || !uris.every(validRedirectUri)) {
    return oerr("invalid_redirect_uri", "redirect_uris must be 1-10 https or loopback http URIs without fragments");
  }
  const name = b.client_name === undefined ? "Unnamed client" : b.client_name;
  if (typeof name !== "string" || !name.trim() || name.length > 100) return oerr("invalid_client_metadata", "client_name must be 1-100 characters");
  if (b.token_endpoint_auth_method !== undefined && b.token_endpoint_auth_method !== "none") {
    return oerr("invalid_client_metadata", "only token_endpoint_auth_method 'none' (public clients with PKCE) is supported");
  }
  const allowOnly = (v: unknown, ok: string[]) => v === undefined || (Array.isArray(v) && v.length > 0 && v.every((x) => ok.includes(x as string)));
  if (!allowOnly(b.grant_types, ["authorization_code", "refresh_token"])) return oerr("invalid_client_metadata", "unsupported grant_types");
  if (!allowOnly(b.response_types, ["code"])) return oerr("invalid_client_metadata", "unsupported response_types");
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare("INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)").bind(id, name.trim(), JSON.stringify(uris), iso(now)).run();
  return Response.json(
    {
      client_id: id,
      client_id_issued_at: Math.floor(now / 1000),
      client_name: name.trim(),
      redirect_uris: uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
}

interface Client { id: string; name: string; redirect_uris: string[] }
async function getClient(env: Env, id: string | null): Promise<Client | null> {
  if (!id) return null;
  const r = (await env.DB.prepare("SELECT id, name, redirect_uris FROM oauth_clients WHERE id = ?").bind(id).all<{ id: string; name: string; redirect_uris: string }>()).results[0];
  return r ? { id: r.id, name: r.name, redirect_uris: JSON.parse(r.redirect_uris) } : null;
}

const redirect = (url: string, headers: Record<string, string> = {}) => new Response(null, { status: 302, headers: { location: url, "cache-control": "no-store", ...headers } });
function withParams(base: string, params: Record<string, string | undefined>): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}
const cookieNonce = (req: Request) => /(?:^|;\s*)rw_oauth=([\w-]+)/.exec(req.headers.get("cookie") ?? "")?.[1] ?? null;
const setNonce = (n: string) => `rw_oauth=${n}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${STATE_TTL_S}`;

interface AuthzParams { client_id: string; redirect_uri: string; state: string; code_challenge: string; scope: string }

/** Validates the authorization request. Client/redirect errors are shown to the user; the rest redirect back to the client. */
async function validateAuthz(env: Env, get: (k: string) => string | null): Promise<{ client: Client; p: AuthzParams } | { response: Response }> {
  const client = await getClient(env, get("client_id"));
  const redirectUri = get("redirect_uri");
  if (!client) return { response: page(400, "Invalid request", "<h1>Invalid request</h1><p>Unknown client.</p>") };
  if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
    return { response: page(400, "Invalid request", "<h1>Invalid request</h1><p>The redirect URI does not match one registered for this client.</p>") };
  }
  const state = get("state") ?? "";
  const fail = (error: string, desc: string) => ({ response: redirect(withParams(redirectUri, { error, error_description: desc, state: state || undefined })) });
  if (get("response_type") !== "code") return fail("unsupported_response_type", "response_type must be code");
  if (!state || state.length > 512) return fail("invalid_request", "state is required (max 512 characters)");
  const challenge = get("code_challenge") ?? "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) return fail("invalid_request", "a valid S256 code_challenge is required");
  if (get("code_challenge_method") !== "S256") return fail("invalid_request", "code_challenge_method must be S256");
  const scope = (get("scope") ?? "").trim() || SCOPES.join(" ");
  const scopes = scope.split(/\s+/);
  if (!scopes.every((s) => SCOPES.includes(s))) return fail("invalid_scope", "supported scopes: read, write");
  return { client, p: { client_id: client.id, redirect_uri: redirectUri, state, code_challenge: challenge, scope: [...new Set(scopes)].join(" ") } };
}

async function authorize(req: Request, env: Env): Promise<Response> {
  if (!oauthConfigured(env)) {
    return page(503, "Hosted login not configured", "<h1>Hosted login not configured</h1><p>This reqwatch instance has no GitHub login set up. Use an API token (<code>Authorization: Bearer rw_…</code>) instead.</p>");
  }
  const secret = env.GITHUB_CLIENT_SECRET!;
  if (req.method === "GET") {
    const v = await validateAuthz(env, (k) => new URL(req.url).searchParams.get(k));
    if ("response" in v) return v.response;
    const nonce = b64u(crypto.getRandomValues(new Uint8Array(16)));
    const csrf = await hmac(secret, `csrf:${nonce}`);
    const hidden = Object.entries({ ...v.p, response_type: "code", code_challenge_method: "S256" }).map(([k, val]) => `<input type="hidden" name="${k}" value="${esc(val)}">`).join("");
    return page(
      200,
      "Authorize",
      `<h1>Authorize ${esc(v.client.name)} to read and manage your reqwatch interests</h1>
<p>Requested access: ${esc(v.p.scope)}. You will sign in with GitHub next.</p>
<form method="post" action="/authorize">${hidden}<input type="hidden" name="csrf" value="${csrf}">
<button class="go" name="decision" value="approve">Approve</button><button name="decision" value="deny">Deny</button></form>`,
      { "set-cookie": setNonce(nonce) },
    );
  }
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });

  const form = await req.formData().catch(() => null);
  const get = (k: string) => (typeof form?.get(k) === "string" ? (form!.get(k) as string) : null);
  const nonce = cookieNonce(req);
  if (!nonce || !(await safeEqual(get("csrf") ?? "", await hmac(secret, `csrf:${nonce}`)))) {
    return page(403, "Forbidden", "<h1>Request expired</h1><p>Please restart the authorization from your client.</p>");
  }
  const v = await validateAuthz(env, get);
  if ("response" in v) return v.response;
  if (get("decision") !== "approve") {
    return redirect(withParams(v.p.redirect_uri, { error: "access_denied", error_description: "The user denied the request", state: v.p.state }));
  }
  const state = await signState(secret, { ...v.p, nonce, exp: Date.now() + STATE_TTL_S * 1000 });
  return redirect(
    withParams("https://github.com/login/oauth/authorize", {
      client_id: env.GITHUB_CLIENT_ID,
      redirect_uri: `${origin(req)}/oauth/callback`,
      scope: "read:user",
      state,
    }),
  );
}

async function callback(req: Request, env: Env, fetchImpl: typeof fetch): Promise<Response> {
  if (!oauthConfigured(env)) return new Response("Not found", { status: 404 });
  const q = new URL(req.url).searchParams;
  const st = await verifyState<AuthzParams & { nonce: string; exp: number }>(env.GITHUB_CLIENT_SECRET!, q.get("state") ?? "");
  const nonce = cookieNonce(req);
  if (!st || st.exp < Date.now() || !nonce || !(await safeEqual(nonce, st.nonce))) {
    return page(400, "Invalid request", "<h1>Invalid or expired login</h1><p>Please restart the authorization from your client.</p>");
  }
  const client = await getClient(env, st.client_id);
  if (!client || !client.redirect_uris.includes(st.redirect_uri)) return page(400, "Invalid request", "<h1>Invalid request</h1>");
  const back = (params: Record<string, string>) => redirect(withParams(st.redirect_uri, { ...params, state: st.state }), { "set-cookie": "rw_oauth=; Path=/; Max-Age=0" });

  const ghCode = q.get("code");
  if (q.get("error") || !ghCode) return back({ error: "access_denied", error_description: "GitHub login was not completed" });
  let ghId: number | null = null;
  try {
    const tok = (await (await fetchImpl("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code: ghCode, redirect_uri: `${origin(req)}/oauth/callback` }),
    })).json()) as { access_token?: string };
    if (tok.access_token) {
      const u = await fetchImpl("https://api.github.com/user", {
        headers: { authorization: `Bearer ${tok.access_token}`, accept: "application/vnd.github+json", "user-agent": "reqwatch" },
      });
      const j = (await u.json()) as { id?: unknown };
      if (u.ok && typeof j.id === "number") ghId = j.id;
    }
  } catch {
    ghId = null;
  }
  if (ghId === null) return back({ error: "server_error", error_description: "GitHub login failed" });

  const user_id = `github:${ghId}`;
  const now = Date.now();
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)").bind(user_id, iso(now)).run();
  const code = randomToken("rwc_");
  await env.DB
    .prepare("INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scopes, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(await sha256Hex(code), st.client_id, user_id, st.redirect_uri, st.code_challenge, st.scope, iso(now + CODE_TTL_S * 1000))
    .run();
  return back({ code, iss: origin(req) });
}

async function issueTokens(env: Env, client_id: string, user_id: string, scopes: string, now: number): Promise<Response> {
  const access = randomToken(ACCESS_PREFIX);
  const refresh = randomToken(REFRESH_PREFIX);
  await env.DB
    .prepare("INSERT INTO oauth_tokens (id, client_id, user_id, access_hash, refresh_hash, scopes, access_expires_at, refresh_expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), client_id, user_id, await sha256Hex(access), await sha256Hex(refresh), scopes, iso(now + ACCESS_TTL_S * 1000), iso(now + REFRESH_TTL_S * 1000), iso(now))
    .run();
  return Response.json(
    { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: scopes },
    { headers: { "cache-control": "no-store", pragma: "no-cache" } },
  );
}

async function token(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  const form = await req.formData().catch(() => null);
  const get = (k: string) => (typeof form?.get(k) === "string" ? (form!.get(k) as string) : "");
  const now = Date.now();
  const client = await getClient(env, get("client_id"));
  if (!client) return oerr("invalid_client", "unknown client_id", 401);
  const grant = get("grant_type");

  if (grant === "authorization_code") {
    const code = get("code");
    const hash = await sha256Hex(code);
    // Atomically consume the code: a second presentation finds used_at set and gets nothing back.
    const row = (
      await env.DB
        .prepare("UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL RETURNING client_id, user_id, redirect_uri, code_challenge, scopes, expires_at")
        .bind(iso(now), hash)
        .all<{ client_id: string; user_id: string; redirect_uri: string; code_challenge: string; scopes: string; expires_at: string }>()
    ).results[0];
    if (!row || row.client_id !== client.id || row.expires_at < iso(now) || row.redirect_uri !== get("redirect_uri")) {
      return oerr("invalid_grant", "invalid, expired or already used authorization code");
    }
    const verifier = get("code_verifier");
    const challenge = b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !(await safeEqual(challenge, row.code_challenge))) {
      return oerr("invalid_grant", "PKCE verification failed");
    }
    return issueTokens(env, client.id, row.user_id, row.scopes, now);
  }

  if (grant === "refresh_token") {
    // Rotation: the presented refresh token is revoked atomically; presenting it again fails.
    const row = (
      await env.DB
        .prepare("UPDATE oauth_tokens SET revoked_at = ? WHERE refresh_hash = ? AND client_id = ? AND revoked_at IS NULL AND refresh_expires_at > ? RETURNING user_id, scopes")
        .bind(iso(now), await sha256Hex(get("refresh_token")), client.id, iso(now))
        .all<{ user_id: string; scopes: string }>()
    ).results[0];
    if (!row) return oerr("invalid_grant", "invalid, expired or revoked refresh token");
    return issueTokens(env, client.id, row.user_id, row.scopes, now);
  }
  return oerr("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
}

async function revoke(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  const form = await req.formData().catch(() => null);
  const t = typeof form?.get("token") === "string" ? (form!.get("token") as string) : "";
  const cid = typeof form?.get("client_id") === "string" ? (form!.get("client_id") as string) : "";
  if (t && cid) {
    const h = await sha256Hex(t);
    await env.DB
      .prepare("UPDATE oauth_tokens SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL AND (access_hash = ? OR refresh_hash = ?)")
      .bind(new Date().toISOString(), cid, h, h)
      .run();
  }
  return new Response(null, { status: 200, headers: { "cache-control": "no-store" } }); // RFC 7009: always 200
}

export const OAUTH_PATHS = ["/.well-known/oauth-authorization-server", "/register", "/authorize", "/token", "/revoke", "/oauth/callback"];

export async function handleOAuthRoute(req: Request, env: Env, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (path === "/authorize") return authorize(req, env);
  if (!oauthConfigured(env)) return new Response("Not found", { status: 404 });
  switch (path) {
    case "/.well-known/oauth-authorization-server":
      return req.method === "GET" ? authorizationServerMetadata(req) : new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
    case "/register":
      return req.method === "POST" ? register(req, env) : new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
    case "/oauth/callback":
      return callback(req, env, fetchImpl);
    case "/token":
      return token(req, env);
    case "/revoke":
      return revoke(req, env);
  }
  return new Response("Not found", { status: 404 });
}

/** Validates an OAuth access token (hash lookup, not revoked, not expired). */
export const authenticateOAuthToken: Authenticator = async (req, env) => {
  const t = bearerToken(req);
  if (!t?.startsWith(ACCESS_PREFIX)) return null;
  const row = (
    await env.DB
      .prepare("SELECT user_id, scopes FROM oauth_tokens WHERE access_hash = ? AND revoked_at IS NULL AND access_expires_at > ?")
      .bind(await sha256Hex(t), new Date().toISOString())
      .all<{ user_id: string; scopes: string }>()
  ).results[0];
  return row ? ({ user_id: row.user_id, scopes: row.scopes.split(" ").filter(Boolean) } satisfies AuthResult) : null;
};

/** Accepts either an rw_ API token or an OAuth access token. */
export const authenticateAny: Authenticator = async (req, env) => (await authenticateApiToken(req, env)) ?? (await authenticateOAuthToken(req, env));
