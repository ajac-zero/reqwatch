// Verifies candidate boards against public job-board APIs.
// usage: node scripts/verify-seed.ts candidates.json [--out verified.json]
// candidates: [{name, ats, token}]. Prints "ats token status jobs" per candidate.
import { readFileSync, writeFileSync } from "node:fs";

interface Candidate { name: string; ats: "greenhouse" | "lever" | "ashby"; token: string }

const UA = "reqwatch (+https://github.com/ajac-zero/reqwatch)";
const GAP_MS = 250;
const TIMEOUT_MS = 10_000;
const MAX_PARALLEL = 4;

const urlFor = (c: Candidate): string => {
  const t = encodeURIComponent(c.token);
  if (c.ats === "greenhouse") return `https://boards-api.greenhouse.io/v1/boards/${t}/jobs`;
  if (c.ats === "lever") return `https://api.lever.co/v0/postings/${t}?mode=json`;
  return `https://api.ashbyhq.com/posting-api/job-board/${t}`;
};

const countJobs = (ats: string, body: unknown): number => {
  if (ats === "lever") return Array.isArray(body) ? body.length : 0;
  const jobs = (body as { jobs?: unknown } | null)?.jobs;
  return Array.isArray(jobs) ? jobs.length : 0;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function check(c: Candidate): Promise<{ status: string; jobs: number }> {
  try {
    const res = await fetch(urlFor(c), {
      headers: { "user-agent": UA, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status !== 200) {
      await res.body?.cancel();
      return { status: String(res.status), jobs: 0 };
    }
    return { status: "200", jobs: countJobs(c.ats, await res.json()) };
  } catch (e) {
    return { status: (e as Error).name === "TimeoutError" ? "timeout" : "error", jobs: 0 };
  }
}

export async function verify(cands: Candidate[]): Promise<(Candidate & { status: string; jobs: number })[]> {
  // One sequential queue per ATS host keeps >=250ms between requests to the same host.
  const byHost = new Map<string, Candidate[]>();
  for (const c of cands) byHost.set(c.ats, [...(byHost.get(c.ats) ?? []), c]);
  const queues = [...byHost.values()];
  const results = new Map<Candidate, { status: string; jobs: number }>();
  let next = 0;
  const worker = async () => {
    while (next < queues.length) {
      for (const c of queues[next++]!) {
        const r = await check(c);
        results.set(c, r);
        console.log(`${c.ats} ${c.token} ${r.status} ${r.jobs}`);
        await sleep(GAP_MS);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, queues.length) }, worker));
  return cands.map((c) => ({ ...c, ...results.get(c)! }));
}

if (process.argv[1]?.endsWith("verify-seed.ts")) {
  const [file, flag, out] = process.argv.slice(2);
  if (!file) throw new Error("usage: verify-seed.ts candidates.json [--out verified.json]");
  const cands = JSON.parse(readFileSync(file, "utf8")) as Candidate[];
  if (cands.length > 25) throw new Error("run at most 25 candidates per invocation");
  const res = await verify(cands);
  const ok = res.filter((r) => r.status === "200" && r.jobs >= 1);
  console.log(`verified ${ok.length}/${res.length}`);
  if (flag === "--out" && out) writeFileSync(out, JSON.stringify(ok.map(({ name, ats, token, jobs }) => ({ name, ats, token, jobs }))));
}
