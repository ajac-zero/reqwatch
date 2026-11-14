import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { seedSql } from "../scripts/seed";

const seeds = JSON.parse(readFileSync(new URL("../seed/companies.json", import.meta.url), "utf8")) as {
  name: string; ats: string; board_token: string; tier: number; verified_at: string;
}[];

describe("seed/companies.json", () => {
  it("has valid, unique, verified entries", () => {
    expect(seeds.length).toBeGreaterThan(0);
    const keys = new Set<string>();
    for (const s of seeds) {
      expect(["greenhouse", "lever", "ashby"]).toContain(s.ats);
      expect(s.board_token).toMatch(/^[A-Za-z0-9._-]+$/);
      expect([1, 2]).toContain(s.tier);
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.verified_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      keys.add(`${s.ats}/${s.board_token}`);
    }
    expect(keys.size).toBe(seeds.length);
  });

  it("emits one INSERT per entry", () => {
    expect(seedSql(seeds).split("\n")).toHaveLength(seeds.length);
  });
});
