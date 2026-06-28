// Live Fiber AI clients — the real battlefield + firmographics source.
//
// Implements the three sourcing PORTS (`FiberClient`, `FiberFirmographicsClient`,
// `OffpageFiberClient`) against the real Fiber REST API (https://api.fiber.ai),
// using ONLY `fetch` + JSON (no SDK, no Node builtins) so the whole thing bundles
// and runs inside a default Convex V8 action — exactly like
// `measurement/src/engines/openai.ts`. `fetch` is injectable so tests replay
// recorded fixtures and never hit the network (docs/TESTING.md rule 1).
//
// WHY A FACTORY (`createFiberLive`) RATHER THAN THREE SEPARATE CLIENTS:
// Fiber's `company-search` returns the FULL company record (firmographics and all)
// for every hit in ONE call that costs 0 credits. So the battlefield sweep already
// fetches everything firmographics needs. The factory shares a per-run domain→record
// CACHE across all three ports: the search fills it for free, and
// `getFirmographics` reads the cache first, only falling back to a (2-credit)
// `kitchen-sink/company` call for the customer + typed competitors that the search
// didn't surface. One construction, minimal credits, no refetch.
//
// BATTLEFIELD = PARALLEL MULTI-ANGLE SWEEP. `company-search` is free, so we run
// several searches concurrently over a TIGHT base filter (the seed's industries +
// employee-size band) while varying only the sort order. Same relevant population,
// different rankings -> a much larger UNION of relevant companies than a single
// call, with none of the keyword-only noise (the architecture's "garbage
// battlefield -> garbage everything" failure mode). A relevance gate (industry
// overlap with the seed) is the final guard.
//
// HONESTY: Fiber is a company/people-data API. It has NO backlink / Wikipedia /
// entity-co-occurrence signals, so `getEntitySignals` returns `{}` — coverage stays
// honestly `offpage_missing` rather than fabricating SEO signals Fiber never gave.

import { normalizeDomain } from "./domain";
import type { FiberClient, FiberCompany, FindSimilarArgs } from "./fiber";
import type { FiberFirmographicsClient, FiberFirmographicsResponse } from "./firmographics";
import type { OffpageFiberClient, OffpageFiberEntityResponse } from "./offpage";

const FIBER_BASE = "https://api.fiber.ai";
/** Hard cap on companies returned from a battlefield sweep (post-union, post-relevance). */
const DEFAULT_BATTLEFIELD_LIMIT = 40;
/** Sort orders we fan out in parallel over the SAME tight filter (breadth, free). */
const SWEEP_SORTS = ["followerCount", "employeeCount", "revenueEstimate", "jobPostingCount"] as const;

/** Valid `industriesV2` enum — constrains every search so a keyword fluke can't pull
 *  in oil/consulting giants. Mirrors the Fiber OpenAPI `searchParams.industriesV2`. */
const INDUSTRY_ENUM = new Set<string>([
  "Administrative Services", "Aerospace & Military", "Artificial Intelligence", "Arts & Music",
  "Automotive", "Business Services", "Cloud", "Construction", "Consulting", "Consumer Goods",
  "Consumer Services", "Design", "Education", "Energy", "Entertainment", "Environmental", "Events",
  "Farming & Agriculture", "Finance", "Food & Beverage", "Gaming", "Government", "Hardware",
  "Healthcare", "Hospitality", "Industrials", "Information Technology", "Insurance", "Legal",
  "Life Sciences", "Logistics", "Manufacturing", "Marketing & Advertising", "Media", "Mining",
  "Nonprofit", "Publishing", "Real Estate", "Retail", "Science & Engineering", "Security",
  "Software", "Sports", "Telecom", "Trade", "Transportation", "Travel & Tourism", "Utilities",
  "Venture Capital",
]);

type FetchImpl = typeof fetch;
type Rec = Record<string, unknown>;

export interface CreateFiberLiveOpts {
  /** Fiber API key (sent in the JSON body, per Fiber's auth model — never a header). */
  apiKey: string;
  /** Injectable fetch (defaults to global `fetch`) — mock it in tests. */
  fetchImpl?: FetchImpl;
  /** Override the API base (tests). */
  baseUrl?: string;
  /** Workspace vertical — added as an extra keyword signal for the battlefield search. */
  verticalHint?: string;
  /** Max battlefield companies returned per sweep (post-union, post-relevance). */
  battlefieldLimit?: number;
}

/** All three sourcing ports, backed by one shared per-run record cache. */
export interface FiberLive {
  client: FiberClient;
  firmographics: FiberFirmographicsClient;
  entity: OffpageFiberClient;
  /**
   * Concatenated description text for a domain (from the Fiber record's
   * description fields), usable as `siteText` for the understanding pass WITHOUT a
   * scrape. Empty string when the record/descriptions are absent.
   */
  describe(domain: string): Promise<string>;
}

// ───────────────────────── tolerant accessors (never throw on bad shapes) ─────

function asRec(x: unknown): Rec | undefined {
  return typeof x === "object" && x !== null ? (x as Rec) : undefined;
}
function asArr(x: unknown): unknown[] {
  return Array.isArray(x) ? x : [];
}
function asStr(x: unknown): string | undefined {
  return typeof x === "string" && x.trim().length > 0 ? x.trim() : undefined;
}
function asNum(x: unknown): number | undefined {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string" && x.trim() !== "" && Number.isFinite(Number(x))) return Number(x);
  return undefined;
}

/** Pull the company record list out of a Fiber `{output:{data:[…]}}` envelope. */
function dataList(payload: unknown): Rec[] {
  const data = asRec(asRec(payload)?.output)?.data;
  return asArr(data).map(asRec).filter((r): r is Rec => r !== undefined);
}
/** Pull the single record out of a kitchen-sink `{output:{data:[rec]}}` envelope. */
function firstData(payload: unknown): Rec | undefined {
  const data = asRec(asRec(payload)?.output)?.data;
  if (Array.isArray(data)) return asRec(data[0]);
  return asRec(data);
}

// ───────────────────────── record → contract mappers ─────────────────────────

/** Normalized registrable domain for a Fiber record (its join key). */
function recDomain(rec: Rec): string {
  const list = asArr(rec.domains).length ? asArr(rec.domains) : asArr(rec.websites);
  const first = list.find((d) => typeof d === "string" && d.length > 0);
  return first ? normalizeDomain(String(first)) : "";
}
function recName(rec: Rec): string | undefined {
  return asStr(rec.preferred_name) ?? asStr(asArr(rec.names)[0]);
}
function recCategory(rec: Rec): string | undefined {
  return asStr(asArr(rec.standard_industries)[0]) ?? asStr(rec.short_description);
}
/** Map one Fiber record to the lightweight `FiberCompany` the battlefield consumes. */
function recToFiberCompany(rec: Rec): FiberCompany | null {
  const domain = recDomain(rec);
  if (!domain) return null;
  const company: FiberCompany = { domain, name: recName(rec) ?? domain };
  const category = recCategory(rec);
  if (category) company.category = category;
  return company;
}

/** Coarse employee-size band from Fiber's `employee_count_consensus`. */
function sizeBand(rec: Rec): string | undefined {
  const ecc = asRec(rec.employee_count_consensus);
  const n = asNum(ecc?.gte) ?? asNum(ecc?.lte);
  if (n === undefined) return undefined;
  if (n < 11) return "1-10";
  if (n < 51) return "11-50";
  if (n < 201) return "51-200";
  if (n < 501) return "201-500";
  if (n < 1001) return "501-1000";
  if (n < 5001) return "1001-5000";
  return "5000+";
}

/** Headcount growth as a fraction (e.g. 0.25 = +25%). Prefers Fiber's normalized
 *  12-month figure (comparable across companies); falls back to a full-window
 *  recompute from raw snapshots when the normalized field is absent. */
function headcountGrowth(rec: Rec): number | undefined {
  const hh = asRec(rec.historical_headcount);
  const twelveMonth = asNum(asRec(asRec(hh?.growth)?.["12m"])?.percent);
  if (twelveMonth !== undefined) return twelveMonth;
  const snaps = asArr(hh?.snapshots)
    .map(asRec)
    .filter((s): s is Rec => s !== undefined)
    .map((s) => ({ date: asStr(s.date) ?? "", employees: asNum(s.employees) }))
    .filter((s) => s.date !== "" && s.employees !== undefined)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (snaps.length < 2) return undefined;
  const first = snaps[0].employees as number;
  const last = snaps[snaps.length - 1].employees as number;
  if (first <= 0) return undefined;
  return Number(((last - first) / first).toFixed(3));
}

/** Hiring velocity proxy = count of current LinkedIn job postings. */
function hiringVelocity(rec: Rec): number | undefined {
  return asNum(asRec(rec.li_job_posts_stats)?.total_count);
}

/** Tech stack = named technologies + any platform tools (cms/crm/etc.). */
function techStack(rec: Rec): string[] | undefined {
  const out: string[] = [];
  for (const t of asArr(rec.technologies_used)) {
    const name = asStr(asRec(t)?.name);
    if (name) out.push(name);
  }
  const platforms = asRec(rec.platforms);
  if (platforms) {
    for (const v of Object.values(platforms)) {
      for (const item of asArr(v)) {
        const name = asStr(item);
        if (name) out.push(name);
      }
    }
  }
  const deduped = [...new Set(out)];
  return deduped.length > 0 ? deduped : undefined;
}

/** Map a Fiber rich record to the firmographics PORT response (only the 5 contract fields). */
function recToFirmographics(rec: Rec): FiberFirmographicsResponse {
  const out: FiberFirmographicsResponse = {};
  const size = sizeBand(rec);
  if (size) out.size = size;
  const stage = asStr(rec.funding_stage);
  if (stage) out.funding_stage = stage;
  const growth = headcountGrowth(rec);
  if (growth !== undefined) out.headcount_growth = String(growth);
  const hiring = hiringVelocity(rec);
  if (hiring !== undefined) out.hiring_velocity = String(hiring);
  const tech = techStack(rec);
  if (tech) out.tech_stack = tech;
  return out;
}

// ───────────────────────── battlefield search construction ───────────────────

/** Seed's industries, intersected with the valid enum (so a search can't 400). */
function seedIndustries(seedRec: Rec | undefined): string[] {
  if (!seedRec) return [];
  return asArr(seedRec.standard_industries)
    .map(asStr)
    .filter((s): s is string => s !== undefined && INDUSTRY_ENUM.has(s));
}

/** Content terms that mark a job-board / staffing / careers page rather than a
 *  product company — excluded at the SOURCE via keywords.containsNone so they never
 *  enter the union (the raw vertical otherwise matches "<vertical> manager" jobs). */
const KEYWORD_EXCLUSIONS = ["staffing", "recruitment", "recruiting", "job board", "careers"];

/**
 * Product-space keyword signals (the keywords.containsAny set). QUALIFIES the
 * vertical with product words ("<vertical> software/tool/platform") so it matches
 * SaaS products, not job listings, and adds the seed's LinkedIn specialties (e.g.
 * "Software & SaaS"). Deliberately NOT the raw vertical or generic alt_keywords —
 * those pull in job boards and unrelated firms.
 */
function seedKeywords(seedRec: Rec | undefined, verticalHint?: string): string[] {
  const kw: string[] = [];
  const hint = asStr(verticalHint);
  if (hint) kw.push(`${hint} software`, `${hint} tool`, `${hint} platform`);
  if (seedRec) {
    for (const s of asArr(seedRec.li_specialties)) {
      const v = asStr(s);
      if (v) kw.push(v);
    }
  }
  return [...new Set(kw.map((k) => k.toLowerCase()))].slice(0, 8);
}

/** Employee-count band around the seed (0.05x–20x), or undefined when size unknown. */
function employeeBand(seedRec: Rec | undefined): Rec | undefined {
  const n = asNum(asRec(seedRec?.employee_count_consensus)?.gte);
  if (n === undefined || n <= 0) return undefined;
  return {
    lowerBoundExclusive: Math.max(1, Math.floor(n / 20)),
    upperBoundInclusive: Math.ceil(n * 20),
  };
}

/**
 * Build the parallel search angles: a TIGHT base filter (seed industries + size +
 * keywords) repeated across several sort orders. Same relevant population, different
 * rankings -> a broad union of RELEVANT companies (no keyword-only noise).
 */
function buildAngles(seedRec: Rec | undefined, verticalHint?: string): Rec[] {
  const industries = seedIndustries(seedRec);
  const keywords = seedKeywords(seedRec, verticalHint);
  const band = employeeBand(seedRec);

  const base: Rec = {};
  if (industries.length) base.industriesV2 = { anyOf: industries };
  if (keywords.length) base.keywords = { containsAny: keywords, containsNone: KEYWORD_EXCLUSIONS };
  if (band) base.employeeCountV2 = band;

  // Nothing to filter on (seed unresolved, no vertical) -> a single popularity sort.
  if (Object.keys(base).length === 0) {
    return [{ sort: [{ field: "followerCount", direction: "desc" }] }];
  }
  return SWEEP_SORTS.map((field) => ({ ...base, sort: [{ field, direction: "desc" }] }));
}

/** Industries so broad that nearly every tech-adjacent company tags them — useless
 *  for telling a product competitor from a staffing/consulting/media firm. */
const BROAD_INDUSTRIES = new Set(["Information Technology", "Business Services", "Consulting", "Administrative Services"]);
/** "Non-product" tags (services, media, publishing, education): a company carrying
 *  one is a product competitor ONLY if it's also venture-backed. This drops the
 *  IT-services/staffing/media/publisher/job-board firms that incidentally tag
 *  "Software" (e.g. Bloomberg, TechCrunch, w3schools) while keeping pure-software
 *  companies (Figma, GitLab) and legit venture SaaS that happens to tag a category. */
const NON_PRODUCT_INDUSTRIES = new Set([
  "Business Services", "Consulting", "Publishing", "Media", "Education",
  "Entertainment", "Marketing & Advertising",
]);
/** Funding stages that signal a real venture-backed product company. */
const VENTURE_STAGE = /seed|series|angel|venture|pre_seed|growth|equity_crowdfunding/i;

/** Is this a venture-backed product company (by tag or funding stage)? */
function isVentureBacked(rec: Rec): boolean {
  const tags = asArr(rec.tags)
    .map((t) => asStr(t)?.toLowerCase())
    .filter((s): s is string => s !== undefined)
    .join(" ");
  if (tags.includes("venture")) return true;
  const stage = asStr(rec.funding_stage);
  return stage ? VENTURE_STAGE.test(stage) : false;
}

/** The seed's DISCRIMINATING industries — drop the over-broad ones everyone tags so
 *  the relevance gate keys on the product-defining industry (e.g. "Software", "AI").
 *  Falls back to the full set if the seed only carries broad tags. */
function discriminatingIndustries(seedRec: Rec | undefined): string[] {
  const all = seedIndustries(seedRec);
  const disc = all.filter((i) => !BROAD_INDUSTRIES.has(i));
  return disc.length ? disc : all;
}

/**
 * Relevance gate (the precision guard against "garbage battlefield"):
 *  1. the hit must share a DISCRIMINATING industry with the seed, and
 *  2. a non-product-tagged hit (services/media/publishing/education) survives only
 *     if it's venture-backed — drops the IT-services/staffing/media/publisher firms
 *     that incidentally tag the seed's product industry.
 */
function isRelevant(rec: Rec, discriminating: Set<string>): boolean {
  if (discriminating.size === 0) return true; // can't judge -> don't drop
  const ind = new Set(
    asArr(rec.standard_industries)
      .map(asStr)
      .filter((s): s is string => s !== undefined),
  );
  let overlap = false;
  for (const i of discriminating) {
    if (ind.has(i)) {
      overlap = true;
      break;
    }
  }
  if (!overlap) return false;
  let isNonProduct = false;
  for (const s of NON_PRODUCT_INDUSTRIES) {
    if (ind.has(s)) {
      isNonProduct = true;
      break;
    }
  }
  if (isNonProduct && !isVentureBacked(rec)) return false;
  return true;
}

// ───────────────────────── HTTP (degrades, never throws the action down) ──────

async function fiberPost(
  fetchImpl: FetchImpl,
  base: string,
  apiKey: string,
  path: string,
  body: Rec,
): Promise<unknown | undefined> {
  let res: Response;
  try {
    res = await fetchImpl(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey, ...body }),
    });
  } catch {
    return undefined; // network/timeout -> degrade
  }
  if (!res.ok) return undefined; // 4xx/5xx -> degrade (one bad call never blanks the battlefield)
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

// ───────────────────────── the factory ───────────────────────────────────────

/**
 * Construct the three live Fiber ports over one shared record cache.
 * - `client.findSimilarCompanies` runs the parallel multi-angle battlefield sweep.
 * - `firmographics.getFirmographics` serves from cache (free) or kitchen-sink (2cr).
 * - `entity.getEntitySignals` returns `{}` (Fiber has no off-page entity signals).
 */
export function createFiberLive(opts: CreateFiberLiveOpts): FiberLive {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = (opts.baseUrl ?? FIBER_BASE).replace(/\/+$/, "");
  const apiKey = opts.apiKey;
  const hardLimit = opts.battlefieldLimit ?? DEFAULT_BATTLEFIELD_LIMIT;
  const cache = new Map<string, Rec>(); // normalizedDomain -> rich Fiber record

  /** Resolve one domain to its rich record: cache, else a kitchen-sink lookup. */
  async function resolve(domain: string): Promise<Rec | undefined> {
    const d = normalizeDomain(domain);
    if (!d) return undefined;
    const hit = cache.get(d);
    if (hit) return hit;
    const payload = await fiberPost(fetchImpl, base, apiKey, "/v1/kitchen-sink/company", {
      companyDomain: { value: d },
    });
    const rec = firstData(payload);
    if (rec) cache.set(d, rec);
    return rec;
  }

  const client: FiberClient = {
    async findSimilarCompanies(args: FindSimilarArgs): Promise<FiberCompany[]> {
      const seed = normalizeDomain(args.domain);
      if (!seed) return [];
      const limit = args.limit && args.limit > 0 ? Math.min(args.limit, hardLimit) : hardLimit;

      const seedRec = await resolve(seed); // 1 kitchen-sink call (2 credits)
      const relevant = new Set(discriminatingIndustries(seedRec));
      const angles = buildAngles(seedRec, opts.verticalHint);

      // PARALLEL sweep — company-search is 0 credits, so breadth is free. allSettled
      // isolates a failed angle (one bad search never empties the battlefield).
      const batches = await Promise.allSettled(
        angles.map((searchParams) =>
          fiberPost(fetchImpl, base, apiKey, "/v1/company-search", { searchParams }),
        ),
      );

      const out: FiberCompany[] = [];
      const seen = new Set<string>([seed]); // the customer is not its own competitor
      for (const b of batches) {
        if (b.status !== "fulfilled") continue;
        for (const rec of dataList(b.value)) {
          const dom = recDomain(rec);
          if (!dom || seen.has(dom)) continue;
          if (!isRelevant(rec, relevant)) continue; // precision guard
          seen.add(dom);
          cache.set(dom, rec); // firmographics for this company are now FREE
          const company = recToFiberCompany(rec);
          if (company) out.push(company);
          if (out.length >= limit) return out;
        }
      }
      return out;
    },
  };

  const firmographics: FiberFirmographicsClient = {
    async getFirmographics({ domain }: { domain: string }): Promise<FiberFirmographicsResponse> {
      const rec = await resolve(domain); // cache hit for swept companies; lookup for customer/competitors
      return rec ? recToFirmographics(rec) : {};
    },
  };

  async function describe(domain: string): Promise<string> {
    const rec = await resolve(domain);
    if (!rec) return "";
    const parts = [
      asStr(rec.short_description),
      asStr(rec.long_description),
      asStr(rec.li_description),
      asStr(rec.li_headline),
      asStr(rec.alt_description),
    ].filter((s): s is string => s !== undefined);
    // De-dupe identical blocks (Fiber often repeats the same text across fields).
    return [...new Set(parts)].join("\n").trim();
  }

  const entity: OffpageFiberClient = {
    async getEntitySignals(): Promise<OffpageFiberEntityResponse> {
      // Fiber is a company/people-data API — it has no backlink / Wikipedia /
      // entity-co-occurrence signals. Return {} so coverage stays honestly
      // `offpage_missing` instead of fabricating SEO signals. (Upgrade path:
      // /v1/twitter/user-mentions for a real thirdparty_mentions proxy.)
      return {};
    },
  };

  return { client, firmographics, entity, describe };
}
