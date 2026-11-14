import { z } from "zod";
import type { Db } from "../db";
import { ROLE_FAMILIES, SENIORITIES } from "../enrich";
import { FilterSchema, createInterest, deleteInterest, listInterests, updateInterest } from "../interests";
import { backfillInterest } from "../match";
import { listMatches } from "../matches";
import { deleteUserData, removeWebhook, setWebhook, validateWebhookUrl } from "../webhook";

export interface ToolContext {
  db: Db;
  user_id: string; // always from authentication, never from tool input
  scopes: string[];
  webhook_kek?: string;
}

export interface Tool {
  name: string;
  description: string;
  scope: "read" | "write";
  input: z.ZodType;
  run(ctx: ToolContext, args: never): Promise<unknown>;
}

/** Thrown for expected failures; surfaced to the model as an isError tool result. */
export class ToolError extends Error {}

const like = (s: string) => `%${s.replace(/[\\%_]/g, "\\$&")}%`;
const all = async <T>(db: Db, sql: string, ...v: unknown[]) => (await db.prepare(sql).bind(...v).all<T>()).results;
const limitSchema = (max: number, def: number) => z.number().int().min(1).max(max).default(def);

interface JobRow {
  id: number; title: string; company: string; url: string; locations_json: string; country_set: string; remote: number;
  sponsorship: string; role_family: string | null; seniority: string | null; grad_window_start: string | null;
  grad_window_end: string | null; employment_type: string | null; status: "open" | "closed";
  first_seen_at: string; posted_at: string | null; last_seen_at: string;
}
const JOB_COLS = `j.id, j.title, c.name AS company, j.url, j.locations_json, j.country_set, j.remote, j.sponsorship,
  j.role_family, j.seniority, j.grad_window_start, j.grad_window_end, j.employment_type, j.status,
  j.first_seen_at, j.posted_at, j.last_seen_at`;

const jobOut = (r: JobRow) => ({
  id: r.id, title: r.title, company: r.company, url: r.url, status: r.status,
  ...(r.status === "closed" ? { closed: true, warning: "THIS JOB IS CLOSED: the posting is no longer live." } : {}),
  locations: JSON.parse(r.locations_json) as string[],
  countries: r.country_set.split(",").filter(Boolean),
  remote: r.remote === 1,
  role_family: r.role_family, seniority: r.seniority, sponsorship: r.sponsorship,
  grad_window: { start: r.grad_window_start, end: r.grad_window_end },
  employment_type: r.employment_type,
  first_seen_at: r.first_seen_at, posted_at: r.posted_at, last_seen_at: r.last_seen_at,
});

export const TOOLS: Tool[] = [
  {
    name: "create_interest", scope: "write",
    description:
      "Save a job interest (a named filter: roles, seniority, locations, sponsorship, grad window, company include/exclude, min_score). " +
      "New matching jobs are then recorded for list_matches; recent open jobs are backfilled immediately.",
    input: z.object({ name: z.string(), filter: FilterSchema.optional() }),
    async run({ db, user_id }, a: { name: string; filter?: unknown }) {
      const interest = await createInterest(db, user_id, a);
      const backfill = await backfillInterest(db, user_id, interest.id);
      return { interest, backfill };
    },
  },
  {
    name: "update_interest", scope: "write",
    description: "Update an interest you own. patch may contain name, filter (replaces the whole filter) and paused.",
    input: z.object({
      id: z.string(),
      patch: z.object({ name: z.string().optional(), filter: FilterSchema.optional(), paused: z.boolean().optional() }),
    }),
    async run({ db, user_id }, a: { id: string; patch: { name?: string; filter?: unknown; paused?: boolean } }) {
      const interest = await updateInterest(db, user_id, a.id, a.patch);
      if (!interest) throw new ToolError("not_found: no such interest");
      return { interest };
    },
  },
  {
    name: "delete_interest", scope: "write",
    description: "Delete an interest you own, together with its matches.",
    input: z.object({ id: z.string() }),
    async run({ db, user_id }, a: { id: string }) {
      if (!(await deleteInterest(db, user_id, a.id))) throw new ToolError("not_found: no such interest");
      return { deleted: true };
    },
  },
  {
    name: "set_delivery", scope: "write",
    description:
      "Choose how new matches reach you. mode 'poll' (default) removes any webhook; use list_matches. mode 'webhook' with an https " +
      "webhook_url (public domain, port 443, no redirects followed) POSTs signed batches {event_id, cursor, matches}. The signing secret " +
      "is returned once; calling again rotates it. Verify X-Reqwatch-Signature = sha256=HMAC_SHA256(secret, timestamp + '.' + body).",
    input: z.object({ mode: z.enum(["poll", "webhook"]), webhook_url: z.string().max(2000).optional() }),
    async run({ db, user_id, webhook_kek }, a: { mode: "poll" | "webhook"; webhook_url?: string }) {
      if (a.mode === "poll") {
        await removeWebhook(db, user_id);
        return { mode: "poll" };
      }
      if (!webhook_kek) throw new ToolError("webhooks_unavailable: this server has no WEBHOOK_KEK configured; use poll mode");
      if (!a.webhook_url) throw new ToolError("invalid_input: webhook_url is required for webhook mode");
      const err = validateWebhookUrl(a.webhook_url);
      if (err) throw new ToolError(`invalid_webhook_url: ${err}`);
      const signing_secret = await setWebhook(db, user_id, a.webhook_url, webhook_kek, new Date().toISOString());
      return { mode: "webhook", webhook_url: a.webhook_url, signing_secret, note: "Store this secret now; it cannot be shown again." };
    },
  },
  {
    name: "delete_my_data", scope: "write",
    description: "Permanently delete all your data: interests, matches, events, webhook, API tokens and OAuth tokens/codes (including the one used for this call).",
    input: z.object({ confirm: z.literal(true) }),
    async run({ db, user_id }) {
      await deleteUserData(db, user_id);
      return { deleted: true };
    },
  },
  {
    name: "list_interests", scope: "read",
    description: "List your saved interests.",
    input: z.object({}),
    async run({ db, user_id }) {
      return { interests: await listInterests(db, user_id) };
    },
  },
  {
    name: "list_matches", scope: "read",
    description:
      "Fetch new job matches for your interests. Call this at the start of every session and periodically afterwards, passing " +
      "the next_cursor from your previous call as since_cursor (omit it the first time). Items are new matches only, in order. " +
      "Calls are idempotent: repeating a call with the same since_cursor returns the same items, and next_cursor echoes " +
      "since_cursor when nothing is new. Each job has a status; closed jobs are no longer live and should not be recommended.",
    input: z.object({
      since_cursor: z.string().optional(), interest_id: z.string().optional(), limit: limitSchema(100, 50).optional(),
    }),
    async run({ db, user_id }, a: { since_cursor?: string; interest_id?: string; limit?: number }) {
      try {
        return await listMatches(db, user_id, a);
      } catch (e) {
        if (e instanceof Error && e.message === "invalid_cursor") throw new ToolError("invalid_cursor: since_cursor must come from a previous next_cursor");
        throw e;
      }
    },
  },
  {
    name: "get_job", scope: "read",
    description: "Get one job by id, with enrichment fields and status (open/closed). Closed jobs are flagged prominently.",
    input: z.object({ job_id: z.number().int() }),
    async run({ db }, a: { job_id: number }) {
      const [r] = await all<JobRow>(db, `SELECT ${JOB_COLS} FROM jobs j JOIN companies c ON c.id = j.company_id WHERE j.id = ?`, a.job_id);
      if (!r) throw new ToolError("not_found: no such job");
      return jobOut(r);
    },
  },
  {
    name: "search_jobs", scope: "read",
    description: "Search currently OPEN jobs. query matches title or company name. Newest first.",
    input: z.object({
      query: z.string().max(200).optional(),
      role_family: z.enum(ROLE_FAMILIES).optional(),
      seniority: z.enum(SENIORITIES).optional(),
      country: z.string().length(2).optional().describe("ISO 3166-1 alpha-2, e.g. US"),
      limit: limitSchema(50, 20).optional(),
    }),
    async run({ db }, a: { query?: string; role_family?: string; seniority?: string; country?: string; limit?: number }) {
      const w = ["j.status = 'open'"];
      const v: unknown[] = [];
      if (a.query) { w.push("(j.title LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\')"); v.push(like(a.query), like(a.query)); }
      if (a.role_family) { w.push("j.role_family = ?"); v.push(a.role_family); }
      if (a.seniority) { w.push("j.seniority = ?"); v.push(a.seniority); }
      if (a.country) { w.push("j.country_set LIKE ?"); v.push(`%,${a.country.toUpperCase()},%`); }
      const rows = await all<JobRow>(
        db,
        `SELECT ${JOB_COLS} FROM jobs j JOIN companies c ON c.id = j.company_id WHERE ${w.join(" AND ")}
         ORDER BY j.first_seen_at DESC, j.id DESC LIMIT ?`,
        ...v, a.limit ?? 20,
      );
      return { jobs: rows.map(jobOut) };
    },
  },
  {
    name: "list_companies", scope: "read",
    description: "List tracked companies (optionally filtered by name) with their open job counts.",
    input: z.object({ query: z.string().max(200).optional(), limit: limitSchema(100, 50).optional() }),
    async run({ db }, a: { query?: string; limit?: number }) {
      const rows = await all<{ id: number; name: string; ats: string; last_ok_at: string | null; open_jobs: number }>(
        db,
        `SELECT c.id, c.name, c.ats, c.last_ok_at,
           (SELECT COUNT(*) FROM jobs j WHERE j.company_id = c.id AND j.status = 'open') AS open_jobs
         FROM companies c WHERE (? IS NULL OR c.name LIKE ? ESCAPE '\\') ORDER BY c.name, c.id LIMIT ?`,
        a.query ?? null, a.query ? like(a.query) : null, a.limit ?? 50,
      );
      return { companies: rows };
    },
  },
  {
    name: "get_stats", scope: "read",
    description: "Counts of tracked companies and open jobs, and the newest successful poll time.",
    input: z.object({}),
    async run({ db }) {
      const [r] = await all<{ companies: number; open_jobs: number; newest_last_ok_at: string | null }>(
        db,
        `SELECT (SELECT COUNT(*) FROM companies) AS companies, (SELECT COUNT(*) FROM jobs WHERE status = 'open') AS open_jobs,
           (SELECT MAX(last_ok_at) FROM companies) AS newest_last_ok_at`,
      );
      return r;
    },
  },
];

export const toolList = () =>
  TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: z.toJSONSchema(t.input, { io: "input", unrepresentable: "any" }),
  }));
