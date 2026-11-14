import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { enrichJob, parseLocation, sponsorship } from "../src/enrich";

interface Label {
  title: string;
  locations: string[];
  description: string;
  expected: {
    role_family: string; seniority: string; countries: string[]; remote: boolean;
    sponsorship: string; grad_window: [string, string] | null;
  };
}
const labeled: Label[] = JSON.parse(readFileSync("test/fixtures/labeled.json", "utf8"));
const run = (l: Label) => enrichJob({ title: l.title, locations: l.locations, description: l.description });

describe("labeled set accuracy", () => {
  const results = labeled.map((l) => ({ l, e: run(l) }));
  const acc = (f: (r: (typeof results)[number]) => boolean) => results.filter(f).length / results.length;
  const miss = (f: (r: (typeof results)[number]) => boolean) =>
    results.filter((r) => !f(r)).map((r) => `${r.l.title} | ${r.l.locations}`);

  it("has at least 60 postings", () => expect(labeled.length).toBeGreaterThanOrEqual(60));
  it("role_family >= 90%", () => {
    const f = (r: (typeof results)[number]) => r.e.role_family === r.l.expected.role_family;
    expect(acc(f), miss(f).join("\n")).toBeGreaterThanOrEqual(0.9);
  });
  it("seniority >= 90%", () => {
    const f = (r: (typeof results)[number]) => r.e.seniority === r.l.expected.seniority;
    expect(acc(f), miss(f).join("\n")).toBeGreaterThanOrEqual(0.9);
  });
  it("country >= 95%", () => {
    const f = (r: (typeof results)[number]) => JSON.stringify(r.e.countries) === JSON.stringify(r.l.expected.countries);
    expect(acc(f), miss(f).join("\n")).toBeGreaterThanOrEqual(0.95);
  });
  it("sponsorship: 100% precision on non-unknown predictions", () => {
    const predicted = results.filter((r) => r.e.sponsorship !== "unknown");
    expect(predicted.length).toBeGreaterThan(5);
    const wrong = predicted.filter((r) => r.e.sponsorship !== r.l.expected.sponsorship);
    expect(wrong.map((r) => r.l.title + " | " + r.l.description)).toEqual([]);
  });
  it("remote and grad window match labels", () => {
    const bad = results.filter(
      (r) =>
        r.e.remote !== r.l.expected.remote ||
        (r.e.grad_window_start ?? null) !== (r.l.expected.grad_window?.[0] ?? null) ||
        (r.e.grad_window_end ?? null) !== (r.l.expected.grad_window?.[1] ?? null),
    );
    expect(bad.map((r) => r.l.title + " | " + r.l.description)).toEqual([]);
  });
});

describe("unknown is never coerced", () => {
  const e = (title: string, locations: string[], description: string) => enrichJob({ title, locations, description });
  it("plain title has unknown seniority", () => expect(e("Software Engineer", [], "").seniority).toBe("unknown"));
  it("no sponsorship language is unknown", () => expect(sponsorship("Great team and benefits.")).toBe("unknown"));
  it("conflicting sponsorship phrases are unknown", () =>
    expect(sponsorship("We offer visa sponsorship. We are unable to sponsor for this role.")).toBe("unknown"));
  it("city without country has no country", () => {
    expect(parseLocation("London")).toEqual({ city: "London", country: null, remote: false });
    expect(e("SWE", ["Paris"], "").countries).toEqual([]);
  });
  it("bare 'Remote' has no country", () => expect(parseLocation("Remote")).toEqual({ country: null, remote: true }));
  it("no dates means null grad window", () => {
    const r = e("Software Engineer", [], "Build things.");
    expect([r.grad_window_start, r.grad_window_end]).toEqual([null, null]);
    expect(r.employment_type).toBe("unknown");
  });
  it("irrelevant years are not a grad window", () =>
    expect(e("Software Engineer", [], "Founded in 2015, we ship in 2027.").grad_window_start).toBeNull());
});

describe("location parsing", () => {
  it.each([
    ["New York, NY", { city: "New York", region: "NY", country: "US", remote: false }],
    ["San Francisco, CA, United States", { city: "San Francisco", region: "CA", country: "US", remote: false }],
    ["Remote - US", { country: "US", remote: true }],
    ["London, UK", { city: "London", country: "GB", remote: false }],
    ["Toronto, ON", { city: "Toronto", region: "ON", country: "CA", remote: false }],
    ["Wilmington, DE", { city: "Wilmington, DE", country: null, remote: false }],
  ])("%s", (s, want) => expect(parseLocation(s)).toEqual(want));
});
