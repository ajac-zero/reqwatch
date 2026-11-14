import { createHash } from "node:crypto";
import type { Company, Job, RawJob } from "./types";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const decode = (s: string) =>
  s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");

/** Lowercase, strip HTML (decoding entities first for escaped feeds), collapse whitespace. */
export function normText(s: string): string {
  const html = decode(s);
  return html.replace(/<[^>]*>/g, " ").replace(/&amp;|&nbsp;/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

export function normLocation(s: string): string {
  return normText(s).replace(/[.,]+$/g, "");
}

export function normalizeJob(company: Pick<Company, "name">, raw: RawJob): Job {
  const title = normText(raw.title);
  const locs = [...new Set(raw.locations.map(normLocation).filter(Boolean))].sort();
  return {
    extId: raw.extId,
    title: raw.title.trim(),
    locations: raw.locations.map((l) => l.trim()).filter(Boolean),
    url: raw.url,
    postedAt: raw.postedAt,
    contentHash: sha(JSON.stringify([title, locs, normText(raw.description)])),
    dedupKey: sha(JSON.stringify([normText(company.name), title, locs])),
  };
}
