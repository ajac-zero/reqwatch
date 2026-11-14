import type { Db } from "./db";
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
}

export async function ingestBoard(
  db: Db,
  company: Company,
  result: BoardResult,
  now: string,
): Promise<IngestResult> {
  const out: IngestResult = { new: [], changed: [], closed: [], reopened: [], crossPosted: [] };
  const run = (sql: string, ...v: unknown[]) => db.prepare(sql).bind(...v).run();
  const all = async <T>(sql: string, ...v: unknown[]) => (await db.prepare(sql).bind(...v).all<T>()).results;

  const existing = new Map(
    (await all<Row>(
      "SELECT id, ext_id, status, content_hash, missed_polls FROM jobs WHERE company_id = ? AND ats = ?",
      company.id, company.ats,
    )).map((r) => [r.ext_id, r]),
  );

  const seen = new Set<string>();
  const touched: number[] = [];
  for (const raw of result.jobs) {
    if (seen.has(raw.extId)) continue;
    seen.add(raw.extId);
    const j = normalizeJob(company, raw);
    const prev = existing.get(j.extId);
    const locs = JSON.stringify(j.locations);
    if (!prev) {
      await run(
        `INSERT INTO jobs (company_id, ats, ext_id, title, locations_json, url, posted_at, first_seen_at,
           last_seen_at, last_changed_at, status, content_hash, dedup_key, missed_polls, reposted)
         VALUES (?,?,?,?,?,?,?,?,?,?, 'open', ?,?,0,0)`,
        company.id, company.ats, j.extId, j.title, locs, j.url, j.postedAt, now, now, now, j.contentHash, j.dedupKey,
      );
      const [{ id }] = (await all<{ id: number }>(
        "SELECT id FROM jobs WHERE company_id = ? AND ats = ? AND ext_id = ?", company.id, company.ats, j.extId,
      )) as [{ id: number }];
      out.new.push(id);
      touched.push(id);
      continue;
    }
    const reopen = prev.status === "closed";
    const changed = prev.content_hash !== j.contentHash;
    await run(
      `UPDATE jobs SET last_seen_at = ?, missed_polls = 0, status = 'open',
         reposted = CASE WHEN ? THEN 1 ELSE reposted END,
         title = ?, locations_json = ?, url = ?, posted_at = ?, content_hash = ?, dedup_key = ?,
         last_changed_at = CASE WHEN ? OR ? THEN ? ELSE last_changed_at END
       WHERE id = ?`,
      now, reopen ? 1 : 0, j.title, locs, j.url, j.postedAt, j.contentHash, j.dedupKey,
      changed ? 1 : 0, reopen ? 1 : 0, now, prev.id,
    );
    if (reopen) out.reopened.push(prev.id);
    else if (changed) out.changed.push(prev.id);
    touched.push(prev.id);
  }

  if (result.complete) {
    for (const prev of existing.values()) {
      if (seen.has(prev.ext_id) || prev.status !== "open") continue;
      const missed = prev.missed_polls + 1;
      if (missed >= CLOSE_AFTER_MISSED) {
        await run(
          "UPDATE jobs SET missed_polls = ?, status = 'closed', last_changed_at = ? WHERE id = ?",
          missed, now, prev.id,
        );
        out.closed.push(prev.id);
      } else {
        await run("UPDATE jobs SET missed_polls = ? WHERE id = ?", missed, prev.id);
      }
    }
    await run("UPDATE companies SET last_ok_at = ?, fail_count = 0 WHERE id = ?", now, company.id);
  } else {
    await run("UPDATE companies SET fail_count = fail_count + 1 WHERE id = ?", company.id);
  }

  // Persist the flag for every job of this company: open jobs sharing a dedup_key with another open job.
  await run(
    `UPDATE jobs SET cross_posted = CASE WHEN status = 'open' AND EXISTS (
       SELECT 1 FROM jobs o WHERE o.company_id = jobs.company_id AND o.id != jobs.id
         AND o.status = 'open' AND o.dedup_key = jobs.dedup_key) THEN 1 ELSE 0 END
     WHERE company_id = ?`,
    company.id,
  );

  for (const id of touched) {
    const dup = await all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM jobs WHERE company_id = ? AND id != ? AND status = 'open'
         AND dedup_key = (SELECT dedup_key FROM jobs WHERE id = ?)`,
      company.id, id, id,
    );
    if ((dup[0]?.n ?? 0) > 0) out.crossPosted.push(id);
  }
  return out;
}
