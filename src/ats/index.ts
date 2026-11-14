import type { BoardResult, Company, FetchImpl, RawJob } from "../types";
import { fetchGreenhouse } from "./greenhouse";
import { fetchLever } from "./lever";
import { fetchAshby } from "./ashby";

export const USER_AGENT = "reqwatch (+https://github.com/ajac-zero/reqwatch)";

export async function fetchBoard(company: Company, fetchImpl: FetchImpl): Promise<BoardResult> {
  switch (company.ats) {
    case "greenhouse": return fetchGreenhouse(company, fetchImpl);
    case "lever": return fetchLever(company, fetchImpl);
    case "ashby": return fetchAshby(company, fetchImpl);
  }
}

/** Shared fetch wrapper: any failure yields complete=false with no jobs. */
export async function getJson(url: string, fetchImpl: FetchImpl): Promise<unknown | undefined> {
  try {
    const res = await fetchImpl(url, { headers: { accept: "application/json", "user-agent": USER_AGENT } });
    if (!res.ok) return undefined;
    return await res.json();
  } catch {
    return undefined;
  }
}

export const INCOMPLETE: BoardResult = { jobs: [], complete: false };

export function isoFromMs(ms: unknown): string | null {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export type { RawJob };
