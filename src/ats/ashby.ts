import { z } from "zod";
import type { BoardResult, Company, FetchImpl, RawJob } from "../types";
import { getJson, INCOMPLETE } from "./index";

const Payload = z.object({
  jobs: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      jobUrl: z.string(),
      location: z.string().nullish(),
      secondaryLocations: z.array(z.object({ location: z.string() })).nullish(),
      publishedAt: z.string().nullish(),
      descriptionPlain: z.string().nullish(),
      isListed: z.boolean().nullish(),
    }),
  ),
});

export async function fetchAshby(company: Company, fetchImpl: FetchImpl): Promise<BoardResult> {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(company.board_token)}`;
  const parsed = Payload.safeParse(await getJson(url, fetchImpl));
  if (!parsed.success) return INCOMPLETE;
  const jobs: RawJob[] = parsed.data.jobs
    .filter((j) => j.isListed !== false)
    .map((j) => ({
      extId: j.id,
      title: j.title,
      locations: [j.location, ...(j.secondaryLocations ?? []).map((s) => s.location)].filter(
        (l): l is string => !!l,
      ),
      url: j.jobUrl,
      postedAt: j.publishedAt ?? null,
      description: j.descriptionPlain ?? "",
    }));
  return { jobs, complete: true };
}
