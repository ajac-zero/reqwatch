export type Ats = "greenhouse" | "lever" | "ashby";

export interface Company {
  id: number;
  name: string;
  ats: Ats;
  board_token: string;
}

/** A job as parsed from an ATS feed, before normalization. */
export interface RawJob {
  extId: string;
  title: string;
  locations: string[];
  url: string;
  postedAt: string | null; // ISO-8601
  description: string; // plain text or HTML
}

export interface BoardResult {
  jobs: RawJob[];
  /** True only if the COMPLETE feed was fetched and parsed. */
  complete: boolean;
  /** Short reason when complete=false (e.g. "http 404", "timeout"). */
  error?: string;
}

/**
 * The global fetch, wrapped so it is never invoked with a non-global `this`
 * (Workers throw "Illegal invocation" when it is called as a method of another object).
 */
export const globalFetch: typeof fetch = (input, init) => fetch(input, init);

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface Job {
  extId: string;
  title: string;
  locations: string[];
  url: string;
  postedAt: string | null;
  contentHash: string;
  dedupKey: string;
}
