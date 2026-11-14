import type { Db } from "./db";
import type { Env } from "./index";

export interface AuthResult {
  user_id: string;
  scopes: string[];
}
/** Pluggable authentication: returns null when the request carries no valid credential. */
export type Authenticator = (request: Request, env: Env) => Promise<AuthResult | null>;

export const TOKEN_PREFIX = "rw_";
export const RATE_LIMIT = 60;
export const RATE_WINDOW_SECONDS = 60;

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
export const sha256Hex = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Constant-time string comparison (compares fixed-length digests, so length does not leak). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/** Creates a token for a user. The plaintext is returned once and never stored. */
export async function createToken(
  db: Db,
  user_id: string,
  name: string,
  scopes: string[] = ["read", "write"],
  now = new Date().toISOString(),
): Promise<{ id: string; token: string }> {
  const token = TOKEN_PREFIX + base64url(crypto.getRandomValues(new Uint8Array(32)));
  const id = crypto.randomUUID();
  await db.prepare("INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)").bind(user_id, now).run();
  await db
    .prepare("INSERT INTO api_tokens (id, user_id, token_hash, name, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, user_id, await sha256Hex(token), name, scopes.join(" "), now)
    .run();
  return { id, token };
}

export const bearerToken = (req: Request): string | null => {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  return m ? m[1]! : null;
};

/** v1 authenticator: opaque API tokens looked up by SHA-256 hash. */
export const authenticateApiToken: Authenticator = async (req, env) => {
  const token = bearerToken(req);
  if (!token?.startsWith(TOKEN_PREFIX)) return null;
  const hash = await sha256Hex(token);
  const row = (
    await env.DB
      .prepare("SELECT id, user_id, scopes FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL")
      .bind(hash)
      .all<{ id: string; user_id: string; scopes: string }>()
  ).results[0];
  if (!row) return null;
  await env.DB.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").bind(new Date().toISOString(), row.id).run();
  return { user_id: row.user_id, scopes: row.scopes.split(" ").filter(Boolean) };
};

/** Fixed-window counter per user. Returns null when allowed, else seconds until the window resets. */
export async function checkRateLimit(db: Db, user_id: string, nowMs = Date.now()): Promise<number | null> {
  const nowS = Math.floor(nowMs / 1000);
  const start = nowS - (nowS % RATE_WINDOW_SECONDS);
  await db
    .prepare(
      "INSERT INTO rate_limits (user_id, window_start, count) VALUES (?, ?, 1) ON CONFLICT(user_id, window_start) DO UPDATE SET count = count + 1",
    )
    .bind(user_id, start)
    .run();
  await db.prepare("DELETE FROM rate_limits WHERE user_id = ? AND window_start < ?").bind(user_id, start).run();
  const row = (
    await db.prepare("SELECT count FROM rate_limits WHERE user_id = ? AND window_start = ?").bind(user_id, start).all<{ count: number }>()
  ).results[0];
  return (row?.count ?? 0) > RATE_LIMIT ? start + RATE_WINDOW_SECONDS - nowS : null;
}

/** POST /admin/tokens, guarded by env.ADMIN_SECRET. 404 when the secret is unset. */
export async function handleAdminTokens(req: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_SECRET) return new Response("Not found", { status: 404 });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  const presented = bearerToken(req) ?? "";
  if (!(await safeEqual(presented, env.ADMIN_SECRET))) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
  }
  let body: { user_id?: unknown; name?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const uid = body?.user_id;
  if (!name || name.length > 100 || (uid !== undefined && (typeof uid !== "string" || !uid.trim() || uid.length > 200))) {
    return Response.json({ error: "invalid_body", detail: "name (1-100 chars) required; user_id optional string" }, { status: 400 });
  }
  const user_id = (uid as string | undefined)?.trim() ?? crypto.randomUUID();
  const { id, token } = await createToken(env.DB, user_id, name);
  return Response.json({ id, user_id, name, token }, { status: 201, headers: { "Cache-Control": "no-store" } });
}
