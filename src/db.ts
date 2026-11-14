/** A prepared statement with its values bound; run it alone or pass it to Db.batch. */
export interface BoundStatement {
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

/** Minimal async DB surface satisfied by Cloudflare D1 (and by a better-sqlite3 shim in tests). */
export interface Db {
  prepare(sql: string): { bind(...values: unknown[]): BoundStatement };
  /** Runs the statements in order in one round trip and one transaction (D1 `batch`). */
  batch(statements: BoundStatement[]): Promise<unknown[]>;
}

/** D1 accepts at most 100 statements per batch call. */
export const BATCH_MAX = 100;

/** Runs statements in chunks of BATCH_MAX, one round trip per chunk. */
export async function runBatched(db: Db, statements: BoundStatement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += BATCH_MAX) await db.batch(statements.slice(i, i + BATCH_MAX));
}
