import type { Db } from "./db";
import type { BoardResult, Company } from "./types";

const MIN = 60_000;
export const TIER1_INTERVAL_MS = 15 * MIN;
export const DEFAULT_INTERVAL_MS = 60 * MIN;
export const MAX_INTERVAL_MS = 6 * 60 * MIN;
export const CIRCUIT_BREAKER_FAILS = 5;

export interface DueCompany extends Company {
  tier: number;
  fail_count: number;
  etag: string | null;
  /** True when fail_count has reached the circuit-breaker threshold. */
  circuitOpen: boolean;
}

/** Poll interval: tier base, doubled per consecutive failure, capped at 6h; open circuit => 6h. */
export function intervalMs(tier: number, failCount: number): number {
  if (failCount >= CIRCUIT_BREAKER_FAILS) return MAX_INTERVAL_MS;
  const base = tier === 1 ? TIER1_INTERVAL_MS : DEFAULT_INTERVAL_MS;
  return Math.min(base * 2 ** Math.max(0, failCount), MAX_INTERVAL_MS);
}

/** Companies never polled or whose next_poll_at <= now, oldest due first. */
export async function selectDueCompanies(db: Db, now: string, limit: number): Promise<DueCompany[]> {
  const rows = (
    await db
      .prepare(
        `SELECT id, name, ats, board_token, tier, fail_count, etag FROM companies
         WHERE next_poll_at IS NULL OR next_poll_at <= ?
         ORDER BY next_poll_at IS NOT NULL, next_poll_at, id LIMIT ?`,
      )
      .bind(now, limit)
      .all<Omit<DueCompany, "circuitOpen">>()
  ).results;
  return rows.map((r) => ({ ...r, circuitOpen: r.fail_count >= CIRCUIT_BREAKER_FAILS }));
}

/** Push next_poll_at forward so a queued company is not selected again before its message is processed. */
export async function leaseCompany(db: Db, id: number, now: string, leaseMs = DEFAULT_INTERVAL_MS): Promise<void> {
  await db
    .prepare("UPDATE companies SET next_poll_at = ? WHERE id = ?")
    .bind(new Date(Date.parse(now) + leaseMs).toISOString(), id)
    .run();
}

/**
 * Call after ingestBoard (which maintains fail_count and last_ok_at): schedules the next poll
 * from the current fail_count and stores the etag when the poll was complete.
 */
export async function updateAfterPoll(
  db: Db,
  company: Company,
  result: BoardResult & { etag?: string | null },
  now: string,
): Promise<{ nextPollAt: string; circuitOpen: boolean }> {
  const row = (
    await db
      .prepare("SELECT tier, fail_count FROM companies WHERE id = ?")
      .bind(company.id)
      .all<{ tier: number; fail_count: number }>()
  ).results[0] ?? { tier: 2, fail_count: 0 };
  const nextPollAt = new Date(Date.parse(now) + intervalMs(row.tier, row.fail_count)).toISOString();
  if (result.complete) {
    await db
      .prepare("UPDATE companies SET next_poll_at = ?, last_ok_at = ?, etag = COALESCE(?, etag) WHERE id = ?")
      .bind(nextPollAt, now, result.etag ?? null, company.id)
      .run();
  } else {
    await db.prepare("UPDATE companies SET next_poll_at = ? WHERE id = ?").bind(nextPollAt, company.id).run();
  }
  return { nextPollAt, circuitOpen: row.fail_count >= CIRCUIT_BREAKER_FAILS };
}
