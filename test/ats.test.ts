import { describe, expect, it } from "vitest";
import { fetchBoard } from "../src/ats";
import type { Ats, Company } from "../src/types";
import { fixture, jsonFetch } from "./helpers";

const cases: { ats: Ats; file: string; ids: string[]; urlPart: string; firstLocs: string[] }[] = [
  { ats: "greenhouse", file: "greenhouse", ids: ["4001", "4002", "4003"], urlPart: "boards-api.greenhouse.io/v1/boards/acme/jobs?content=true", firstLocs: ["New York, NY"] },
  { ats: "lever", file: "lever", ids: ["a1b2c3d4-0001", "a1b2c3d4-0002"], urlPart: "api.lever.co/v0/postings/acme?mode=json", firstLocs: ["San Francisco, CA", "Seattle, WA"] },
  { ats: "ashby", file: "ashby", ids: ["9f1e0001-aaaa", "9f1e0002-bbbb"], urlPart: "api.ashbyhq.com/posting-api/job-board/acme", firstLocs: ["Boston, MA", "Remote - US"] },
];

describe.each(cases)("adapter contract: $ats", ({ ats, file, ids, urlPart, firstLocs }) => {
  const company: Company = { id: 1, name: "Acme", ats, board_token: "acme" };

  it("parses the complete fixture feed", async () => {
    let called = "";
    const res = await fetchBoard(company, async (u) => { called = u; return new Response(fixture(file)); });
    expect(called).toContain(urlPart);
    expect(res.complete).toBe(true);
    expect(res.jobs.map((j) => j.extId)).toEqual(ids);
    expect(res.jobs[0]!.locations).toEqual(firstLocs);
    expect(res.jobs[0]!.url).toMatch(/^https:\/\//);
  });

  it("is incomplete on HTTP error", async () => {
    expect(await fetchBoard(company, jsonFetch("{}", 503))).toEqual({ jobs: [], complete: false, error: "http 503" });
  });

  it("is incomplete on network failure", async () => {
    const res = await fetchBoard(company, async () => { throw new Error("boom"); });
    expect(res.complete).toBe(false);
  });

  it("is incomplete on malformed JSON", async () => {
    expect((await fetchBoard(company, jsonFetch("{not json"))).complete).toBe(false);
  });

  it("is incomplete on wrong shape", async () => {
    expect((await fetchBoard(company, jsonFetch('{"jobs":[{"id":1}]}'))).complete).toBe(false);
  });

  it("is incomplete on truncated payload", async () => {
    const text = fixture(file);
    expect((await fetchBoard(company, jsonFetch(text.slice(0, Math.floor(text.length * 0.7))))).complete).toBe(false);
  });
});

describe("greenhouse specifics", () => {
  const company: Company = { id: 1, name: "Acme", ats: "greenhouse", board_token: "acme" };
  it("flags feed whose meta.total exceeds jobs returned", async () => {
    const body = JSON.parse(fixture("greenhouse"));
    body.meta.total = 10;
    expect((await fetchBoard(company, jsonFetch(JSON.stringify(body)))).complete).toBe(false);
  });
});

describe("ashby specifics", () => {
  it("skips unlisted jobs", async () => {
    const company: Company = { id: 1, name: "Acme", ats: "ashby", board_token: "acme" };
    const res = await fetchBoard(company, jsonFetch(fixture("ashby")));
    expect(res.jobs.map((j) => j.title)).not.toContain("Internal Draft Role");
  });
});
