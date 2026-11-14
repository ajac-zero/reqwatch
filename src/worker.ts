import type { Env, FetchMessage, MessageLike } from "./index";
import { globalFetch } from "./types";
import { pollCompany } from "./poll";
import { deliverWebhooks } from "./webhook";
import { leaseCompany, selectDueCompanies } from "./scheduler";

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
  await deliverWebhooks(env, now);
  await env.DB
    .prepare("INSERT INTO meta (key, value) VALUES ('last_cron_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(now)
    .run();
  return enqueued;
}

/** Polls each message's company concurrently (per-host limiter applies), acking or retrying each individually. Any throw => retry (platform moves it to the DLQ after max_retries). */
export async function handleQueue(
  messages: MessageLike<FetchMessage>[],
  env: Env,
  fetchImpl: typeof fetch = globalFetch,
): Promise<void> {
  await Promise.allSettled(
    messages.map(async (msg) => {
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
    }),
  );
}

export async function health(env: Env): Promise<Response> {
  const webhook_kek = env.WEBHOOK_KEK ? "ok" : "missing";
  try {
    await env.DB.prepare("SELECT 1").bind().all();
    const last = (
      await env.DB.prepare("SELECT value FROM meta WHERE key = 'last_cron_at'").bind().all<{ value: string }>()
    ).results[0];
    const ok = webhook_kek === "ok";
    return Response.json({ ok, db: "ok", last_cron_at: last?.value ?? null, webhook_kek }, { status: ok ? 200 : 503 });
  } catch {
    return Response.json({ ok: false, db: "error", last_cron_at: null, webhook_kek }, { status: 503 });
  }
}
