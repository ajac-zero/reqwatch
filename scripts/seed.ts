// Emits INSERT SQL for seed/companies.json: node scripts/seed.ts > seed.sql
// then: wrangler d1 execute reqwatch --file seed.sql
import { readFileSync } from "node:fs";

interface Seed { name: string; ats: string; board_token: string; tier: number; comment?: string }

const q = (s: string) => `'${s.replaceAll("'", "''")}'`;

export function seedSql(seeds: Seed[]): string {
  return seeds
    .map(
      (s) =>
        `INSERT OR IGNORE INTO companies (name, ats, board_token, tier) VALUES (${q(s.name)}, ${q(s.ats)}, ${q(s.board_token)}, ${Number(s.tier)});`,
    )
    .join("\n");
}

if (process.argv[1]?.endsWith("seed.ts")) {
  const file = process.argv[2] ?? new URL("../seed/companies.json", import.meta.url).pathname;
  console.log(seedSql(JSON.parse(readFileSync(file, "utf8")) as Seed[]));
}
