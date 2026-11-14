import { z } from "zod";
import type { BoardResult, Company, FetchImpl, RawJob } from "../types";
import { getJson, incomplete, isoFromMs } from "./index";

const Payload = z.array(
  z.object({
    id: z.string(),
    text: z.string(),
    hostedUrl: z.string(),
    createdAt: z.number().nullish(),
    categories: z
      .object({ location: z.string().nullish(), allLocations: z.array(z.string()).nullish() })
      .nullish(),
    descriptionPlain: z.string().nullish(),
  }),
);

export async function fetchLever(company: Company, fetchImpl: FetchImpl): Promise<BoardResult> {
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(company.board_token)}?mode=json`;
  const res = await getJson(url, fetchImpl);
  if (res.error !== undefined) return incomplete(res.error);
  const parsed = Payload.safeParse(res.json);
  if (!parsed.success) return incomplete("invalid payload");
  const jobs: RawJob[] = parsed.data.map((j) => {
    const locs = j.categories?.allLocations?.length
      ? j.categories.allLocations
      : j.categories?.location
        ? [j.categories.location]
        : [];
    return {
      extId: j.id,
      title: j.text,
      locations: locs,
      url: j.hostedUrl,
      postedAt: isoFromMs(j.createdAt),
      description: j.descriptionPlain ?? "",
    };
  });
  return { jobs, complete: true };
}
