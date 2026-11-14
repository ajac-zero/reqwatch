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

export type JsonResult = { json: unknown; error?: undefined } | { json?: undefined; error: string };

/** Shared fetch wrapper: any failure yields an error reason instead of throwing. */
export async function getJson(url: string, fetchImpl: FetchImpl): Promise<JsonResult> {
  try {
    const res = await fetchImpl(url, { headers: { accept: "application/json", "user-agent": USER_AGENT } });
    if (!res.ok) return { error: `http ${res.status}` };
    return { json: await res.json() };
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) return { error: "timeout" };
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `fetch failed: ${msg}`.slice(0, 200) };
  }
}

export const incomplete = (error: string): BoardResult => ({ jobs: [], complete: false, error });

export function isoFromMs(ms: unknown): string | null {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export type { RawJob };
