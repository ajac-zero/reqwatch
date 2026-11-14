import { runBatched, type BoundStatement, type Db } from "./db";
import { getInterest, toInterest, type Filter, type Interest } from "./interests";

/** The job fields evaluate() needs. */
export interface MatchJob {
  id: number;
  title: string;
  company: string;
  locations: string[];
  countries: string[];
  remote: boolean;
  sponsorship: string; // offers | no | unknown
  role_family: string | null;
  seniority: string | null;
  grad_window_start: string | null;
  grad_window_end: string | null;
}

export interface Evaluation {
  matched: boolean;
  score: number;
  flags: string[];
}

const W = { role: 0.4, location: 0.25, seniority: 0.2, other: 0.15 };
const FAIL: Evaluation = { matched: false, score: 0, flags: [] };

/**
 * Pure matching. Hard filters reject; everything else contributes to a weighted score.
 * Role is a hard filter when roles are given (a wrong role must not be rescued by other weights).
 * Unknown job data passes but scores 0.5 for that component and adds a *_unverified flag.
 */
export function evaluate(job: MatchJob, f: Filter): Evaluation {
  const flags: string[] = [];
  const title = job.title.toLowerCase();
  if (f.exclude_keywords.some((k) => title.includes(k.toLowerCase()))) return FAIL;

  const company = job.company.trim().toLowerCase();
  if (f.companies_include.length && !f.companies_include.includes(company)) return FAIL;
  if (f.companies_exclude.includes(company)) return FAIL;

  let role = 1;
  if (f.roles.length && !(job.role_family && (f.roles as string[]).includes(job.role_family))) return FAIL;

  let seniority = 1;
  if (f.seniority.length) {
    const s = job.seniority;
    if (!s || s === "unknown") {
      if (!(f.seniority as string[]).includes("unknown")) {
        seniority = 0.5;
        flags.push("seniority_unverified");
      }
    } else if (!(f.seniority as string[]).includes(s)) return FAIL;
  }

  if (f.locations.length) {
    const text = job.locations.join(" | ").toLowerCase();
    const ok = f.locations.some(
      (l) =>
        (l.country === undefined || job.countries.includes(l.country)) &&
        (l.remote === undefined || l.remote === job.remote) &&
        (l.region === undefined || text.includes(l.region.toLowerCase())) &&
        (l.city === undefined || text.includes(l.city.toLowerCase())),
    );
    if (!ok) return FAIL;
  }
  const location = 1;

  let sponsor = 1;
  if (f.sponsorship === "required") {
    if (job.sponsorship === "no") return FAIL;
    if (job.sponsorship !== "offers") {
      sponsor = 0.5;
      flags.push("sponsorship_unverified");
    }
  }

  let grad = 1;
  if (f.grad_window) {
    const start = job.grad_window_start ?? job.grad_window_end;
    const end = job.grad_window_end ?? job.grad_window_start;
    if (start && end) {
      if (!(start <= f.grad_window.to && end >= f.grad_window.from)) return FAIL;
    } else {
      grad = 0.5;
      flags.push("grad_window_unverified");
    }
  }

  const score = role * W.role + location * W.location + seniority * W.seniority + ((sponsor + grad) / 2) * W.other;
  const rounded = Math.round(score * 10000) / 10000;
  return { matched: rounded >= f.min_score, score: rounded, flags };
}

interface JobRow {
  id: number;
  title: string;
  company: string;
  dedup_key: string;
  status: string;
  locations_json: string;
  country_set: string;
  remote: number;
  sponsorship: string;
  role_family: string | null;
  seniority: string | null;
  grad_window_start: string | null;
  grad_window_end: string | null;
}

const JOB_SELECT = `SELECT j.id, j.title, c.name AS company, j.dedup_key, j.status, j.locations_json, j.country_set,
  j.remote, j.sponsorship, j.role_family, j.seniority, j.grad_window_start, j.grad_window_end
  FROM jobs j JOIN companies c ON c.id = j.company_id`;

const toMatchJob = (r: JobRow): MatchJob => ({
  id: r.id,
  title: r.title,
  company: r.company,
  locations: JSON.parse(r.locations_json) as string[],
  countries: r.country_set.split(",").filter(Boolean),
  remote: r.remote === 1,
  sponsorship: r.sponsorship,
  role_family: r.role_family,
  seniority: r.seniority,
  grad_window_start: r.grad_window_start,
  grad_window_end: r.grad_window_end,
});

const all = async <T>(db: Db, sql: string, ...v: unknown[]) => (await db.prepare(sql).bind(...v).all<T>()).results;

/** The match row and its guarded 'match' event. Guarded so a repeated call cannot append a second event. */
function matchStatements(db: Db, i: Interest, job: JobRow, ev: Evaluation, now: string): BoundStatement[] {
  return [
    db
      .prepare(
        "INSERT OR IGNORE INTO matches (user_id, interest_id, job_id, score, flags_json, created_at) VALUES (?,?,?,?,?,?)",
      )
      .bind(i.user_id, i.id, job.id, ev.score, JSON.stringify(ev.flags), now),
    db
      .prepare(
        `INSERT INTO events (user_id, type, payload_json, created_at)
         SELECT ?, 'match', ?, ? WHERE NOT EXISTS (
           SELECT 1 FROM events WHERE user_id = ? AND type = 'match'
             AND json_extract(payload_json, '$.interest_id') = ? AND json_extract(payload_json, '$.job_id') = ?)`,
      )
      .bind(
        i.user_id, JSON.stringify({ interest_id: i.id, job_id: job.id, score: ev.score, flags: ev.flags }), now,
        i.user_id, i.id, job.id,
      ),
  ];
}

/**
 * Records a match unless the interest already has this job or a cross-post (same dedup_key) of it.
 * Appends one 'match' event per newly created match. Returns true if a new match was recorded.
 */
async function recordMatch(db: Db, i: Interest, job: JobRow, ev: Evaluation, now: string): Promise<boolean> {
  const [dup = { n: 0 }] = await all<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM matches m JOIN jobs o ON o.id = m.job_id
     WHERE m.interest_id = ? AND (m.job_id = ? OR o.dedup_key = ?)`,
    i.id, job.id, job.dedup_key,
  );
  if (dup.n > 0) return false;
  for (const st of matchStatements(db, i, job, ev, now)) await st.run();
  return true;
}

/** SQL prefilter: a conservative superset of interests that evaluate() could accept for this job. */
export const CANDIDATE_SQL = `SELECT * FROM interests WHERE paused = 0
  AND (json_array_length(COALESCE(json_extract(filter_json, '$.roles'), '[]')) = 0
       OR EXISTS (SELECT 1 FROM json_each(filter_json, '$.roles') WHERE value = ?))
  AND (json_array_length(COALESCE(json_extract(filter_json, '$.companies_include'), '[]')) = 0
       OR EXISTS (SELECT 1 FROM json_each(filter_json, '$.companies_include') WHERE value = ?))
  AND NOT EXISTS (SELECT 1 FROM json_each(filter_json, '$.companies_exclude') WHERE value = ?)
  AND NOT (json_extract(filter_json, '$.sponsorship') = 'required' AND ? = 'no')
  AND (json_array_length(COALESCE(json_extract(filter_json, '$.seniority'), '[]')) = 0
       OR ? IN ('', 'unknown')
       OR EXISTS (SELECT 1 FROM json_each(filter_json, '$.seniority') WHERE value = ?))
  ORDER BY id`;

/** Matches one open job against all candidate interests. Returns the interest ids newly matched. */
export async function matchJob(db: Db, jobId: number, now = new Date().toISOString()): Promise<string[]> {
  const [job] = await all<JobRow>(db, `${JOB_SELECT} WHERE j.id = ?`, jobId);
  if (!job || job.status !== "open") return [];
  const mj = toMatchJob(job);
  const sen = job.seniority ?? "";
  const candidates = await all<Parameters<typeof toInterest>[0]>(
    db, CANDIDATE_SQL,
    job.role_family ?? "", job.company.trim().toLowerCase(), job.company.trim().toLowerCase(), job.sponsorship, sen, sen,
  );
  const created: string[] = [];
  for (const row of candidates) {
    const interest = toInterest(row);
    const ev = evaluate(mj, interest.filter);
    if (ev.matched && (await recordMatch(db, interest, job, ev, now))) created.push(interest.id);
  }
  return created;
}

/** Above this many active interests, matchJobs falls back to per-job SQL prefiltering. */
export const MATCH_INTERESTS_CAP = 5000;
const DEDUP_KEY_CHUNK = 100;

/**
 * Batched equivalent of calling matchJob for each id (in order) after an ingest of one company: loads the
 * active interests once, evaluates every job in memory, and writes all matches/events in batches.
 * Returns the interest ids newly matched per job id.
 */
export async function matchJobs(
  db: Db,
  companyId: number,
  jobIds: number[],
  now = new Date().toISOString(),
): Promise<Map<number, string[]>> {
  const created = new Map<number, string[]>();
  if (!jobIds.length) return created;
  const rows = await all<Parameters<typeof toInterest>[0]>(
    db, "SELECT * FROM interests WHERE paused = 0 ORDER BY id LIMIT ?", MATCH_INTERESTS_CAP + 1,
  );
  if (!rows.length) return created;
  if (rows.length > MATCH_INTERESTS_CAP) {
    for (const id of jobIds) created.set(id, await matchJob(db, id, now));
    return created;
  }
  const interests = rows.map(toInterest);
  const byId = new Map(
    (await all<JobRow>(db, `${JOB_SELECT} WHERE j.company_id = ? AND j.status = 'open'`, companyId)).map((r) => [r.id, r]),
  );

  const hits: Array<{ i: Interest; job: JobRow; ev: Evaluation }> = [];
  for (const id of jobIds) {
    const job = byId.get(id);
    if (!job) continue;
    const mj = toMatchJob(job);
    for (const i of interests) {
      const ev = evaluate(mj, i.filter);
      if (ev.matched) hits.push({ i, job, ev });
    }
  }
  if (!hits.length) return created;

  // (interest_id, dedup_key) pairs that already have a match, so cross-posts are not matched twice.
  const keys = [...new Set(hits.map((h) => h.job.dedup_key))];
  const taken = new Set<string>();
  for (let n = 0; n < keys.length; n += DEDUP_KEY_CHUNK) {
    const found = await all<{ interest_id: string; dedup_key: string }>(
      db,
      `SELECT m.interest_id, o.dedup_key FROM matches m JOIN jobs o ON o.id = m.job_id
       WHERE o.dedup_key IN (SELECT value FROM json_each(?))`,
      JSON.stringify(keys.slice(n, n + DEDUP_KEY_CHUNK)),
    );
    for (const f of found) taken.add(`${f.interest_id}\0${f.dedup_key}`);
  }

  const stmts: BoundStatement[] = [];
  for (const { i, job, ev } of hits) {
    const pair = `${i.id}\0${job.dedup_key}`;
    if (taken.has(pair)) continue;
    taken.add(pair);
    stmts.push(...matchStatements(db, i, job, ev, now));
    created.set(job.id, [...(created.get(job.id) ?? []), i.id]);
  }
  await runBatched(db, stmts);
  return created;
}

export const BACKFILL_MAX_LIMIT = 1000;

/** Matches one user's interest against recent open jobs (newest first), bounded by days and limit. */
export async function backfillInterest(
  db: Db,
  user_id: string,
  interestId: string,
  opts: { days?: number; limit?: number; now?: string } = {},
): Promise<{ scanned: number; matched: number }> {
  const interest = await getInterest(db, user_id, interestId);
  if (!interest || interest.paused) return { scanned: 0, matched: 0 };
  const now = opts.now ?? new Date().toISOString();
  const days = Math.max(0, opts.days ?? 30);
  const limit = Math.min(Math.max(1, opts.limit ?? BACKFILL_MAX_LIMIT), BACKFILL_MAX_LIMIT);
  const since = new Date(Date.parse(now) - days * 86_400_000).toISOString();
  const jobs = await all<JobRow>(
    db, `${JOB_SELECT} WHERE j.status = 'open' AND j.first_seen_at >= ? ORDER BY j.first_seen_at DESC, j.id DESC LIMIT ?`,
    since, limit,
  );
  let matched = 0;
  for (const job of jobs) {
    const ev = evaluate(toMatchJob(job), interest.filter);
    if (ev.matched && (await recordMatch(db, interest, job, ev, now))) matched++;
  }
  return { scanned: jobs.length, matched };
}
