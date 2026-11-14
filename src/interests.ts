import { z } from "zod";
import type { Db } from "./db";
import { ROLE_FAMILIES, SENIORITIES } from "./enrich";

export const MAX_INTERESTS_PER_USER = 20;

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "expected YYYY-MM");
const names = z.array(z.string().trim().min(1).max(100).transform((s) => s.toLowerCase())).max(100).default([]);

export const LocationSchema = z
  .object({
    country: z.string().trim().length(2).transform((s) => s.toUpperCase()).optional(),
    region: z.string().trim().min(1).max(100).optional(),
    city: z.string().trim().min(1).max(100).optional(),
    remote: z.boolean().optional(),
  })
  .refine((l) => Object.keys(l).length > 0, "empty location");

export const FilterSchema = z.object({
  roles: z.array(z.enum(ROLE_FAMILIES)).max(ROLE_FAMILIES.length).default([]),
  exclude_keywords: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
  /** Non-empty = hard filter; jobs with unknown level fail unless 'unknown' is listed. */
  seniority: z.array(z.enum(SENIORITIES)).max(SENIORITIES.length).default([]),
  locations: z.array(LocationSchema).max(50).default([]),
  sponsorship: z.enum(["required", "not_needed", "any"]).default("any"),
  grad_window: z.object({ from: month, to: month }).refine((w) => w.from <= w.to, "from after to").optional(),
  /** Company names; stored lowercased so SQL prefilter and evaluate() agree. */
  companies_include: names,
  companies_exclude: names,
  min_score: z.number().min(0).max(1).default(0.6),
});
export type Filter = z.output<typeof FilterSchema>;

export interface Interest {
  id: string;
  user_id: string;
  name: string;
  filter: Filter;
  paused: boolean;
  created_at: string;
  updated_at: string;
}

interface InterestRow {
  id: string;
  user_id: string;
  name: string;
  filter_json: string;
  paused: number;
  created_at: string;
  updated_at: string;
}

export const toInterest = (r: InterestRow): Interest => ({
  id: r.id,
  user_id: r.user_id,
  name: r.name,
  filter: FilterSchema.parse(JSON.parse(r.filter_json)),
  paused: r.paused === 1,
  created_at: r.created_at,
  updated_at: r.updated_at,
});

const all = async <T>(db: Db, sql: string, ...v: unknown[]) => (await db.prepare(sql).bind(...v).all<T>()).results;
const nameSchema = z.string().trim().min(1).max(100);

export async function getInterest(db: Db, user_id: string, id: string): Promise<Interest | null> {
  const [r] = await all<InterestRow>(db, "SELECT * FROM interests WHERE id = ? AND user_id = ?", id, user_id);
  return r ? toInterest(r) : null;
}

export async function listInterests(db: Db, user_id: string): Promise<Interest[]> {
  const rows = await all<InterestRow>(db, "SELECT * FROM interests WHERE user_id = ? ORDER BY created_at, id", user_id);
  return rows.map(toInterest);
}

export async function createInterest(
  db: Db,
  user_id: string,
  input: { name: string; filter?: unknown; paused?: boolean },
  now = new Date().toISOString(),
): Promise<Interest> {
  const name = nameSchema.parse(input.name);
  const filter = FilterSchema.parse(input.filter ?? {});
  const id = crypto.randomUUID();
  await db.prepare("INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)").bind(user_id, now).run();
  // Cap enforced inside the INSERT so concurrent creates cannot overshoot.
  await db
    .prepare(
      `INSERT INTO interests (id, user_id, name, filter_json, paused, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM interests WHERE user_id = ?) < ?`,
    )
    .bind(id, user_id, name, JSON.stringify(filter), input.paused ? 1 : 0, now, now, user_id, MAX_INTERESTS_PER_USER)
    .run();
  const created = await getInterest(db, user_id, id);
  if (!created) throw new Error(`interest_limit: at most ${MAX_INTERESTS_PER_USER} interests per user`);
  return created;
}

export async function updateInterest(
  db: Db,
  user_id: string,
  id: string,
  patch: { name?: string; filter?: unknown; paused?: boolean },
  now = new Date().toISOString(),
): Promise<Interest | null> {
  const cur = await getInterest(db, user_id, id);
  if (!cur) return null;
  const name = patch.name === undefined ? cur.name : nameSchema.parse(patch.name);
  const filter = patch.filter === undefined ? cur.filter : FilterSchema.parse(patch.filter);
  const paused = patch.paused ?? cur.paused;
  await db
    .prepare("UPDATE interests SET name = ?, filter_json = ?, paused = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .bind(name, JSON.stringify(filter), paused ? 1 : 0, now, id, user_id)
    .run();
  return getInterest(db, user_id, id);
}

/** Removes the interest and its matches. Past events stay in the log but are no longer listed. */
export async function deleteInterest(db: Db, user_id: string, id: string): Promise<boolean> {
  if (!(await getInterest(db, user_id, id))) return false;
  await db.prepare("DELETE FROM matches WHERE interest_id = ? AND user_id = ?").bind(id, user_id).run();
  await db.prepare("DELETE FROM interests WHERE id = ? AND user_id = ?").bind(id, user_id).run();
  return true;
}
