import type { Db } from "./db";
import { pollCompany, type R2Like } from "./poll";
import { handleAdminTokens } from "./auth";
import { handleMcpRoute } from "./mcp/http";
import { handleWaitlist } from "./waitlist";
import { leaseCompany, selectDueCompanies } from "./scheduler";

export interface QueueLike<T> {
  send(body: T): Promise<void>;
}

export interface Env {
  DB: Db;
  FETCH_QUEUE: QueueLike<FetchMessage>;
  /** Optional raw snapshot bucket. */
  SNAPSHOTS?: R2Like;
  /** Enables POST /admin/tokens when set. */
  ADMIN_SECRET?: string;
  /** OAuth issuer advertised in /.well-known/oauth-protected-resource. */
  AUTH_ISSUER?: string;
}

export interface FetchMessage {
  companyId: number;
}

export interface MessageLike<T> {
  body: T;
  ack(): void;
  retry(): void;
}

export const DUE_BATCH_LIMIT = 100;

export async function scheduled(env: Env, now = new Date().toISOString()): Promise<number> {
  const due = await selectDueCompanies(env.DB, now, DUE_BATCH_LIMIT);
  let enqueued = 0;
  for (const c of due) {
    // Send first: a failed send leaves next_poll_at untouched, so the company stays due.
    await env.FETCH_QUEUE.send({ companyId: c.id });
    await leaseCompany(env.DB, c.id, now);
    enqueued++;
  }
  await env.DB
    .prepare("INSERT INTO meta (key, value) VALUES ('last_cron_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(now)
    .run();
  return enqueued;
}

/** Polls each message's company. Any throw => retry (platform moves it to the DLQ after max_retries). */
export async function handleQueue(
  messages: MessageLike<FetchMessage>[],
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  for (const msg of messages) {
    try {
      const rows = (
        await env.DB
          .prepare("SELECT id, name, ats, board_token FROM companies WHERE id = ?")
          .bind(msg.body.companyId)
          .all<{ id: number; name: string; ats: "greenhouse" | "lever" | "ashby"; board_token: string }>()
      ).results;
      const company = rows[0];
      if (company) await pollCompany({ db: env.DB, fetchImpl, snapshots: env.SNAPSHOTS }, company);
      msg.ack(); // an unknown (deleted) company has nothing to poll
    } catch {
      msg.retry();
    }
  }
}

export async function health(env: Env): Promise<Response> {
  try {
    await env.DB.prepare("SELECT 1").bind().all();
    const last = (
      await env.DB.prepare("SELECT value FROM meta WHERE key = 'last_cron_at'").bind().all<{ value: string }>()
    ).results[0];
    return Response.json({ ok: true, db: "ok", last_cron_at: last?.value ?? null });
  } catch {
    return Response.json({ ok: false, db: "error", last_cron_at: null }, { status: 503 });
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path === "/health") return health(env);
    if (path === "/mcp" || path === "/.well-known/oauth-protected-resource") return handleMcpRoute(req, env);
    if (path === "/admin/tokens") return handleAdminTokens(req, env);
    if (path === "/api/waitlist") return handleWaitlist(req, env);
    return new Response("reqwatch", { status: 200 });
  },
  async scheduled(_event: unknown, env: Env): Promise<void> {
    await scheduled(env);
  },
  async queue(batch: { messages: MessageLike<FetchMessage>[] }, env: Env): Promise<void> {
    await handleQueue(batch.messages, env);
  },
};
