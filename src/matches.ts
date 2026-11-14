import type { Db } from "./db";

export const MAX_LIST_LIMIT = 100;

export interface MatchItem {
  event_seq: number;
  job: {
    id: number;
    title: string;
    company: string;
    url: string;
    locations: string[];
    seniority: string | null;
    role_family: string | null;
    sponsorship: string;
    grad_window: { start: string | null; end: string | null };
    first_seen_at: string;
    /** 'closed' means the posting is no longer live. */
    status: "open" | "closed";
  };
  interest_id: string;
  score: number;
  flags: string[];
}

interface Row {
  seq: number;
  payload_json: string;
  id: number;
  title: string;
  company: string;
  url: string;
  locations_json: string;
  seniority: string | null;
  role_family: string | null;
  sponsorship: string;
  grad_window_start: string | null;
  grad_window_end: string | null;
  first_seen_at: string;
  status: "open" | "closed";
}

/**
 * Reads 'match' events for one user in seq order. The cursor is the last returned seq, so repeating a call
 * with the same cursor returns the same items, and chaining next_cursor yields no gaps or duplicates.
 * With no new items next_cursor echoes the input cursor.
 */
export async function listMatches(
  db: Db,
  user_id: string,
  opts: { since_cursor?: string | null; interest_id?: string; limit?: number } = {},
): Promise<{ items: MatchItem[]; next_cursor: string | null }> {
  const since = opts.since_cursor ? Number(opts.since_cursor) : 0;
  if (!Number.isSafeInteger(since) || since < 0) throw new Error("invalid_cursor");
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 50)), MAX_LIST_LIMIT);
  const rows = (
    await db
      .prepare(
        `SELECT e.seq, e.payload_json, j.id, j.title, c.name AS company, j.url, j.locations_json, j.seniority,
           j.role_family, j.sponsorship, j.grad_window_start, j.grad_window_end, j.first_seen_at, j.status
         FROM events e
         JOIN jobs j ON j.id = json_extract(e.payload_json, '$.job_id')
         JOIN companies c ON c.id = j.company_id
         JOIN interests i ON i.id = json_extract(e.payload_json, '$.interest_id') AND i.user_id = e.user_id
         WHERE e.user_id = ? AND e.type = 'match' AND e.seq > ?
           AND (? IS NULL OR json_extract(e.payload_json, '$.interest_id') = ?)
         ORDER BY e.seq LIMIT ?`,
      )
      .bind(user_id, since, opts.interest_id ?? null, opts.interest_id ?? null, limit)
      .all<Row>()
  ).results;
  const items = rows.map((r): MatchItem => {
    const p = JSON.parse(r.payload_json) as { interest_id: string; score: number; flags: string[] };
    return {
      event_seq: r.seq,
      job: {
        id: r.id, title: r.title, company: r.company, url: r.url,
        locations: JSON.parse(r.locations_json) as string[],
        seniority: r.seniority, role_family: r.role_family, sponsorship: r.sponsorship,
        grad_window: { start: r.grad_window_start, end: r.grad_window_end },
        first_seen_at: r.first_seen_at, status: r.status,
      },
      interest_id: p.interest_id,
      score: p.score,
      flags: p.flags,
    };
  });
  const last = items.at(-1);
  return { items, next_cursor: last ? String(last.event_seq) : opts.since_cursor ?? null };
}
