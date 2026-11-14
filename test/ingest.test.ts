import { beforeEach, describe, expect, it } from "vitest";
import { fetchBoard } from "../src/ats";
import { ingestBoard } from "../src/ingest";
import { normalizeJob } from "../src/normalize";
import type { BoardResult, Company } from "../src/types";
import { createInterest } from "../src/interests";
import { addCompany, fixture, jsonFetch, makeDb, recordingDb, rj } from "./helpers";

const T1 = "2026-11-01T00:00:00.000Z";
const T2 = "2026-11-02T00:00:00.000Z";
const T3 = "2026-11-03T00:00:00.000Z";
const T4 = "2026-11-04T00:00:00.000Z";
const feed = (...jobs: ReturnType<typeof rj>[]): BoardResult => ({ jobs, complete: true });
const empty = { new: [], changed: [], closed: [], reopened: [], crossPosted: [] };

let ctx: ReturnType<typeof makeDb>;
let co: Company;
beforeEach(() => {
  ctx = makeDb();
  co = addCompany(ctx.raw, "greenhouse");
});
const rows = () => ctx.raw.prepare("SELECT * FROM jobs ORDER BY id").all() as any[];

describe("normalizer", () => {
  const n = (r: ReturnType<typeof rj>) => normalizeJob({ name: "Acme" }, r);
  it("ignores case/whitespace/html and location order in hashes", () => {
    const a = n(rj("1", "SWE  New Grad", ["NYC", "Boston"], "<p>Hello</p>"));
    const b = n(rj("2", "swe new grad", ["boston", "nyc"], "hello"));
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.dedupKey).toBe(b.dedupKey);
  });
  it("description change alters content_hash but not dedup_key", () => {
    const a = n(rj("1", "SWE", ["NYC"], "one"));
    const b = n(rj("1", "SWE", ["NYC"], "two"));
    expect(a.contentHash).not.toBe(b.contentHash);
    expect(a.dedupKey).toBe(b.dedupKey);
  });
  it("different company or title or location changes dedup_key", () => {
    const a = n(rj("1", "SWE", ["NYC"]));
    expect(normalizeJob({ name: "Other" }, rj("1", "SWE", ["NYC"])).dedupKey).not.toBe(a.dedupKey);
    expect(n(rj("1", "SWE II", ["NYC"])).dedupKey).not.toBe(a.dedupKey);
    expect(n(rj("1", "SWE", ["NYC", "SF"])).dedupKey).not.toBe(a.dedupKey);
  });
});

describe("ingestBoard", () => {
  it("inserts exact rows from the greenhouse fixture and flags cross-posts", async () => {
    const res = await fetchBoard(co, jsonFetch(fixture("greenhouse")));
    const out = await ingestBoard(ctx.db, co, res, T1);
    expect(out.new).toEqual([1, 2, 3]);
    expect(out.changed).toEqual([]);
    expect(out.crossPosted).toEqual([1, 3]);
    const r = rows();
    expect(r.map((x) => [x.ext_id, x.title, x.locations_json, x.url, x.posted_at, x.first_seen_at, x.last_seen_at, x.last_changed_at, x.status, x.missed_polls, x.reposted])).toEqual([
      ["4001", "Software Engineer, New Grad", '["New York, NY"]', "https://boards.greenhouse.io/acme/jobs/4001", "2026-09-20T09:00:00-04:00", T1, T1, T1, "open", 0, 0],
      ["4002", "Software Engineer Intern (Summer 2027)", '["Remote - US"]', "https://boards.greenhouse.io/acme/jobs/4002", "2026-10-02T12:00:00-04:00", T1, T1, T1, "open", 0, 0],
      ["4003", "Software Engineer, New Grad", '["New York, NY"]', "https://boards.greenhouse.io/acme/jobs/4003", "2026-10-03T12:00:00-04:00", T1, T1, T1, "open", 0, 0],
    ]);
    expect(r.map((x) => x.cross_posted)).toEqual([1, 0, 1]);
    expect(r[0].dedup_key).toBe(r[2].dedup_key);
    expect(r[0].dedup_key).not.toBe(r[1].dedup_key);
    expect(r[0].content_hash).toBe(r[2].content_hash);
  });

  it("ingests lever and ashby fixtures", async () => {
    const lever = addCompany(ctx.raw, "lever", "Lev", "lev");
    const ashby = addCompany(ctx.raw, "ashby", "Ash", "ash");
    await ingestBoard(ctx.db, lever, await fetchBoard(lever, jsonFetch(fixture("lever"))), T1);
    await ingestBoard(ctx.db, ashby, await fetchBoard(ashby, jsonFetch(fixture("ashby"))), T1);
    expect(rows().map((x) => [x.ats, x.ext_id, x.locations_json, x.posted_at])).toEqual([
      ["lever", "a1b2c3d4-0001", '["San Francisco, CA","Seattle, WA"]', new Date(1790000000000).toISOString()],
      ["lever", "a1b2c3d4-0002", '["Austin, TX"]', new Date(1790100000000).toISOString()],
      ["ashby", "9f1e0001-aaaa", '["Boston, MA","Remote - US"]', "2026-10-05T14:00:00.000+00:00"],
      ["ashby", "9f1e0002-bbbb", '["Chicago, IL"]', "2026-10-06T14:00:00.000+00:00"],
    ]);
  });

  it("is idempotent on re-ingest", async () => {
    const f = feed(rj("a"), rj("b", "Other"));
    await ingestBoard(ctx.db, co, f, T1);
    const before = rows();
    const out = await ingestBoard(ctx.db, co, f, T1);
    expect(out).toEqual(empty);
    expect(rows()).toEqual(before);
  });

  it("later re-ingest of an unchanged job writes no job row; the company row records freshness", async () => {
    const f = feed(rj("a"));
    await ingestBoard(ctx.db, co, f, T1);
    const before = rows();
    expect(await ingestBoard(ctx.db, co, f, T2)).toEqual(empty);
    expect(rows()).toEqual(before);
    expect((ctx.raw.prepare("SELECT last_ok_at FROM companies").get() as any).last_ok_at).toBe(T2);
  });

  it("edit changes hash and last_changed_at, not first_seen_at", async () => {
    await ingestBoard(ctx.db, co, feed(rj("a", "Eng", ["NYC"], "v1")), T1);
    const h1 = rows()[0].content_hash;
    const out = await ingestBoard(ctx.db, co, feed(rj("a", "Eng", ["NYC"], "v2")), T2);
    expect(out.changed).toEqual([1]);
    expect(out.new).toEqual([]);
    const [r] = rows();
    expect(r.content_hash).not.toBe(h1);
    expect([r.first_seen_at, r.last_seen_at, r.last_changed_at]).toEqual([T1, T2, T2]);
  });

  it("closes only after two consecutive complete misses", async () => {
    await ingestBoard(ctx.db, co, feed(rj("a"), rj("b", "Keep")), T1);
    let out = await ingestBoard(ctx.db, co, feed(rj("b", "Keep")), T2);
    expect(out.closed).toEqual([]);
    expect(rows()[0]).toMatchObject({ status: "open", missed_polls: 1 });
    out = await ingestBoard(ctx.db, co, feed(rj("b", "Keep")), T3);
    expect(out.closed).toEqual([1]);
    expect(rows()[0]).toMatchObject({ status: "closed", missed_polls: 2, last_changed_at: T3 });
    expect(rows()[1]).toMatchObject({ status: "open" });
    out = await ingestBoard(ctx.db, co, feed(rj("b", "Keep")), T4);
    expect(out.closed).toEqual([]);
  });

  it("a single miss followed by reappearance resets the counter", async () => {
    await ingestBoard(ctx.db, co, feed(rj("a")), T1);
    await ingestBoard(ctx.db, co, feed(), T2);
    const out = await ingestBoard(ctx.db, co, feed(rj("a")), T3);
    expect(out).toEqual(empty);
    expect(rows()[0]).toMatchObject({ status: "open", missed_polls: 0, reposted: 0 });
  });

  it("an incomplete feed never closes or increments", async () => {
    await ingestBoard(ctx.db, co, feed(rj("a")), T1);
    await ingestBoard(ctx.db, co, feed(), T2); // missed_polls = 1
    for (const t of [T3, T4]) {
      const out = await ingestBoard(ctx.db, co, { jobs: [], complete: false }, t);
      expect(out).toEqual(empty);
    }
    expect(rows()[0]).toMatchObject({ status: "open", missed_polls: 1 });
    const c = ctx.raw.prepare("SELECT last_ok_at, fail_count FROM companies").get() as any;
    expect(c).toEqual({ last_ok_at: T2, fail_count: 2 });
  });

  it("reopens the same row flagged reposted", async () => {
    await ingestBoard(ctx.db, co, feed(rj("a")), T1);
    await ingestBoard(ctx.db, co, feed(), T2);
    await ingestBoard(ctx.db, co, feed(), T3);
    expect(rows()[0].status).toBe("closed");
    const out = await ingestBoard(ctx.db, co, feed(rj("a")), T4);
    expect(out.reopened).toEqual([1]);
    expect(out.new).toEqual([]);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ status: "open", reposted: 1, missed_polls: 0, first_seen_at: T1, last_seen_at: T4, last_changed_at: T4 });
  });

  it("clears cross_posted when the twin closes", async () => {
    await ingestBoard(ctx.db, co, feed(rj("a"), rj("b")), T1);
    expect(rows().map((r) => r.cross_posted)).toEqual([1, 1]);
    await ingestBoard(ctx.db, co, feed(rj("a")), T2);
    await ingestBoard(ctx.db, co, feed(rj("a")), T3);
    expect(rows().map((r) => [r.status, r.cross_posted])).toEqual([["open", 0], ["closed", 0]]);
  });

  it("scopes by company: same ext_id in two companies stays separate", async () => {
    const other = addCompany(ctx.raw, "greenhouse", "Beta", "beta");
    await ingestBoard(ctx.db, co, feed(rj("1")), T1);
    await ingestBoard(ctx.db, other, feed(rj("1")), T1);
    expect(rows()).toHaveLength(2);
    // other company's job missing doesn't affect this company
    await ingestBoard(ctx.db, other, feed(), T2);
    await ingestBoard(ctx.db, other, feed(), T3);
    expect(rows().map((r) => r.status)).toEqual(["open", "closed"]);
  });
});

describe("enrichment on ingest", () => {
  const enriched = () => ctx.raw.prepare(
    "SELECT country_set, remote, sponsorship, role_family, seniority, grad_window_start, employment_type FROM jobs",
  ).all() as any[];
  it("enriches new jobs and re-enriches when the description changes", async () => {
    await ingestBoard(ctx.db, co, feed(rj("1", "Software Engineer Intern", ["Remote - US"], "Summer 2027 internship. We do not offer visa sponsorship.")), T1);
    expect(enriched()).toEqual([{
      country_set: ",US,", remote: 1, sponsorship: "no", role_family: "software_engineering",
      seniority: "intern", grad_window_start: "2027-06", employment_type: "intern",
    }]);
    await ingestBoard(ctx.db, co, feed(rj("1", "Software Engineer Intern", ["Remote - US"], "Summer 2027 internship. Visa sponsorship available.")), T2);
    expect(enriched()[0].sponsorship).toBe("offers");
  });
});

describe("seniority re-enrichment", () => {
  const sen = () => ctx.raw.prepare("SELECT seniority, enrich_version v FROM jobs").get() as any;
  const desc = "<p>We are hiring new grads for this role. Class of 2027 welcome.</p>";
  it("re-enriches an unchanged unknown-seniority job once when ENRICH_VERSION is newer", async () => {
    await ingestBoard(ctx.db, co, feed(rj("1", "Software Engineer (L3)", ["NYC"], desc)), T1);
    expect(sen()).toEqual({ seniority: "new_grad", v: 2 });
    // Simulate a pre-upgrade row: same content_hash, unknown seniority, old version.
    ctx.raw.prepare("UPDATE jobs SET seniority = 'unknown', enrich_version = 1").run();
    const rec = recordingDb(ctx.db);
    const out = await ingestBoard(rec.db, co, feed(rj("1", "Software Engineer (L3)", ["NYC"], desc)), T2);
    expect(sen()).toEqual({ seniority: "new_grad", v: 2 });
    expect(rec.changes()).toEqual([1, 1]); // the job row once, plus the company row
    expect(out).toEqual({ ...empty, reclassified: [1] });
    const again = recordingDb(ctx.db);
    await ingestBoard(again.db, co, feed(rj("1", "Software Engineer (L3)", ["NYC"], desc)), T3);
    expect(again.changes()).toEqual([1]); // idempotent: company row only
  });
  it("matches a job reclassified to a known seniority exactly once, and not again on re-ingest", async () => {
    const plain = "Build things. ".repeat(5);
    await ingestBoard(ctx.db, co, feed(rj("1", "Software Engineer (L3)", ["NYC"], plain)), T1);
    await createInterest(ctx.db, "u1", { name: "ng", filter: { seniority: ["new_grad"], min_score: 0 } });
    const events = () => (ctx.raw.prepare("SELECT COUNT(*) n FROM events WHERE type = 'match'").get() as any).n;
    // Plain edit of an unknown job that stays unknown: no match.
    await ingestBoard(ctx.db, co, feed(rj("1", "Software Engineer (L3)", ["NYC"], plain + "More.")), T2);
    expect(events()).toBe(0);
    ctx.raw.prepare("UPDATE jobs SET enrich_version = 1").run();
    const out = await ingestBoard(ctx.db, co, feed(rj("1", "Software Engineer (L3)", ["NYC"], "We hire new grads. " + plain)), T3);
    expect(out).toMatchObject({ new: [], reopened: [], reclassified: [1] });
    expect(events()).toBe(1);
    expect((ctx.raw.prepare("SELECT COUNT(*) n FROM matches").get() as any).n).toBe(1);
    const again = await ingestBoard(ctx.db, co, feed(rj("1", "Software Engineer (L3)", ["NYC"], "We hire new grads. " + plain)), T4);
    expect(again.reclassified).toBeUndefined();
    expect(events()).toBe(1);
  });
  it("bumps the version even when still unknown, and leaves known seniority and unknown future versions alone", async () => {
    await ingestBoard(ctx.db, co, feed(rj("1", "Software Engineer", ["NYC"], "Build things."), rj("2", "Software Engineer II", ["NYC"], "x")), T1);
    ctx.raw.prepare("UPDATE jobs SET enrich_version = 1").run();
    await ingestBoard(ctx.db, co, feed(rj("1", "Software Engineer", ["NYC"], "Build things."), rj("2", "Software Engineer II", ["NYC"], "x")), T2);
    expect(ctx.raw.prepare("SELECT ext_id, seniority, enrich_version v FROM jobs ORDER BY id").all()).toEqual([
      { ext_id: "1", seniority: "unknown", v: 2 }, { ext_id: "2", seniority: "mid", v: 1 },
    ]);
  });
});

describe("ingestBoard round trips", () => {
  const board = (n: number, desc = "d") =>
    feed(...Array.from({ length: n }, (_, k) => rj(`j${k}`, `Software Engineer ${k % 700}`, [k % 2 ? "London, UK" : "New York, NY"], desc)));

  it("ingests a 1,500-job board in a bounded number of round trips", async () => {
    const rec = recordingDb(ctx.db);
    const out = await ingestBoard(rec.db, co, board(1500), T1);
    expect(out.new).toHaveLength(1500);
    expect(rec.trips()).toBeLessThanOrEqual(60);
    // 1,500 titles cycle over 700 values and 2 locations => cross-posted jobs exist and are reported.
    expect(out.crossPosted.length).toBeGreaterThan(0);
    rec.reset();
    const again = await ingestBoard(rec.db, co, board(1500), T2);
    expect(again).toEqual({ ...empty, crossPosted: out.crossPosted });
    expect(rec.trips()).toBeLessThanOrEqual(60);
  });

  it("an unchanged re-ingest of 1,500 jobs writes only the company row", async () => {
    await ingestBoard(ctx.db, co, board(1500), T1);
    const jobsBefore = rows();
    const rec = recordingDb(ctx.db);
    await ingestBoard(rec.db, co, board(1500), T2);
    expect(rec.changes()).toEqual([1]); // statements that affected rows: companies update only
    expect(rec.changes().reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(5);
    expect(rows()).toEqual(jobsBefore);
    expect((ctx.raw.prepare("SELECT last_ok_at FROM companies").get() as any).last_ok_at).toBe(T2);
  });

  it("rewrites only rows that changed (edit, miss reset) and fixes only cross_posted flags that flip", async () => {
    await ingestBoard(ctx.db, co, feed(rj("a"), rj("b"), rj("c", "Other")), T1); // a,b share a dedup_key
    await ingestBoard(ctx.db, co, feed(rj("a"), rj("c", "Other")), T2); // b missed once
    const rec = recordingDb(ctx.db);
    await ingestBoard(rec.db, co, feed(rj("a"), rj("b"), rj("c", "Other", ["NYC"], "edited")), T3);
    // b: miss reset, c: edit, company row; cross_posted unchanged => no row writes for it.
    expect(rec.changes()).toEqual([1, 1, 1]);
  });

  it("first ingest with 50 interests defined stays within 80 round trips", async () => {
    for (let n = 0; n < 50; n++) {
      await createInterest(ctx.db, `u${n}`, {
        // Most interests are selective (as in production): only the first 3 match this board's jobs.
        name: `i${n}`, filter: { roles: [n < 3 ? "software_engineering" : "data"], locations: [{ city: "london" }], min_score: 0.6 },
      });
    }
    const rec = recordingDb(ctx.db);
    await ingestBoard(rec.db, co, board(1500), T1);
    expect(rec.trips()).toBeLessThanOrEqual(80);
    expect((ctx.raw.prepare("SELECT COUNT(*) n FROM matches").get() as any).n).toBeGreaterThan(100);
  });
});
