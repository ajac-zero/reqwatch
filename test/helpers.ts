import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import type { Db } from "../src/db";
import type { Company, RawJob } from "../src/types";

export function makeDb(): { db: Db; raw: Database.Database } {
  const raw = new Database(":memory:");
  for (const f of readdirSync("migrations").sort()) raw.exec(readFileSync(`migrations/${f}`, "utf8"));
  const stmt = (sql: string, v: unknown[]) => {
    const runSync = () => raw.prepare(sql).run(...(v as never[]));
    return {
      all: async <T>() => ({ results: raw.prepare(sql).all(...(v as never[])) as T[] }),
      run: async () => runSync(),
      runSync, // used by batch() so a batch is one synchronous transaction
    };
  };
  const db: Db = {
    prepare: (sql) => ({ bind: (...v) => stmt(sql, v) }),
    batch: async (stmts) =>
      raw.transaction(() => stmts.map((s) => (s as unknown as { runSync(): unknown }).runSync()))(),
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

/** Wraps a Db and counts round trips: each prepared-statement run/all is one, each batch call is one. */
export function recordingDb(inner: Db): { db: Db; trips: () => number; statements: () => number; changes: () => number[]; reset: () => void } {
  let trips = 0, statements = 0;
  let changes: number[] = []; // rows changed by each write statement that changed any
  const note = (r: unknown) => {
    const n = (r as { changes?: number } | undefined)?.changes ?? 0;
    if (n > 0) changes.push(n);
    return r;
  };
  const db: Db = {
    prepare: (sql) => ({
      bind: (...v) => {
        const s = inner.prepare(sql).bind(...v);
        return {
          all: <T>() => (trips++, statements++, s.all<T>()),
          run: async () => (trips++, statements++, note(await s.run())),
          runSync: (s as unknown as { runSync(): unknown }).runSync,
        } as never;
      },
    }),
    batch: async (stmts) => (trips++, (statements += stmts.length), (await inner.batch(stmts)).forEach(note), []),
  };
  return { db, trips: () => trips, statements: () => statements, changes: () => changes, reset: () => ((trips = 0), (statements = 0), (changes = [])) };
}
