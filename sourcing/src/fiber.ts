import { normalizeDomain } from "../../convex/lib/domain";

export interface Firmographics {
  size?: string;
  funding_stage?: string;
  headcount_growth?: string;
  hiring_velocity?: string;
  tech_stack?: string[];
}

export interface Company {
  domain: string;
  name: string;
  role: "customer" | "competitor" | "battlefield";
  firmographics?: Firmographics;
  offpage?: {
    thirdparty_mentions?: number;
    reddit_presence?: number;
    g2_presence?: number;
    wikipedia_presence?: number;
    review_site_presence?: number;
    brand_search_volume?: number;
    backlink_density?: number;
    entity_cooccurrence?: number;
  };
  understanding?: {
    category?: string;
    icp?: string;
    positioning?: string;
    what_you_are?: string;
  };
  coverage_flags?: string[];
  source_versions?: Record<string, string>;
}

export interface FiberCompanyResult {
  preferred_name: string;
  domains?: string[];
  employee_count_consensus?: { gte: number; lte: number };
  funding_stage?: string | null;
  historical_headcount?: {
    latest_snapshot_date?: string;
    snapshots?: Array<{ date: string; employees: number }>;
    growth?: Record<string, { percent: number }>;
  };
  li_job_posts_stats?: { total_count: number } | null;
  technologies_used?: Array<{ name: string }>;
  platforms?: Record<string, string[] | null>;
  short_description?: string;
  long_description?: string;
  li_industries?: Array<{ id: string; name: string; primary?: boolean }>;
}

export interface FiberCompanySearchResponse {
  output: {
    data: FiberCompanyResult[];
  };
}

export interface CompanySearchParams {
  industries?: string[];
  keywords?: string[];
  employeeRange?: { min: number; max: number };
  stage?: string[];
  pageSize?: number;
}

export interface FiberClient {
  searchCompanies(params: CompanySearchParams): Promise<FiberCompanyResult[]>;
}

function mapEmployeeCount(gte: number, lte: number): string {
  if (lte <= 10) return "1-10";
  if (lte <= 50) return "11-50";
  if (lte <= 200) return "51-200";
  if (lte <= 500) return "201-500";
  if (lte <= 1000) return "501-1000";
  return "1000+";
}

function mapFundingStage(stage: string | null | undefined): string | undefined {
  if (!stage) return undefined;
  return stage;
}

function mapHeadcountGrowth(
  hc: FiberCompanyResult["historical_headcount"]
): string | undefined {
  if (!hc?.growth) return undefined;
  const g = hc.growth;
  if (g["12m"]?.percent !== undefined) return `${g["12m"].percent.toFixed(1)}%`;
  if (g["3m"]?.percent !== undefined) return `${g["3m"].percent.toFixed(1)}%`;
  if (g["1m"]?.percent !== undefined) return `${g["1m"].percent.toFixed(1)}%`;
  return undefined;
}

function mapHiringVelocity(
  stats: { total_count: number } | null | undefined
): string | undefined {
  if (!stats?.total_count) return undefined;
  if (stats.total_count >= 100) return "high";
  if (stats.total_count >= 20) return "medium";
  return "low";
}

function mapTechStack(
  tech: Array<{ name: string }> | undefined,
  platforms: Record<string, string[] | null> | undefined
): string[] | undefined {
  const stack: string[] = [];
  if (tech) {
    for (const t of tech) {
      const name = t.name.replace(/_/g, " ");
      if (!stack.includes(name)) stack.push(name);
    }
  }
  if (platforms) {
    for (const [, tools] of Object.entries(platforms)) {
      if (tools) {
        for (const t of tools) {
          if (!stack.includes(t)) stack.push(t);
        }
      }
    }
  }
  return stack.length > 0 ? stack : undefined;
}

function extractDomain(result: FiberCompanyResult): string | null {
  const raw = result.domains?.[0];
  if (raw) return raw;
  const name = result.preferred_name;
  if (!name) return null;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 30);
  return `${slug}.com`;
}

export function enrichFirmographics(
  result: FiberCompanyResult
): Firmographics {
  const firmo: Firmographics = {};
  const emp = result.employee_count_consensus;
  if (emp && emp.gte !== undefined && emp.lte !== undefined) {
    firmo.size = mapEmployeeCount(emp.gte, emp.lte);
  }
  firmo.funding_stage = mapFundingStage(result.funding_stage);
  firmo.headcount_growth = mapHeadcountGrowth(result.historical_headcount);
  firmo.hiring_velocity = mapHiringVelocity(result.li_job_posts_stats);
  firmo.tech_stack = mapTechStack(result.technologies_used, result.platforms);
  return firmo;
}

export function createLiveFiberClient(apiKey: string): FiberClient {
  if (!apiKey) {
    throw new Error(
      "FIBER_API_KEY is required. Provide it or use createMockFiberClient()."
    );
  }

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  async function apiPost<T>(url: string, body: unknown): Promise<T> {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Fiber API error (${res.status}): ${text.slice(0, 500)}`
      );
    }
    return res.json();
  }

  return {
    async searchCompanies(params) {
      const searchBody: Record<string, unknown> = {
        apiKey,
        searchParams: {} as Record<string, unknown>,
        pageSize: params.pageSize ?? 50,
      };

      const sp = searchBody.searchParams as Record<string, unknown>;

      if (params.industries && params.industries.length > 0) {
        sp.industriesV2 = { anyOf: params.industries };
      }
      if (params.keywords && params.keywords.length > 0) {
        sp.keywords = { containsAny: params.keywords };
      }
      if (params.employeeRange) {
        sp.employeeCountV2 = {
          lowerBoundExclusive: params.employeeRange.min,
          upperBoundInclusive: params.employeeRange.max,
        };
      }
      if (params.stage && params.stage.length > 0) {
        sp.stage = { anyOf: params.stage };
      }

      const data = await apiPost<FiberCompanySearchResponse>(
        "https://api.fiber.ai/v1/company-search",
        searchBody
      );

      return data.output?.data ?? [];
    },
  };
}

export function createMockFiberClient(
  results: FiberCompanyResult[]
): FiberClient {
  return {
    async searchCompanies(_params) {
      return results;
    },
  };
}

export async function findSimilarCompanies(
  seedDomain: string,
  options: { limit?: number; client: FiberClient }
): Promise<Company[]> {
  const { limit, client } = options;

  const results = await client.searchCompanies({
    industries: ["Software", "Artificial Intelligence", "Information Technology"],
    keywords: ["gtm", "analytics", "sales intelligence", "revenue intelligence", "b2b data", "saas"],
    employeeRange: { min: 0, max: 500 },
    pageSize: limit ?? 40,
  });

  const seedNorm = normalizeDomain(seedDomain);
  const seen = new Set<string>();
  const companies: Company[] = [];

  for (const r of results) {
    if (limit !== undefined && companies.length >= limit) break;

    const rawDomain = extractDomain(r);
    if (!rawDomain) continue;

    const domain = normalizeDomain(rawDomain);
    if (!domain || domain === seedNorm) continue;
    if (seen.has(domain)) continue;
    seen.add(domain);

    companies.push({
      domain,
      name: r.preferred_name || domain,
      role: "battlefield",
      firmographics: enrichFirmographics(r),
      coverage_flags: [],
      source_versions: { fiber_lookup: "fiber-2026.06" },
    });
  }

  return companies;
}
