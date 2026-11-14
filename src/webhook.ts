import type { Db } from "./db";
import type { Env } from "./index";
import { listMatches } from "./matches";
import { globalFetch } from "./types";

export const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 6 * 3600_000, 24 * 3600_000];
export const DISABLE_AFTER_MS = 7 * 24 * 3600_000;
export const WEBHOOK_BATCH_LIMIT = 20;
export const DELIVERY_BATCH_SIZE = 50;
export const DELIVERY_TIMEOUT_MS = 10_000;

const enc = new TextEncoder();
const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Returns an error message, or null when the URL is acceptable for webhook delivery. */
export function validateWebhookUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "webhook_url is not a valid URL";
  }
  if (u.protocol !== "https:") return "webhook_url must use https";
  if (u.username || u.password) return "webhook_url must not contain credentials";
  if (u.port !== "" && u.port !== "443") return "webhook_url must use port 443";
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") || host.includes(":")) return "webhook_url must not use an IP address";
  const labels = host.split(".");
  // The URL parser normalizes 127.1, 0x7f.1, 2130706433 etc. to dotted decimal, but a numeric last label also covers any leftovers.
  if (/^(0x[0-9a-f]*|\d+)$/i.test(labels.at(-1)!)) return "webhook_url must not use an IP address";
  if (labels.length < 2) return "webhook_url must use a public domain name";
  if (host === "localhost" || /\.(localhost|internal|local|localdomain|lan|home|corp|intranet)$/.test(host))
    return "webhook_url must not point at a local or internal host";
  return null;
}

async function kekKey(kek: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", enc.encode(kek)), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(kek: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await kekKey(kek), enc.encode(secret)));
  return b64(new Uint8Array([...iv, ...ct]));
}

export async function decryptSecret(kek: string, stored: string): Promise<string> {
  const raw = unb64(stored);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, await kekKey(kek), raw.slice(12));
  return new TextDecoder().decode(pt);
}

export const newSecret = () => `whsec_${hex(crypto.getRandomValues(new Uint8Array(32)))}`;

/** Hex HMAC-SHA256 of `${timestamp}.${body}`; the header value is `sha256=` + this. */
export async function sign(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(`${timestamp}.${body}`)));
}

interface WebhookRow {
  user_id: string; url: string; secret_enc: string; fail_since: string | null; last_event_seq: number;
  a_from: number | null; a_to: number | null; attempt: number | null;
}

/**
 * Delivers pending match events to each due, enabled webhook (at most `limit` per run). At-least-once: receivers
 * should dedupe on event_id, which is stable for a batch across retries.
 */
export async function deliverWebhooks(
  env: Pick<Env, "DB" | "WEBHOOK_KEK">,
  now: string,
  opts: { fetchImpl?: typeof fetch; limit?: number } = {},
): Promise<{ delivered: number; failed: number }> {
  const out = { delivered: 0, failed: 0 };
  if (!env.WEBHOOK_KEK) return out;
  const db = env.DB;
  const fetchImpl = opts.fetchImpl ?? globalFetch;
  const rows = (
    await db
      .prepare(
        `SELECT w.user_id, w.url, w.secret_enc, w.fail_since, w.last_event_seq,
           a.event_seq_from AS a_from, a.event_seq_to AS a_to, a.attempt
         FROM webhooks w LEFT JOIN webhook_attempts a ON a.user_id = w.user_id
         WHERE w.disabled_at IS NULL AND (a.next_attempt_at IS NULL OR a.next_attempt_at <= ?)
           AND EXISTS (SELECT 1 FROM events e WHERE e.user_id = w.user_id AND e.type = 'match' AND e.seq > w.last_event_seq)
         ORDER BY COALESCE(a.next_attempt_at, ''), w.user_id LIMIT ?`,
      )
      .bind(now, opts.limit ?? WEBHOOK_BATCH_LIMIT)
      .all<WebhookRow>()
  ).results;

  for (const w of rows) {
    try {
      const { items } = await listMatches(db, w.user_id, { since_cursor: String(w.last_event_seq), limit: DELIVERY_BATCH_SIZE });
      const to = w.a_to ?? items.at(-1)?.event_seq;
      if (to === undefined) continue;
      const matches = items.filter((i) => i.event_seq <= to);
      const from = w.a_from ?? w.last_event_seq;
      const eventId = `evt_${from}_${to}`;
      const body = JSON.stringify({ event_id: eventId, cursor: String(to), matches });
      const ts = String(Math.floor(Date.parse(now) / 1000));

      let status: number | null = null;
      let error: string | null = null;
      const urlError = validateWebhookUrl(w.url);
      if (urlError) error = urlError;
      else {
        try {
          const secret = await decryptSecret(env.WEBHOOK_KEK, w.secret_enc);
          const res = await fetchImpl(w.url, {
            method: "POST",
            redirect: "manual",
            signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
            headers: {
              "content-type": "application/json",
              "x-reqwatch-signature": `sha256=${await sign(secret, ts, body)}`,
              "x-reqwatch-timestamp": ts,
              "x-reqwatch-event-id": eventId,
            },
            body,
          });
          status = res.status;
          if (status < 200 || status > 299) error = status >= 300 && status < 400 ? `redirect (${status}) not followed` : `http ${status}`;
        } catch (e) {
          error = e instanceof Error ? e.name === "TimeoutError" ? "timeout" : e.message : "fetch failed";
        }
      }

      if (!error) {
        await db.prepare("UPDATE webhooks SET last_event_seq = ?, fail_since = NULL WHERE user_id = ?").bind(to, w.user_id).run();
        await db.prepare("DELETE FROM webhook_attempts WHERE user_id = ?").bind(w.user_id).run();
        out.delivered++;
        continue;
      }
      out.failed++;
      const failSince = w.fail_since ?? now;
      if (Date.parse(now) - Date.parse(failSince) >= DISABLE_AFTER_MS) {
        await db.prepare("UPDATE webhooks SET disabled_at = ?, fail_since = ? WHERE user_id = ?").bind(now, failSince, w.user_id).run();
        await db.prepare("DELETE FROM webhook_attempts WHERE user_id = ?").bind(w.user_id).run();
        continue;
      }
      const attempt = (w.attempt ?? 0) + 1;
      const next = new Date(Date.parse(now) + BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]!).toISOString();
      await db.prepare("UPDATE webhooks SET fail_since = ? WHERE user_id = ?").bind(failSince, w.user_id).run();
      await db
        .prepare(
          `INSERT INTO webhook_attempts (user_id, event_seq_from, event_seq_to, attempt, next_attempt_at, last_status, last_error)
           VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(user_id) DO UPDATE SET attempt = excluded.attempt, next_attempt_at = excluded.next_attempt_at,
             last_status = excluded.last_status, last_error = excluded.last_error`,
        )
        .bind(w.user_id, from, to, attempt, next, status, error)
        .run();
    } catch {
      out.failed++; // isolate one tenant's failure from the rest of the run
    }
  }
  return out;
}

export async function setWebhook(db: Db, user_id: string, url: string, kek: string, now: string): Promise<string> {
  const secret = newSecret();
  const secret_enc = await encryptSecret(kek, secret);
  const max = (
    await db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE user_id = ?").bind(user_id).all<{ m: number }>()
  ).results[0]!.m;
  // Re-configuring rotates the secret, re-enables and keeps the delivery position; a new webhook starts from "now".
  await db
    .prepare(
      `INSERT INTO webhooks (user_id, url, secret_enc, created_at, last_event_seq) VALUES (?,?,?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET url = excluded.url, secret_enc = excluded.secret_enc, disabled_at = NULL, fail_since = NULL`,
    )
    .bind(user_id, url, secret_enc, now, max)
    .run();
  await db.prepare("DELETE FROM webhook_attempts WHERE user_id = ?").bind(user_id).run();
  return secret;
}

export async function removeWebhook(db: Db, user_id: string): Promise<void> {
  await db.prepare("DELETE FROM webhook_attempts WHERE user_id = ?").bind(user_id).run();
  await db.prepare("DELETE FROM webhooks WHERE user_id = ?").bind(user_id).run();
}

export async function deleteUserData(db: Db, user_id: string): Promise<void> {
  await removeWebhook(db, user_id);
  for (const t of ["oauth_tokens", "oauth_codes", "matches", "events", "interests", "api_tokens", "rate_limits", "users"])
    await db.prepare(`DELETE FROM ${t} WHERE ${t === "users" ? "id" : "user_id"} = ?`).bind(user_id).run();
}
