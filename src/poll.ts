import { fetchBoard } from "./ats";
import type { Db } from "./db";
import { ingestBoard, type IngestResult } from "./ingest";
import { updateAfterPoll } from "./scheduler";
import type { BoardResult, Company, FetchImpl } from "./types";

/** Caps concurrent in-flight work per key (an ATS host). */
export interface HostLimiter {
  run<T>(host: string, fn: () => Promise<T>): Promise<T>;
}

export function createHostLimiter(maxPerHost = 2): HostLimiter {
  const active = new Map<string, number>();
  const waiting = new Map<string, Array<() => void>>();
  const acquire = async (host: string) => {
    while ((active.get(host) ?? 0) >= maxPerHost) {
      await new Promise<void>((r) => waiting.set(host, [...(waiting.get(host) ?? []), r]));
    }
    active.set(host, (active.get(host) ?? 0) + 1);
  };
  const release = (host: string) => {
    active.set(host, (active.get(host) ?? 1) - 1);
    const next = waiting.get(host)?.shift();
    if (next) next();
  };
  return {
    async run(host, fn) {
      await acquire(host);
      try {
        return await fn();
      } finally {
        release(host);
      }
    },
  };
}

export interface R2Like {
  put(key: string, value: ArrayBuffer | Uint8Array): Promise<unknown>;
}

export interface PollDeps {
  db: Db;
  fetchImpl: FetchImpl;
  limiter?: HostLimiter;
  /** Optional raw snapshot bucket; snapshots are skipped when absent. */
  snapshots?: R2Like;
  now?: () => string;
}

const defaultLimiter = createHostLimiter();

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface PollOutcome {
  board: BoardResult;
  ingest: IngestResult;
  nextPollAt: string;
  circuitOpen: boolean;
}

/** fetch -> optional snapshot -> ingest -> reschedule. Throws if ingest/DB fails so the queue retries. */
export async function pollCompany(deps: PollDeps, company: Company): Promise<PollOutcome> {
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const limiter = deps.limiter ?? defaultLimiter;
  // Call via a local so fetch never receives `deps` as `this` (Workers: "Illegal invocation").
  const fetchImpl = deps.fetchImpl;
  const limited: FetchImpl = (url, init) => limiter.run(new URL(url).host, () => fetchImpl(url, init));

  const board = await fetchBoard(company, limited);

  if (deps.snapshots) {
    try {
      const key = `raw/${company.ats}/${company.board_token}/${now}.json.gz`;
      await deps.snapshots.put(key, await gzip(JSON.stringify(board)));
    } catch {
      // Snapshots are best-effort; never block ingestion.
    }
  }

  const ingest = await ingestBoard(deps.db, company, board, now);
  const { nextPollAt, circuitOpen } = await updateAfterPoll(deps.db, company, board, now);
  return { board, ingest, nextPollAt, circuitOpen };
}
