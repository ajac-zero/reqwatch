import { beforeEach, describe, expect, it } from "vitest";
import { fetchBoard } from "../src/ats";
import { ingestBoard } from "../src/ingest";
import { normalizeJob } from "../src/normalize";
import type { BoardResult, Company } from "../src/types";
import { addCompany, fixture, jsonFetch, makeDb, rj } from "./helpers";

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

  it("later re-ingest only moves last_seen_at", async () => {
    const f = feed(rj("a"));
    await ingestBoard(ctx.db, co, f, T1);
    expect(await ingestBoard(ctx.db, co, f, T2)).toEqual(empty);
    const [r] = rows();
    expect([r.first_seen_at, r.last_seen_at, r.last_changed_at]).toEqual([T1, T2, T1]);
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
