import { runBatched, type BoundStatement, type Db } from "./db";
import { enrichJob } from "./enrich";
import { matchJobs } from "./match";
import { normalizeJob } from "./normalize";
import type { BoardResult, Company } from "./types";

export const CLOSE_AFTER_MISSED = 2;

export interface IngestResult {
  new: number[];
  changed: number[];
  closed: number[];
  reopened: number[];
  /** Jobs touched by this ingest that share a dedup_key with another job of the same company. */
  crossPosted: number[];
}

interface Row {
  id: number;
  ext_id: string;
  status: string;
  content_hash: string;
  missed_polls: number;
  role_family: string | null;
}

export async function ingestBoard(
  db: Db,
  company: Company,
  result: BoardResult,
  now: string,
): Promise<IngestResult> {
  const out: IngestResult = { new: [], changed: [], closed: [], reopened: [], crossPosted: [] };
  const writes: BoundStatement[] = [];
  const queue = (sql: string, ...v: unknown[]) => void writes.push(db.prepare(sql).bind(...v));
  const all = async <T>(sql: string, ...v: unknown[]) => (await db.prepare(sql).bind(...v).all<T>()).results;

  const existing = new Map(
    (await all<Row>(
      "SELECT id, ext_id, status, content_hash, missed_polls, role_family FROM jobs WHERE company_id = ? AND ats = ?",
      company.id, company.ats,
    )).map((r) => [r.ext_id, r]),
  );

  const seen = new Set<string>();
  // Touched jobs (id, or ext_id until a new job's id is known) with their dedup keys.
  const touched: Array<{ id?: number; extId: string; dedupKey: string }> = [];
  for (const raw of result.jobs) {
    if (seen.has(raw.extId)) continue;
    seen.add(raw.extId);
    const j = normalizeJob(company, raw);
    const prev = existing.get(j.extId);
    const locs = JSON.stringify(j.locations);
    const needsEnrich = !prev || prev.content_hash !== j.contentHash || prev.role_family === null;
    const e = needsEnrich ? enrichJob({ title: j.title, locations: j.locations, description: raw.description }) : null;
    const ev = e && [
      e.countries.length ? `,${e.countries.join(",")},` : "", e.remote ? 1 : 0, e.sponsorship, e.role_family,
      e.seniority, e.grad_window_start, e.grad_window_end, e.employment_type,
    ];
    if (!prev) {
      queue(
        `INSERT INTO jobs (company_id, ats, ext_id, title, locations_json, url, posted_at, first_seen_at,
           last_seen_at, last_changed_at, status, content_hash, dedup_key, missed_polls, reposted,
           country_set, remote, sponsorship, role_family, seniority, grad_window_start, grad_window_end, employment_type)
         VALUES (?,?,?,?,?,?,?,?,?,?, 'open', ?,?,0,0, ?,?,?,?,?,?,?,?)`,
        company.id, company.ats, j.extId, j.title, locs, j.url, j.postedAt, now, now, now, j.contentHash, j.dedupKey,
        ...ev!,
      );
      touched.push({ extId: j.extId, dedupKey: j.dedupKey });
      continue;
    }
    const reopen = prev.status === "closed";
    const changed = prev.content_hash !== j.contentHash;
    queue(
      `UPDATE jobs SET last_seen_at = ?, missed_polls = 0, status = 'open',
         reposted = CASE WHEN ? THEN 1 ELSE reposted END,
         title = ?, locations_json = ?, url = ?, posted_at = ?, content_hash = ?, dedup_key = ?,
         last_changed_at = CASE WHEN ? OR ? THEN ? ELSE last_changed_at END,
         country_set = COALESCE(?, country_set), remote = COALESCE(?, remote),
         sponsorship = COALESCE(?, sponsorship), role_family = COALESCE(?, role_family),
         seniority = COALESCE(?, seniority), grad_window_start = CASE WHEN ? THEN ? ELSE grad_window_start END,
         grad_window_end = CASE WHEN ? THEN ? ELSE grad_window_end END,
         employment_type = COALESCE(?, employment_type)
       WHERE id = ?`,
      now, reopen ? 1 : 0, j.title, locs, j.url, j.postedAt, j.contentHash, j.dedupKey,
      changed ? 1 : 0, reopen ? 1 : 0, now,
      ev?.[0] ?? null, ev?.[1] ?? null, ev?.[2] ?? null, ev?.[3] ?? null, ev?.[4] ?? null,
      ev ? 1 : 0, ev?.[5] ?? null, ev ? 1 : 0, ev?.[6] ?? null, ev?.[7] ?? null,
      prev.id,
    );
    if (reopen) out.reopened.push(prev.id);
    else if (changed) out.changed.push(prev.id);
    touched.push({ id: prev.id, extId: j.extId, dedupKey: j.dedupKey });
  }

  if (result.complete) {
    for (const prev of existing.values()) {
      if (seen.has(prev.ext_id) || prev.status !== "open") continue;
      const missed = prev.missed_polls + 1;
      if (missed >= CLOSE_AFTER_MISSED) {
        queue(
          "UPDATE jobs SET missed_polls = ?, status = 'closed', last_changed_at = ? WHERE id = ?",
          missed, now, prev.id,
        );
        out.closed.push(prev.id);
      } else {
        queue("UPDATE jobs SET missed_polls = ? WHERE id = ?", missed, prev.id);
      }
    }
    queue("UPDATE companies SET last_ok_at = ?, fail_count = 0, last_error = NULL, last_error_at = NULL WHERE id = ?", now, company.id);
  } else {
    queue(
      "UPDATE companies SET fail_count = fail_count + 1, last_error = ?, last_error_at = ? WHERE id = ?",
      result.error ?? "unknown", now, company.id,
    );
  }

  // Persist the flag for every job of this company: open jobs sharing a dedup_key with another open job.
  queue(
    `UPDATE jobs SET cross_posted = CASE WHEN status = 'open' AND EXISTS (
       SELECT 1 FROM jobs o WHERE o.company_id = jobs.company_id AND o.id != jobs.id
         AND o.status = 'open' AND o.dedup_key = jobs.dedup_key) THEN 1 ELSE 0 END
     WHERE company_id = ?`,
    company.id,
  );

  await runBatched(db, writes);

  const newIds = new Map<string, number>();
  if (touched.some((t) => t.id === undefined)) {
    for (const r of await all<{ id: number; ext_id: string }>(
      "SELECT id, ext_id FROM jobs WHERE company_id = ? AND ats = ? AND first_seen_at = ? ORDER BY id",
      company.id, company.ats, now,
    )) newIds.set(r.ext_id, r.id);
  }
  for (const t of touched) {
    if (t.id === undefined && !newIds.has(t.extId)) continue;
    t.id ??= newIds.get(t.extId);
    if (!existing.has(t.extId)) out.new.push(t.id!);
  }
  const shared = new Set(
    (await all<{ dedup_key: string }>(
      "SELECT dedup_key FROM jobs WHERE company_id = ? AND status = 'open' GROUP BY dedup_key HAVING COUNT(*) > 1",
      company.id,
    )).map((r) => r.dedup_key),
  );
  for (const t of touched) if (t.id !== undefined && shared.has(t.dedupKey)) out.crossPosted.push(t.id);

  // Match new and reopened jobs (not plain edits) against interests.
  await matchJobs(db, company.id, [...out.new, ...out.reopened], now);
  return out;
}
