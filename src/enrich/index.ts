import { normText } from "../normalize";
import { parseLocation } from "./locations";
import type { ParsedLocation } from "./locations";

export { parseLocation };
export type { ParsedLocation };

export const ROLE_FAMILIES = [
  "software_engineering", "ml_ai", "data", "infra_sre", "security", "product", "design", "other",
] as const;
export const SENIORITIES = ["intern", "new_grad", "entry", "mid", "senior", "staff_plus", "manager", "unknown"] as const;
/** Bump when enrichment logic improves; unchanged jobs with unknown seniority are re-enriched once per bump. */
export const ENRICH_VERSION = 2;
export type RoleFamily = (typeof ROLE_FAMILIES)[number];
export type Seniority = (typeof SENIORITIES)[number];
export type Sponsorship = "offers" | "no" | "unknown";
export type EmploymentType = "intern" | "full_time" | "part_time" | "contract" | "unknown";

export interface EnrichInput {
  title: string;
  locations: string[];
  description: string;
}

export interface Enrichment {
  role_family: RoleFamily;
  seniority: Seniority;
  /** Sorted ISO2 codes; empty when no location states a country. */
  countries: string[];
  remote: boolean;
  sponsorship: Sponsorship;
  /** YYYY-MM or null */
  grad_window_start: string | null;
  grad_window_end: string | null;
  employment_type: EmploymentType;
}

// ---------- role family ----------
const TITLE_RULES: [RoleFamily, RegExp][] = [
  ["design", /\b(designer|ux|ui\/ux|user experience|product design|design lead|design engineer)\b/],
  ["product", /\b(product (manager|management|owner|lead)|apm|group product|chief product|head of product)\b/],
  ["ml_ai", /\b(machine learning|ml|ai|a\.i\.|artificial intelligence|deep learning|nlp|computer vision|llm|applied scientist|research scientist|research engineer|mlops|generative)\b/],
  ["security", /\b(security|appsec|infosec|cryptograph\w*|penetration|pentest|threat|red team|detection engineer|trust (and|&) safety)\b/],
  ["infra_sre", /\b(sre|site reliability|devops|infrastructure|platform engineer\w*|cloud engineer\w*|reliability|production engineer\w*|systems? engineer\w*|network engineer\w*|kubernetes|dev ?ops)\b/],
  ["data", /\b(data|analytics|analyst|business intelligence|bi engineer|statistician|quantitative)\b/],
  ["software_engineering", /\b(software|swe|sde|developer|frontend|front-end|backend|back-end|full[- ]?stack|ios|android|mobile (engineer|developer)|web (engineer|developer)|programmer|member of technical staff|mts)\b/],
];

const DESC_KEYWORDS: [RoleFamily, RegExp][] = [
  ["ml_ai", /\b(machine learning|deep learning|neural network\w*|pytorch|tensorflow|llms?|model training)\b/g],
  ["data", /\b(sql|data pipelines?|etl|data warehouse|spark|airflow|dbt|analytics)\b/g],
  ["infra_sre", /\b(kubernetes|terraform|on-call|incident response|observability|ci\/cd|infrastructure as code)\b/g],
  ["security", /\b(vulnerabilit\w+|threat model\w*|penetration testing|siem|incident response|encryption)\b/g],
  ["software_engineering", /\b(python|java|typescript|golang|c\+\+|rust|backend|frontend|distributed systems|rest apis?|microservices|software development)\b/g],
];

export function roleFamily(title: string, description: string): RoleFamily {
  const t = normText(title);
  for (const [fam, re] of TITLE_RULES) if (re.test(t)) return fam;
  // Weak fallback: only for engineer-ish titles, and only with several keyword hits.
  if (/\b(engineer|developer|scientist|engineering)\b/.test(t)) {
    const d = normText(description);
    let best: RoleFamily = "other";
    let bestN = 2; // need at least 3 hits
    for (const [fam, re] of DESC_KEYWORDS) {
      const n = (d.match(re) ?? []).length;
      if (n > bestN) { best = fam; bestN = n; }
    }
    return best;
  }
  return "other";
}

// ---------- seniority ----------
export function seniority(title: string, description = ""): Seniority {
  const fromTitle = titleSeniority(title);
  if (fromTitle !== "unknown" || TITLE_LEVEL_MARKERS.test(normText(title))) return fromTitle;
  return descriptionSeniority(description);
}

// Level markers the title rules do not classify (L4+, IV and up): the title says "not junior", so the
// description is never consulted.
const TITLE_LEVEL_MARKERS = /\b(l[4-9]|l\d\d|iv|v|vi|[4-9])\b|\b(senior|staff|principal|lead|manager|director)\b/;

const LOOKBACK_BLOCK = /\b(our|mentor\w*|manag\w*|supervis\w*|host\w*|run|runs|lead\w*|support\w*|not an?)\s+(?:[\w-]+\s+)?$/;
const DESC_RULES: [Seniority, RegExp][] = [
  ["new_grad", /\b(new grad(?:uate)?s?|university grad(?:uate)?s?|recent grad(?:uate)?s?|class of 20\d\d|graduating (?:in|between|by|from)\b[^.]{0,40}20\d\d|early careers?|no prior experience (?:is )?required)\b/g],
  ["entry", /\b(entry[- ]level|0 ?(?:-|to) ?2 years)\b/g],
  ["intern", /\b(internships?|intern program|(?:summer|fall|winter|spring) 20\d\d intern\w*)\b/g],
];
const HEADINGS = /\b(about the (?:role|job|position|opportunity)|who you are|about you|who we(?:'| a)re looking for)\b/g;
const SENIOR_EXPERIENCE = /\b(?:[3-9]|1\d)\+ years|\bat least (?:[3-9]|1\d) years|\b(?:[3-9]|1\d) (?:or more )?years of (?:[\w-]+ ){0,3}experience/;
const INTRO_CHARS = 600;
const HEADING_CHARS = 400;

/** High-precision level phrases, honoured only in the intro or right after an "About the role"-style heading. */
function descriptionSeniority(description: string): Seniority {
  const d = normText(description);
  if (!d || SENIOR_EXPERIENCE.test(d)) return "unknown";
  const spans: [number, number][] = [[0, INTRO_CHARS]];
  for (const h of d.matchAll(HEADINGS)) spans.push([h.index!, h.index! + h[0].length + HEADING_CHARS]);
  const found = new Set<Seniority>();
  for (const [level, re] of DESC_RULES) {
    for (const m of d.matchAll(re)) {
      const at = m.index!;
      if (!spans.some(([a, b]) => at >= a && at < b)) continue;
      if (LOOKBACK_BLOCK.test(d.slice(Math.max(0, at - 30), at))) continue;
      found.add(level);
    }
  }
  return found.size === 1 ? [...found][0]! : "unknown";
}

function titleSeniority(title: string): Seniority {
  const t = normText(title);
  if (/\b(intern|interns|internship|co-?op|apprentice)\b/.test(t)) return "intern";
  if (/\b(new grads?|university grad\w*|graduate|early careers?|recent grad\w*|campus)\b/.test(t)) return "new_grad";
  if (/\b(manager|director|head of|vp|vice president)\b/.test(t)) return "manager";
  if (/\b(staff|principal|distinguished|fellow|lead|architect)\b/.test(t)) return "staff_plus";
  if (/\b(senior|sr\.?|iii|3)\b/.test(t) && !/\b(sr\.?|senior)\s*(vp|vice)\b/.test(t)) return "senior";
  if (/\b(ii|2|mid-level|intermediate)\b/.test(t)) return "mid";
  if (/\b(junior|jr\.?|entry[- ]level|associate)\b/.test(t)) return "entry";
  if (/\b(engineer|developer|scientist|analyst|designer|swe|sde)\s*,?\s*(i|1)\b(?![\w.+#/-])/.test(t) || /(^|[\s,-])i$/.test(t)) return "entry";
  return "unknown";
}

// ---------- employment type ----------
export function employmentType(title: string, description: string): EmploymentType {
  const t = normText(title);
  if (/\b(intern|interns|internship|co-?op)\b/.test(t)) return "intern";
  if (/\b(contract|contractor|temporary|temp)\b/.test(t)) return "contract";
  if (/\bpart[- ]time\b/.test(t)) return "part_time";
  if (/\bfull[- ]time\b/.test(t)) return "full_time";
  const d = normText(description);
  const ft = /\bfull[- ]time\b/.test(d), pt = /\bpart[- ]time\b/.test(d), ct = /\b(contract position|contract role|fixed[- ]term contract)\b/.test(d);
  if (ft && !pt && !ct) return "full_time";
  if (pt && !ft && !ct) return "part_time";
  if (ct && !ft && !pt) return "contract";
  return "unknown";
}

// ---------- sponsorship ----------
const NO_PATTERNS: RegExp[] = [
  /\b(will not|won't|do not|don't|does not|doesn't|cannot|can't|can not|unable to|not able to|not in a position to) (?:currently )?(?:offer |provide |support )?(?:visa |employment |immigration |work )?sponsor\w*/g,
  /\bnot (?:currently )?(?:offer|offering|provide|providing|available for) (?:visa |employment |immigration )?sponsorship/g,
  /\b(?:without|no|not eligible for|not requiring|not require|does not require|do not require) (?:the need for |any |future |current )?(?:visa |employment |immigration |work )?(?:sponsorship|sponsor)\b/g,
  /\bwithout (?:[a-z-]+ ){0,6}sponsorship/g,
  /\bsponsorship (?:is |are )?(?:not available|unavailable|not offered|not provided)/g,
  /\bnot (?:now or in the future )?(?:require|need)s? (?:visa |employment )?sponsorship/g,
  /\bnow or in the future require sponsorship/g,
];
const YES_PATTERNS: RegExp[] = [
  /\b(?:visa |immigration |employment |h-?1b )?sponsorship (?:is |are )?(?:available|provided|offered|possible)/g,
  /\bwe (?:do |can |will |also |are able to )?sponsor\b/g,
  /\bwill sponsor\b/g,
  /\bwe (?:offer|provide) (?:visa |immigration |employment )?sponsorship/g,
  /\b(?:offers?|providing|provides|offering) (?:visa |immigration |employment |h-?1b )?sponsorship/g,
  /\b(?:open to|willing to|happy to|able to|can) sponsor\w*/g,
  /\bsponsor(?:s|ing)? (?:visas?|h-?1b|work (?:visas|authorization))/g,
];

export function sponsorship(description: string): Sponsorship {
  let d = normText(description).replace(/[’‘]/g, "'");
  let no = false;
  for (const re of NO_PATTERNS) {
    if (re.test(d)) no = true;
    re.lastIndex = 0;
    d = d.replace(re, " ");
  }
  let yes = false;
  for (const re of YES_PATTERNS) {
    if (re.test(d)) yes = true;
    re.lastIndex = 0;
  }
  if (no && yes) return "unknown";
  return no ? "no" : yes ? "offers" : "unknown";
}

// ---------- graduation window ----------
const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6,
  july: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9, october: 10, oct: 10,
  november: 11, nov: 11, december: 12, dec: 12,
};
const MON = "(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\\.?";
const YEAR = "(20\\d\\d)";
const ym = (y: string | number, m: number) => `${y}-${String(m).padStart(2, "0")}`;
const SEASONS: Record<string, [number, number]> = { spring: [2, 5], summer: [6, 8], fall: [9, 12], autumn: [9, 12], winter: [1, 3] };

export function gradWindow(description: string, title = ""): { start: string | null; end: string | null } {
  const d = normText(`${title}. ${description}`).replace(/[–—]/g, "-");
  const none = { start: null, end: null };
  let m: RegExpMatchArray | null;

  m = d.match(new RegExp(`graduat\\w*[^.]{0,40}?(?:between|from)? ?${MON}? ?${YEAR}? ?(?:and|to|through|-) ?${MON} ?${YEAR}`));
  if (m) {
    const y2 = m[4]!;
    const start = ym(m[2] ?? y2, m[1] ? MONTHS[m[1]]! : 1);
    const end = ym(y2, MONTHS[m[3]!]!);
    if (start <= end) return { start, end };
  }
  m = d.match(/\bclass of (20\d\d)\b/);
  if (m) return { start: ym(m[1]!, 1), end: ym(m[1]!, 12) };
  m = d.match(new RegExp(`graduat\\w*(?: \\w+){0,3}? (?:in|by|on|around|before|after)? ?(?:${MON} ?)?${YEAR}`));
  if (m) {
    return m[1] ? { start: ym(m[2]!, MONTHS[m[1]]!), end: ym(m[2]!, MONTHS[m[1]]!) } : { start: ym(m[2]!, 1), end: ym(m[2]!, 12) };
  }
  m = d.match(new RegExp(`\\b(spring|summer|fall|autumn|winter) ${YEAR}\\b(?: \\w+){0,2}? (?:intern|internship|co-?op|program)`));
  if (m) {
    const [a, b] = SEASONS[m[1]!]!;
    return { start: ym(m[2]!, a), end: ym(m[2]!, b) };
  }
  m = d.match(new RegExp(`\\bstart(?:ing)? dates?\\b[^.]{0,40}?(?:${MON} ?)?${YEAR}`));
  if (m) {
    return m[1] ? { start: ym(m[2]!, MONTHS[m[1]]!), end: ym(m[2]!, MONTHS[m[1]]!) } : { start: ym(m[2]!, 1), end: ym(m[2]!, 12) };
  }
  return none;
}

// ---------- main ----------
export function enrichJob(input: EnrichInput): Enrichment {
  const parsed = input.locations.map(parseLocation);
  const countries = [...new Set(parsed.map((p) => p.country).filter((c): c is string => !!c))].sort();
  const remote = parsed.some((p) => p.remote) || /\bremote\b/i.test(input.title);
  const win = gradWindow(input.description, input.title);
  return {
    role_family: roleFamily(input.title, input.description),
    seniority: seniority(input.title, input.description),
    countries,
    remote,
    sponsorship: sponsorship(input.description),
    grad_window_start: win.start,
    grad_window_end: win.end,
    employment_type: employmentType(input.title, input.description),
  };
}
