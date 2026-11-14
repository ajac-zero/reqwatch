import { z } from "zod";
import type { BoardResult, Company, FetchImpl, RawJob } from "../types";
import { getJson, incomplete } from "./index";

const Payload = z.object({
  jobs: z.array(
    z.object({
      id: z.union([z.number(), z.string()]),
      title: z.string(),
      absolute_url: z.string(),
      updated_at: z.string().nullish(),
      first_published: z.string().nullish(),
      location: z.object({ name: z.string() }).nullish(),
      content: z.string().nullish(),
    }),
  ),
  meta: z.object({ total: z.number() }).optional(),
});

export async function fetchGreenhouse(company: Company, fetchImpl: FetchImpl): Promise<BoardResult> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(company.board_token)}/jobs?content=true`;
  const res = await getJson(url, fetchImpl);
  if (res.error !== undefined) return incomplete(res.error);
  const parsed = Payload.safeParse(res.json);
  if (!parsed.success) return incomplete("invalid payload");
  const { jobs, meta } = parsed.data;
  // Truncation check: the feed reports its own total.
  if (meta && meta.total !== jobs.length) return incomplete("invalid payload");
  const out: RawJob[] = jobs.map((j) => ({
    extId: String(j.id),
    title: j.title,
    locations: j.location?.name ? [j.location.name] : [],
    url: j.absolute_url,
    postedAt: j.first_published ?? j.updated_at ?? null,
    description: j.content ?? "",
  }));
  return { jobs: out, complete: true };
}
