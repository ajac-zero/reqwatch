import { describe, expect, it } from "vitest";
import type { Env, FetchMessage, MessageLike } from "../src/index";
import { handleQueue, health, scheduled } from "../src/worker";
import { createHostLimiter, pollCompany } from "../src/poll";
import { intervalMs, selectDueCompanies, updateAfterPoll } from "../src/scheduler";
import { USER_AGENT } from "../src/ats";
import type { Db } from "../src/db";
import { addCompany, fixture, jsonFetch, makeDb } from "./helpers";

const NOW = "2026-11-10T12:00:00.000Z";
const at = (min: number) => new Date(Date.parse(NOW) + min * 60_000).toISOString();

describe("scheduler", () => {
  it("selects never-polled (first) and due companies, not future ones, respecting limit", async () => {
    const { db, raw } = makeDb();
    const a = addCompany(raw, "greenhouse", "A", "a");
    const b = addCompany(raw, "lever", "B", "b");
    const c = addCompany(raw, "ashby", "C", "c");
    raw.prepare("UPDATE companies SET next_poll_at = ? WHERE id = ?").run(at(-5), b.id);
    raw.prepare("UPDATE companies SET next_poll_at = ? WHERE id = ?").run(at(5), c.id);
    expect((await selectDueCompanies(db, NOW, 10)).map((x) => x.id)).toEqual([a.id, b.id]);
    expect(await selectDueCompanies(db, NOW, 1)).toHaveLength(1);
  });

  it("uses tier intervals, doubles on failure up to 6h, and opens the circuit at 5 fails", () => {
    const m = 60_000;
    expect(intervalMs(1, 0)).toBe(15 * m);
    expect(intervalMs(2, 0)).toBe(60 * m);
    expect(intervalMs(1, 2)).toBe(60 * m);
    expect(intervalMs(2, 2)).toBe(240 * m);
    expect(intervalMs(2, 3)).toBe(360 * m);
    expect(intervalMs(1, 4)).toBe(240 * m);
    expect(intervalMs(1, 5)).toBe(360 * m);
  });

  it("updateAfterPoll sets schedule/etag on success and flags the circuit on failure", async () => {
    const { db, raw } = makeDb();
    const co = addCompany(raw, "lever");
    raw.prepare("UPDATE companies SET tier = 1 WHERE id = ?").run(co.id);
    const ok = await updateAfterPoll(db, co, { jobs: [], complete: true, etag: "W/1" }, NOW);
    expect(ok).toEqual({ nextPollAt: at(15), circuitOpen: false });
    const row = raw.prepare("SELECT * FROM companies WHERE id = ?").get(co.id) as any;
    expect([row.next_poll_at, row.last_ok_at, row.etag]).toEqual([at(15), NOW, "W/1"]);

    raw.prepare("UPDATE companies SET fail_count = 5 WHERE id = ?").run(co.id);
    const bad = await updateAfterPoll(db, co, { jobs: [], complete: false }, at(100));
    expect(bad.circuitOpen).toBe(true);
    const due = await selectDueCompanies(db, at(100 + 359), 5);
    expect(due).toHaveLength(0);
    const later = await selectDueCompanies(db, at(100 + 360), 5);
    expect(later[0]?.circuitOpen).toBe(true);
    expect((raw.prepare("SELECT etag FROM companies").get() as any).etag).toBe("W/1");
  });
});

describe("pollCompany", () => {
  it("sends the User-Agent, snapshots to R2 under the expected key, and ingests", async () => {
    const { db, raw } = makeDb();
    const co = addCompany(raw, "lever", "Acme", "acme");
    const puts: string[] = [];
    const seen: Array<string | null> = [];
    const out = await pollCompany(
      {
        db, now: () => NOW,
        snapshots: { put: async (k) => void puts.push(k) },
        fetchImpl: async (_u, init) => {
          seen.push(new Headers(init?.headers).get("user-agent"));
          return new Response(fixture("lever"));
        },
      },
      co,
    );
    expect(seen).toEqual([USER_AGENT]);
    expect(puts).toEqual([`raw/lever/acme/${NOW}.json.gz`]);
    expect(out.ingest.new.length).toBeGreaterThan(0);
    expect((raw.prepare("SELECT next_poll_at FROM companies").get() as any).next_poll_at).toBe(at(60));
  });

  it("works without an R2 binding", async () => {
    const { db, raw } = makeDb();
    const co = addCompany(raw, "lever");
    await expect(pollCompany({ db, now: () => NOW, fetchImpl: jsonFetch(fixture("lever")) }, co)).resolves.toBeTruthy();
  });

  it("an incomplete feed does not close jobs, and bumps fail_count/backoff", async () => {
    const { db, raw } = makeDb();
    const co = addCompany(raw, "lever");
    const ok = jsonFetch(fixture("lever"));
    await pollCompany({ db, now: () => NOW, fetchImpl: ok }, co);
    const open = raw.prepare("SELECT COUNT(*) n FROM jobs WHERE status='open'").get() as any;
    for (let i = 1; i <= 3; i++) {
      await pollCompany({ db, now: () => at(i * 1000), fetchImpl: jsonFetch("oops", 500) }, co);
    }
    expect(raw.prepare("SELECT COUNT(*) n FROM jobs WHERE status='open'").get()).toEqual(open);
    expect(raw.prepare("SELECT MAX(missed_polls) m FROM jobs").get()).toEqual({ m: 0 });
    const row = raw.prepare("SELECT fail_count, next_poll_at FROM companies").get() as any;
    expect(row.fail_count).toBe(3);
    expect(row.next_poll_at).toBe(at(3000 + 360));
  });

  it("limiter caps concurrent requests per host but not across hosts", async () => {
    const lim = createHostLimiter(2);
    let active = 0, peak = 0, otherHostRan = false;
    const task = (host: string) => lim.run(host, async () => {
      if (host === "a") { active++; peak = Math.max(peak, active); }
      else otherHostRan = active > 0;
      await new Promise((r) => setTimeout(r, 10));
      if (host === "a") active--;
    });
    await Promise.all([task("a"), task("a"), task("a"), task("a"), task("b")]);
    expect(peak).toBe(2);
    expect(otherHostRan).toBe(true);
  });
});

/** Emulates Cloudflare Queues: retry() redelivers until max_retries, then the message goes to the DLQ. */
async function runQueue(env: Env, bodies: FetchMessage[], fetchImpl: typeof fetch, maxRetries = 3) {
  const dlq: FetchMessage[] = [];
  let pending = bodies.map((body) => ({ body, attempts: 0 }));
  let acked = 0;
  while (pending.length) {
    const retry: typeof pending = [];
    const msgs: MessageLike<FetchMessage>[] = pending.map((p) => ({
      body: p.body,
      ack: () => void acked++,
      retry: () => {
        p.attempts++;
        if (p.attempts > maxRetries) dlq.push(p.body);
        else retry.push(p);
      },
    }));
    await handleQueue(msgs, env, fetchImpl);
    pending = retry;
  }
  return { dlq, acked };
}

/** A bound statement that throws whether run alone or inside a batch (see makeDb's batch shim). */
const failing = (msg: string) => {
  const boom = () => { throw new Error(msg); };
  return { all: async () => boom(), run: async () => boom(), runSync: boom } as never;
};

describe("worker", () => {
  const makeEnv = (db: Db): Env & { sent: FetchMessage[] } => {
    const sent: FetchMessage[] = [];
    return { DB: db, sent, FETCH_QUEUE: { send: async (b) => void sent.push(b) } };
  };

  it("scheduled enqueues due companies once, records cron time, and does not double-enqueue", async () => {
    const { db, raw } = makeDb();
    const a = addCompany(raw, "greenhouse", "A", "a");
    const b = addCompany(raw, "lever", "B", "b");
    const env = makeEnv(db);
    expect(await scheduled(env, NOW)).toBe(2);
    expect(env.sent).toEqual([{ companyId: a.id }, { companyId: b.id }]);
    expect(await scheduled(env, at(5))).toBe(0);
    expect((raw.prepare("SELECT value FROM meta WHERE key='last_cron_at'").get() as any).value).toBe(at(5));
  });

  it("a failed enqueue leaves the company due", async () => {
    const { db, raw } = makeDb();
    addCompany(raw, "greenhouse");
    const env = makeEnv(db);
    env.FETCH_QUEUE = { send: async () => { throw new Error("queue down"); } };
    await expect(scheduled(env, NOW)).rejects.toThrow();
    expect(await selectDueCompanies(db, NOW, 5)).toHaveLength(1);
  });

  it("consumer that throws retries the message (nothing lost); success acks", async () => {
    const { db, raw } = makeDb();
    const co = addCompany(raw, "lever");
    let fail = true;
    const flaky: Db = {
      batch: (stmts) => db.batch(stmts),
      prepare: (sql) => (fail && sql.startsWith("INSERT INTO jobs") ? { bind: () => failing("d1") } : db.prepare(sql)),
    };
    const calls: string[] = [];
    const msg = (): MessageLike<FetchMessage> => ({ body: { companyId: co.id }, ack: () => void calls.push("ack"), retry: () => void calls.push("retry") });
    const f = (async () => new Response(fixture("lever"))) as unknown as typeof fetch;
    await handleQueue([msg()], { ...makeEnv(flaky) }, f);
    expect(calls).toEqual(["retry"]);
    fail = false;
    await handleQueue([msg()], { ...makeEnv(flaky) }, f);
    expect(calls).toEqual(["retry", "ack"]);
    expect((raw.prepare("SELECT COUNT(*) n FROM jobs").get() as any).n).toBeGreaterThan(0);
  });

  it("poison message is retried max_retries times then lands in the DLQ; healthy ones still ack", async () => {
    const { db, raw } = makeDb();
    const good = addCompany(raw, "lever", "G", "g");
    const poison = addCompany(raw, "lever", "P", "p");
    const poisoned: Db = {
      batch: (stmts) => db.batch(stmts),
      // Job inserts bind company_id first; poison only that company (messages now run concurrently).
      prepare: (sql) => ({
        bind: (...v) => (sql.startsWith("INSERT INTO jobs") && v[0] === poison.id ? failing("x") : db.prepare(sql).bind(...v)),
      }),
    };
    const f = (async () => new Response(fixture("lever"))) as unknown as typeof fetch;
    const { dlq, acked } = await runQueue(makeEnv(poisoned), [{ companyId: poison.id }, { companyId: good.id }], f);
    expect(dlq).toEqual([{ companyId: poison.id }]);
    expect(acked).toBe(1);
  });

  it("/health reports db, last cron, kek; 503 when kek missing or db is down", async () => {
    const { db, raw } = makeDb();
    const env = { ...makeEnv(db), WEBHOOK_KEK: "k".repeat(64) };
    const worker = (await import("../src/index")).default;
    let res = await worker.fetch(new Request("https://x/health"), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: "ok", last_cron_at: null, webhook_kek: "ok" });
    await scheduled(env, NOW);
    res = await worker.fetch(new Request("https://x/health"), env);
    expect(await res.json()).toEqual({ ok: true, db: "ok", last_cron_at: NOW, webhook_kek: "ok" });
    for (const missing of [undefined, ""]) {
      res = await worker.fetch(new Request("https://x/health"), { ...env, WEBHOOK_KEK: missing });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ ok: false, db: "ok", last_cron_at: NOW, webhook_kek: "missing" });
    }
    raw.exec("DROP TABLE meta");
    res = await worker.fetch(new Request("https://x/health"), env);
    expect(res.status).toBe(503);
    expect((await res.json() as { db: string }).db).toBe("error");
  });
});

/** Emulates Workers' fetch: throws unless called with `this` undefined or globalThis. */
const strictFetch = (body: string, status = 200) =>
  function (this: unknown, _url: string, _init?: RequestInit) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    return Promise.resolve(new Response(body, { status }));
  } as unknown as typeof fetch;

describe("fetch binding (Workers 'Illegal invocation')", () => {
  const env = (db: Db): Env => ({ DB: db, FETCH_QUEUE: { send: async () => {} } });

  it("pollCompany never calls fetchImpl as a method of deps", async () => {
    const { db, raw } = makeDb();
    const co = addCompany(raw, "greenhouse", "Acme", "acme");
    const out = await pollCompany({ db, now: () => NOW, fetchImpl: strictFetch(fixture("greenhouse")) }, co);
    expect(out.board.complete).toBe(true);
    expect(out.board.error).toBeUndefined();
  });

  it("handleQueue -> real greenhouse adapter ingests the recorded fixture and sets last_ok_at", async () => {
    const { db, raw } = makeDb();
    const co = addCompany(raw, "greenhouse", "Acme", "acme");
    const calls: string[] = [];
    const msg: MessageLike<FetchMessage> = { body: { companyId: co.id }, ack: () => void calls.push("ack"), retry: () => void calls.push("retry") };
    await handleQueue([msg], env(db), strictFetch(fixture("greenhouse")));
    expect(calls).toEqual(["ack"]);
    const row = raw.prepare("SELECT last_ok_at, fail_count, last_error FROM companies").get() as any;
    expect(row.last_ok_at).toBeTruthy();
    expect([row.fail_count, row.last_error]).toEqual([0, null]);
    expect((raw.prepare("SELECT COUNT(*) n FROM jobs").get() as any).n).toBeGreaterThan(0);
  });
});

describe("last_error", () => {
  const poll = (db: Db, co: any, f: typeof fetch, now = NOW) => pollCompany({ db, now: () => now, fetchImpl: f }, co);
  const state = (raw: any) => raw.prepare("SELECT last_error, last_error_at, fail_count FROM companies").get();

  it("records a short reason per failure kind and clears it on success", async () => {
    const { db, raw } = makeDb();
    const co = addCompany(raw, "greenhouse", "Acme", "acme");
    await poll(db, co, jsonFetch("", 404) as any);
    expect(state(raw)).toEqual({ last_error: "http 404", last_error_at: NOW, fail_count: 1 });
    await poll(db, co, jsonFetch("{}") as any, at(1));
    expect(state(raw).last_error).toBe("invalid payload");
    await poll(db, co, (async () => { throw new TypeError("x".repeat(500)); }) as any, at(2));
    const e = state(raw).last_error as string;
    expect(e.startsWith("fetch failed: xxx")).toBe(true);
    expect(e.length).toBe(200);
    await poll(db, co, (async () => { throw new DOMException("t", "TimeoutError"); }) as any, at(3));
    expect(state(raw).last_error).toBe("timeout");
    await poll(db, co, jsonFetch(fixture("greenhouse")) as any, at(4));
    expect(state(raw)).toEqual({ last_error: null, last_error_at: null, fail_count: 0 });
  });
});
