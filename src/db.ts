/** Minimal async DB surface satisfied by Cloudflare D1 (and by a better-sqlite3 shim in tests). */
export interface Db {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
      run(): Promise<unknown>;
    };
  };
}
