import { beforeEach, describe, expect, it } from "vitest";
import { ingestBoard } from "../src/ingest";
import { FilterSchema, createInterest, deleteInterest, listInterests, updateInterest, getInterest } from "../src/interests";
import { backfillInterest, evaluate, matchJob, matchJobs, type MatchJob } from "../src/match";
import { listMatches } from "../src/matches";
import type { Company } from "../src/types";
import { addCompany, makeDb, rj } from "./helpers";

let ctx: ReturnType<typeof makeDb>;
let co: Company;
beforeEach(() => {
  ctx = makeDb();
  co = addCompany(ctx.raw, "greenhouse");
});

const NOW = "2026-11-10T00:00:00.000Z";
const F = (o: object = {}) => FilterSchema.parse(o);
const baseJob: MatchJob = {
  id: 1, title: "Software Engineer", company: "Acme", locations: ["New York, NY"], countries: ["US"], remote: false,
  sponsorship: "offers", role_family: "software_engineering", seniority: "entry",
  grad_window_start: null, grad_window_end: null,
};

function insertJob(o: Partial<Record<string, unknown>> = {}, company = co.id): number {
  const n = ctx.raw.prepare("SELECT COUNT(*) n FROM jobs").get() as { n: number };
  const j = {
    ext_id: `e${n.n}`, title: `Engineer ${n.n}`, status: "open", first_seen_at: NOW, dedup_key: `k${n.n}`,
    role_family: "software_engineering", seniority: "entry", sponsorship: "unknown", country_set: ",US,", remote: 0,
    grad_window_start: null, grad_window_end: null, locations_json: '["New York, NY"]', ...o,
  } as Record<string, unknown>;
  const r = ctx.raw.prepare(
    `INSERT INTO jobs (company_id, ats, ext_id, title, locations_json, url, first_seen_at, last_seen_at, last_changed_at,
       status, content_hash, dedup_key, country_set, remote, sponsorship, role_family, seniority, grad_window_start, grad_window_end)
     VALUES (?, 'greenhouse', ?, ?, ?, 'https://x', ?, ?, ?, ?, 'h', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(company, j.ext_id, j.title, j.locations_json, j.first_seen_at, j.first_seen_at, j.first_seen_at, j.status,
    j.dedup_key, j.country_set, j.remote, j.sponsorship, j.role_family, j.seniority, j.grad_window_start, j.grad_window_end);
  return Number(r.lastInsertRowid);
}

describe("evaluate", () => {
  it("applies hard filters", () => {
    expect(evaluate(baseJob, F()).matched).toBe(true);
    expect(evaluate(baseJob, F({ exclude_keywords: ["ENGINEER"] })).matched).toBe(false);
    expect(evaluate(baseJob, F({ seniority: ["senior"] })).matched).toBe(false);
    expect(evaluate(baseJob, F({ companies_include: ["Other"] })).matched).toBe(false);
    expect(evaluate(baseJob, F({ companies_exclude: [" ACME "] })).matched).toBe(false);
    expect(evaluate(baseJob, F({ locations: [{ country: "GB" }] })).matched).toBe(false);
    expect(evaluate(baseJob, F({ locations: [{ country: "GB" }, { country: "US" }] })).matched).toBe(true);
    expect(evaluate(baseJob, F({ locations: [{ remote: true }] })).matched).toBe(false);
    expect(evaluate(baseJob, F({ roles: ["data"] })).matched).toBe(false);
  });
  it("sponsorship: no fails, unknown passes with flag", () => {
    const f = F({ sponsorship: "required" });
    expect(evaluate({ ...baseJob, sponsorship: "no" }, f).matched).toBe(false);
    const u = evaluate({ ...baseJob, sponsorship: "unknown" }, f);
    expect(u.matched).toBe(true);
    expect(u.flags).toEqual(["sponsorship_unverified"]);
    expect(u.score).toBeLessThan(evaluate({ ...baseJob, sponsorship: "offers" }, f).score);
    expect(evaluate({ ...baseJob, sponsorship: "no" }, F({ sponsorship: "not_needed" })).matched).toBe(true);
  });
  it("grad window overlap required when known, flagged when unknown", () => {
    const f = F({ grad_window: { from: "2027-05", to: "2027-08" } });
    const w = (s: string | null, e: string | null) => ({ ...baseJob, grad_window_start: s, grad_window_end: e });
    expect(evaluate(w("2027-08", "2027-12"), f).matched).toBe(true); // touches boundary
    expect(evaluate(w("2027-09", "2027-12"), f).matched).toBe(false);
    expect(evaluate(w("2026-01", "2027-04"), f).matched).toBe(false);
    expect(evaluate(w(null, null), f)).toMatchObject({ matched: true, flags: ["grad_window_unverified"] });
  });
  it("score weights and min_score threshold", () => {
    expect(evaluate(baseJob, F()).score).toBe(1);
    // unknown sponsorship, no grad filter: 0.4+0.25+0.2+0.15*(0.5+1)/2 = 0.9625
    const ev = evaluate({ ...baseJob, sponsorship: "unknown" }, F({ sponsorship: "required" }));
    expect(ev.score).toBeCloseTo(0.9625, 4);
    expect(evaluate({ ...baseJob, sponsorship: "unknown" }, F({ sponsorship: "required", min_score: 0.97 })).matched).toBe(false);
  });
  it("seniority is a hard filter: unknown/null fails unless 'unknown' is listed", () => {
    for (const seniority of [null, "unknown"]) {
      const j = { ...baseJob, seniority };
      expect(evaluate(j, F({ seniority: ["intern", "new_grad"] })).matched).toBe(false);
      expect(evaluate(j, F({ seniority: ["intern", "unknown"] }))).toMatchObject({ matched: true, score: 1, flags: [] });
      expect(evaluate(j, F()).matched).toBe(true); // no seniority filter
    }
    expect(evaluate(baseJob, F({ seniority: ["unknown"] })).matched).toBe(false); // entry job, only unknown wanted
  });
  it("rejects invalid filters", () => {
    expect(() => F({ roles: ["nope"] })).toThrow();
    expect(() => F({ grad_window: { from: "2027-13", to: "2027-14" } })).toThrow();
    expect(() => F({ grad_window: { from: "2027-06", to: "2027-01" } })).toThrow();
    expect(F({}).min_score).toBe(0.6);
    expect(F({}).sponsorship).toBe("any");
  });
});

describe("interest DAL tenant isolation", () => {
  it("user B cannot read, update or delete A's interest", async () => {
    const a = await createInterest(ctx.db, "A", { name: "mine" });
    expect(await listInterests(ctx.db, "B")).toEqual([]);
    expect(await getInterest(ctx.db, "B", a.id)).toBeNull();
    expect(await updateInterest(ctx.db, "B", a.id, { name: "hacked", paused: true })).toBeNull();
    expect(await deleteInterest(ctx.db, "B", a.id)).toBe(false);
    const still = await listInterests(ctx.db, "A");
    expect(still).toHaveLength(1);
    expect(still[0]).toMatchObject({ name: "mine", paused: false });
    expect(await deleteInterest(ctx.db, "A", a.id)).toBe(true);
  });
  it("caps interests at 20 per user, independently per user", async () => {
    for (let i = 0; i < 20; i++) await createInterest(ctx.db, "A", { name: `i${i}` });
    await expect(createInterest(ctx.db, "A", { name: "21" })).rejects.toThrow(/interest_limit/);
    await createInterest(ctx.db, "B", { name: "ok" });
    expect(await listInterests(ctx.db, "A")).toHaveLength(20);
  });
  it("update merges and revalidates", async () => {
    const a = await createInterest(ctx.db, "A", { name: "x", filter: { roles: ["data"] } });
    const u = await updateInterest(ctx.db, "A", a.id, { paused: true });
    expect(u).toMatchObject({ paused: true, filter: { roles: ["data"] } });
    await expect(updateInterest(ctx.db, "A", a.id, { filter: { min_score: 2 } })).rejects.toThrow();
  });
});

describe("matchJob", () => {
  it("matches only open jobs, is idempotent, one event per match", async () => {
    const i = await createInterest(ctx.db, "A", { name: "all" });
    const closed = insertJob({ status: "closed" });
    expect(await matchJob(ctx.db, closed)).toEqual([]);
    const j = insertJob();
    expect(await matchJob(ctx.db, j)).toEqual([i.id]);
    expect(await matchJob(ctx.db, j)).toEqual([]);
    expect(ctx.raw.prepare("SELECT COUNT(*) n FROM matches").get()).toEqual({ n: 1 });
    expect(ctx.raw.prepare("SELECT COUNT(*) n FROM events WHERE type='match'").get()).toEqual({ n: 1 });
  });
  it("skips paused interests and routes by user", async () => {
    await createInterest(ctx.db, "A", { name: "p", paused: true });
    const b = await createInterest(ctx.db, "B", { name: "b" });
    const j = insertJob();
    expect(await matchJob(ctx.db, j)).toEqual([b.id]);
    expect((await listMatches(ctx.db, "A")).items).toEqual([]);
    expect((await listMatches(ctx.db, "B")).items).toHaveLength(1);
  });
  it("does not re-match a cross-post of an already matched job", async () => {
    await createInterest(ctx.db, "A", { name: "all" });
    const j1 = insertJob({ dedup_key: "same" });
    const j2 = insertJob({ dedup_key: "same", ext_id: "other" });
    expect(await matchJob(ctx.db, j1)).toHaveLength(1);
    expect(await matchJob(ctx.db, j2)).toEqual([]);
    expect(ctx.raw.prepare("SELECT COUNT(*) n FROM events").get()).toEqual({ n: 1 });
    // a different user's interest still gets its own match
    await createInterest(ctx.db, "B", { name: "all" });
    expect(await matchJob(ctx.db, j2)).toHaveLength(1);
  });
  it("flags unknown sponsorship in listed results", async () => {
    await createInterest(ctx.db, "A", { name: "s", filter: { sponsorship: "required" } });
    await matchJob(ctx.db, insertJob({ sponsorship: "unknown" }));
    await matchJob(ctx.db, insertJob({ sponsorship: "no" }));
    const { items } = await listMatches(ctx.db, "A");
    expect(items).toHaveLength(1);
    expect(items[0]!.flags).toEqual(["sponsorship_unverified"]);
  });
  it("SQL prefilter path equals brute-force evaluate (seeded random)", async () => {
    let s = 12345;
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
    const sub = <T,>(a: readonly T[], p = 0.4) => a.filter(() => rnd() < p);
    const roles = ["software_engineering", "ml_ai", "data", "infra_sre", "other"];
    const sens = ["intern", "new_grad", "entry", "mid", "senior", "unknown"];
    const cos = ["Acme", "Globex", "Initech", "Ünïcode Co"];
    const companyIds = new Map(cos.map((n) => [n, addCompany(ctx.raw, "lever", n, n).id]));
    const months = ["2026-06", "2027-01", "2027-06", "2027-09", "2028-01"];

    const interests = [];
    for (let u = 0; u < 12; u++) {
      for (let k = 0; k < 4; k++) {
        const w = [pick(months), pick(months)].sort() as [string, string];
        interests.push(await createInterest(ctx.db, `u${u}`, {
          name: `i${k}`, paused: rnd() < 0.1,
          filter: {
            roles: sub(roles), seniority: sub(sens, 0.3), exclude_keywords: sub(["intern", "senior", "staff"], 0.2),
            sponsorship: pick(["required", "not_needed", "any"]),
            locations: rnd() < 0.5 ? [] : [pick([{ country: "US" }, { country: "GB" }, { remote: true }, { city: "london" }])],
            grad_window: rnd() < 0.4 ? { from: w[0], to: w[1] } : undefined,
            companies_include: rnd() < 0.2 ? sub(cos.map((c) => c.toUpperCase()), 0.5) : [],
            companies_exclude: rnd() < 0.2 ? sub(cos, 0.3) : [],
            min_score: pick([0, 0.6, 0.9, 0.95]),
          },
        }));
      }
    }
    let pairs = 0, matches = 0;
    for (let n = 0; n < 80; n++) {
      const cname = pick(cos);
      const gs = rnd() < 0.5 ? null : pick(months);
      const id = insertJob({
        title: pick(["Software Engineer", "Senior Data Engineer", "Intern ML", "Staff SRE"]) + n,
        role_family: rnd() < 0.1 ? null : pick(roles), seniority: rnd() < 0.1 ? null : pick(sens),
        sponsorship: pick(["offers", "no", "unknown"]), country_set: pick([",US,", ",GB,", "", ",GB,US,"]),
        remote: rnd() < 0.3 ? 1 : 0, locations_json: JSON.stringify([pick(["London, UK", "New York", "Remote"])]),
        grad_window_start: gs, grad_window_end: gs && [...months].reverse().find((m) => m >= gs),
        dedup_key: `uniq${n}`,
      }, companyIds.get(cname)!);
      const [row] = ctx.raw.prepare(
        "SELECT j.*, c.name company FROM jobs j JOIN companies c ON c.id = j.company_id WHERE j.id = ?",
      ).all(id) as any[];
      const mj: MatchJob = {
        id, title: row.title, company: row.company, locations: JSON.parse(row.locations_json),
        countries: row.country_set.split(",").filter(Boolean), remote: row.remote === 1, sponsorship: row.sponsorship,
        role_family: row.role_family, seniority: row.seniority, grad_window_start: row.grad_window_start,
        grad_window_end: row.grad_window_end,
      };
      const expected = interests.filter((i) => !i.paused && evaluate(mj, i.filter).matched).map((i) => i.id).sort();
      const actual = (await matchJob(ctx.db, id)).sort();
      expect(actual).toEqual(expected);
      pairs += interests.length;
      matches += expected.length;
    }
    expect(pairs).toBeGreaterThan(300);
    expect(matches).toBeGreaterThan(50); // not vacuous
  }, 30000);
});

describe("matchJobs (batched)", () => {
  it("creates exactly the matches and events per-job matchJob does, incl. cross-post dedup, on seeded random data", async () => {
    let s = 987;
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
    const sub = <T,>(a: readonly T[], p = 0.4) => a.filter(() => rnd() < p);
    const roles = ["software_engineering", "ml_ai", "data", "other"];
    const sens = ["intern", "entry", "mid", "senior", "unknown"];
    // Fixed script of interests and two rounds of jobs, replayed against two databases.
    const interests = Array.from({ length: 40 }, (_, n) => ({
      user: `u${n % 7}`,
      name: `i${n}`,
      paused: rnd() < 0.1,
      filter: {
        roles: sub(roles), seniority: sub(sens, 0.3), sponsorship: pick(["required", "any"]),
        exclude_keywords: sub(["intern", "staff"], 0.2), min_score: pick([0, 0.6, 0.9]),
        companies_exclude: rnd() < 0.2 ? ["globex"] : [],
      },
    }));
    const rounds = [0, 1].map(() =>
      Array.from({ length: 60 }, (_, n) => ({
        title: pick(["Software Engineer", "Intern ML", "Staff SRE"]), company: pick([0, 1]),
        role_family: rnd() < 0.1 ? null : pick(roles), seniority: rnd() < 0.1 ? null : pick(sens),
        sponsorship: pick(["offers", "no", "unknown"]), dedup_key: `k${Math.floor(rnd() * 30)}`, n,
      })),
    );

    const run = async (batched: boolean) => {
      const c = makeDb();
      const cos = [addCompany(c.raw, "greenhouse", "Acme", "a"), addCompany(c.raw, "greenhouse", "Globex", "g")];
      for (const i of interests) await createInterest(c.db, i.user, { name: i.name, paused: i.paused, filter: i.filter });
      let k = 0;
      for (const jobs of rounds) {
        const ids: number[][] = [[], []];
        for (const j of jobs) {
          const r = c.raw.prepare(
            `INSERT INTO jobs (company_id, ats, ext_id, title, locations_json, url, first_seen_at, last_seen_at, last_changed_at,
               status, content_hash, dedup_key, country_set, remote, sponsorship, role_family, seniority)
             VALUES (?, 'greenhouse', ?, ?, '[]', 'u', ?, ?, ?, 'open', 'h', ?, ',US,', 0, ?, ?, ?)`,
          ).run(cos[j.company]!.id, `e${k++}`, j.title, NOW, NOW, NOW, j.dedup_key, j.sponsorship, j.role_family, j.seniority);
          ids[j.company]!.push(Number(r.lastInsertRowid));
        }
        for (const [ci, list] of ids.entries()) {
          if (batched) await matchJobs(c.db, cos[ci]!.id, list, NOW);
          else for (const id of list) await matchJob(c.db, id, NOW);
        }
      }
      // Interest ids are random UUIDs (and drive candidate order), so compare by interest name, sorted.
      const name = new Map((c.raw.prepare("SELECT id, name FROM interests").all() as any[]).map((r) => [r.id, r.name]));
      const byJobThenInterest = (a: any, b: any) =>
        (a.job_id ?? a.payload_json.job_id) - (b.job_id ?? b.payload_json.job_id) ||
        String(a.interest_id ?? a.payload_json.interest_id).localeCompare(String(b.interest_id ?? b.payload_json.interest_id));
      return {
        matches: (c.raw.prepare("SELECT user_id, interest_id, job_id, score, flags_json FROM matches ORDER BY id").all() as any[])
          .map((m) => ({ ...m, interest_id: name.get(m.interest_id) })).sort(byJobThenInterest),
        events: (c.raw.prepare("SELECT user_id, type, payload_json FROM events ORDER BY seq").all() as any[]).map((e) => {
          const p = JSON.parse(e.payload_json);
          return { ...e, payload_json: { ...p, interest_id: name.get(p.interest_id) } };
        }).sort(byJobThenInterest),
      };
    };
    const expected = await run(false);
    const actual = await run(true);
    expect(expected.matches.length).toBeGreaterThan(50); // not vacuous
    expect(actual).toEqual(expected);
  });
});

describe("backfill", () => {
  it("is bounded by days and limit, newest first, tenant scoped, idempotent", async () => {
    const i = await createInterest(ctx.db, "A", { name: "all" });
    const day = (d: number) => new Date(Date.parse(NOW) - d * 86_400_000).toISOString();
    const old = insertJob({ first_seen_at: day(40) });
    const ids = [1, 2, 3, 4].map((d) => insertJob({ first_seen_at: day(d) }));
    insertJob({ first_seen_at: day(1), status: "closed" });
    expect(await backfillInterest(ctx.db, "B", i.id, { now: NOW })).toEqual({ scanned: 0, matched: 0 });
    expect(await backfillInterest(ctx.db, "A", i.id, { now: NOW, limit: 2 })).toEqual({ scanned: 2, matched: 2 });
    const got = (ctx.raw.prepare("SELECT job_id FROM matches ORDER BY job_id").all() as any[]).map((r) => r.job_id);
    expect(got).toEqual([ids[0], ids[1]]);
    expect(await backfillInterest(ctx.db, "A", i.id, { now: NOW })).toEqual({ scanned: 4, matched: 2 });
    expect(await backfillInterest(ctx.db, "A", i.id, { now: NOW, days: 100 })).toMatchObject({ matched: 1 });
    expect(ctx.raw.prepare("SELECT 1 FROM matches WHERE job_id = ?").get(old)).toBeTruthy();
  });
});

describe("listMatches", () => {
  it("paginates by cursor with no gaps or duplicates, and is idempotent", async () => {
    const a = await createInterest(ctx.db, "A", { name: "a" });
    const a2 = await createInterest(ctx.db, "A", { name: "a2", filter: { roles: ["data"] } });
    await createInterest(ctx.db, "B", { name: "b" });
    const jobs = [];
    for (let n = 0; n < 7; n++) jobs.push(insertJob({ role_family: n % 2 ? "data" : "software_engineering" }));
    for (const j of jobs) await matchJob(ctx.db, j);

    const seen: number[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const page = await listMatches(ctx.db, "A", { since_cursor: cursor, limit: 3 });
      expect(await listMatches(ctx.db, "A", { since_cursor: cursor, limit: 3 })).toEqual(page);
      if (!page.items.length) { expect(page.next_cursor).toBe(cursor); break; }
      seen.push(...page.items.map((i) => i.event_seq));
      cursor = page.next_cursor;
    }
    expect(seen).toHaveLength(10); // 7 jobs for a + 3 data jobs for a2
    expect(new Set(seen).size).toBe(10);
    expect([...seen].sort((x, y) => x - y)).toEqual(seen);

    // new events after the cursor appear exactly once
    await matchJob(ctx.db, insertJob());
    const more = await listMatches(ctx.db, "A", { since_cursor: cursor });
    expect(more.items).toHaveLength(1);
    expect(more.items[0]!.job.grad_window).toEqual({ start: null, end: null });

    const only = await listMatches(ctx.db, "A", { interest_id: a2.id, limit: 100 });
    expect(only.items.every((i) => i.interest_id === a2.id)).toBe(true);
    expect(only.items).toHaveLength(3);
    // another user's interest id yields nothing
    expect((await listMatches(ctx.db, "B", { interest_id: a.id })).items).toEqual([]);
    expect((await listMatches(ctx.db, "A", { limit: 1000 })).items.length).toBeLessThanOrEqual(100);
    await expect(listMatches(ctx.db, "A", { since_cursor: "abc" })).rejects.toThrow("invalid_cursor");
  });
  it("hides matches of deleted interests", async () => {
    const a = await createInterest(ctx.db, "A", { name: "a" });
    await matchJob(ctx.db, insertJob());
    await deleteInterest(ctx.db, "A", a.id);
    expect((await listMatches(ctx.db, "A")).items).toEqual([]);
  });
});

describe("ingest wiring", () => {
  it("matches new and reopened jobs but not plain edits", async () => {
    await createInterest(ctx.db, "A", { name: "all", filter: { roles: ["software_engineering"] } });
    const feed = (...jobs: ReturnType<typeof rj>[]) => ({ jobs, complete: true });
    const count = () => (ctx.raw.prepare("SELECT COUNT(*) n FROM events").get() as { n: number }).n;
    await ingestBoard(ctx.db, co, feed(rj("1", "Software Engineer", ["New York, NY"])), "2026-11-01T00:00:00.000Z");
    expect(count()).toBe(1);
    // edit: description change -> still one match, no new event
    await ingestBoard(ctx.db, co, feed(rj("1", "Software Engineer", ["New York, NY"], "new text")), "2026-11-02T00:00:00.000Z");
    expect(count()).toBe(1);
    // an interest created later does not see edits of the existing job, only new jobs
    const late = await createInterest(ctx.db, "B", { name: "late" });
    await ingestBoard(ctx.db, co, feed(rj("1", "Software Engineer", ["New York, NY"], "newer text")), "2026-11-03T00:00:00.000Z");
    expect(count()).toBe(1);
    // close then reopen: matches for B (new interest), A not duplicated
    await ingestBoard(ctx.db, co, feed(), "2026-11-04T00:00:00.000Z");
    await ingestBoard(ctx.db, co, feed(), "2026-11-05T00:00:00.000Z");
    await ingestBoard(ctx.db, co, feed(rj("1", "Software Engineer", ["New York, NY"], "newer text")), "2026-11-06T00:00:00.000Z");
    expect((await listMatches(ctx.db, "B")).items.map((i) => i.interest_id)).toEqual([late.id]);
    expect(count()).toBe(2);
  });
});
