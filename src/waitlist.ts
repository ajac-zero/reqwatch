import type { Db } from "./db";

const SALT = "reqwatch-waitlist-v1";
const WINDOW_MS = 3_600_000;
export const WAITLIST_MAX_PER_HOUR = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

const redirect = (to: string) => new Response(null, { status: 303, headers: { location: to } });

async function hashIp(ip: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(SALT + ip));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return email.length <= 254 && EMAIL_RE.test(email) ? email : null;
}

export async function handleWaitlist(req: Request, env: { DB: Db }, now = Date.now()): Promise<Response> {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
  const fail = redirect("/?error=1");
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) return fail;
  let email: string | null;
  try {
    email = normalizeEmail(new URLSearchParams(await req.text()).get("email"));
  } catch {
    return fail;
  }
  if (!email) return fail;

  const ipHash = await hashIp(req.headers.get("cf-connecting-ip") ?? "unknown");
  const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  await env.DB.prepare("DELETE FROM waitlist_rate WHERE window_start < ?").bind(windowStart).run();
  await env.DB
    .prepare(
      "INSERT INTO waitlist_rate (ip_hash, window_start, count) VALUES (?, ?, 1) ON CONFLICT(ip_hash, window_start) DO UPDATE SET count = count + 1",
    )
    .bind(ipHash, windowStart)
    .run();
  const row = (
    await env.DB
      .prepare("SELECT count FROM waitlist_rate WHERE ip_hash = ? AND window_start = ?")
      .bind(ipHash, windowStart)
      .all<{ count: number }>()
  ).results[0];
  if (!row || row.count > WAITLIST_MAX_PER_HOUR) return fail;

  await env.DB
    .prepare("INSERT OR IGNORE INTO waitlist (email, created_at, ip_hash, source) VALUES (?, ?, ?, 'landing')")
    .bind(email, now, ipHash)
    .run();
  return redirect("/?joined=1");
}
