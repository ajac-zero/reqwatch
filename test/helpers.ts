import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import type { Db } from "../src/db";
import type { Company, RawJob } from "../src/types";

export function makeDb(): { db: Db; raw: Database.Database } {
  const raw = new Database(":memory:");
  for (const f of readdirSync("migrations").sort()) raw.exec(readFileSync(`migrations/${f}`, "utf8"));
  const db: Db = {
    prepare: (sql) => ({
      bind: (...v) => ({
        all: async <T>() => ({ results: raw.prepare(sql).all(...(v as never[])) as T[] }),
        run: async () => raw.prepare(sql).run(...(v as never[])),
      }),
    }),
  };
  return { db, raw };
}

export function addCompany(raw: Database.Database, ats: Company["ats"], name = "Acme", token = "acme"): Company {
  const r = raw.prepare("INSERT INTO companies (name, ats, board_token) VALUES (?,?,?)").run(name, ats, token);
  return { id: Number(r.lastInsertRowid), name, ats, board_token: token };
}

export const fixture = (name: string) => readFileSync(`test/fixtures/${name}.json`, "utf8");

export const jsonFetch = (body: string, status = 200) => async () => new Response(body, { status });

export const rj = (extId: string, title = "Engineer", locations = ["NYC"], description = "d"): RawJob => ({
  extId, title, locations, url: `https://x/${extId}`, postedAt: null, description,
});
