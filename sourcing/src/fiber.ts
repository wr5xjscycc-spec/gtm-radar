import { normalizeDomain } from "../../convex/lib/domain";

export interface Company {
  domain: string;
  name: string;
  role: "customer" | "competitor" | "battlefield";
  firmographics?: {
    size?: string;
    funding_stage?: string;
    headcount_growth?: string;
    hiring_velocity?: string;
    tech_stack?: string[];
  };
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
  };
  coverage_flags?: string[];
  source_versions?: Record<string, string>;
}

export interface FiberSimilarCompany {
  domain: string;
  name: string;
}

export interface FiberResponse {
  companies: FiberSimilarCompany[];
}

export interface FiberClient {
  findSimilarCompanies(params: {
    domain: string;
    limit?: number;
  }): Promise<FiberResponse>;
}

export function createLiveFiberClient(apiKey: string): FiberClient {
  if (!apiKey) {
    throw new Error(
      "FIBER_API_KEY is required to create a live Fiber client. " +
      "Provide the key or use createMockFiberClient() for development/testing."
    );
  }

  return {
    async findSimilarCompanies({ domain, limit }) {
      const url = new URL("https://api.fiber.ai/v1/find-similar-companies");
      url.searchParams.set("domain", domain);
      if (limit !== undefined) url.searchParams.set("limit", String(limit));

      const res = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `Fiber API error: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 500)}` : ""}`
        );
      }

      const data: FiberResponse = await res.json();
      return data;
    },
  };
}

export function createMockFiberClient(
  companies: FiberSimilarCompany[]
): FiberClient {
  return {
    async findSimilarCompanies({ domain: seedDomain, limit }) {
      const seedNorm = normalizeDomain(seedDomain);
      const seen = new Set<string>();
      const result: FiberSimilarCompany[] = [];

      for (const c of companies) {
        const norm = normalizeDomain(c.domain);
        if (!norm || norm === seedNorm) continue;
        if (seen.has(norm)) continue;
        seen.add(norm);
        result.push({ domain: norm, name: c.name });
        if (limit !== undefined && result.length >= limit) break;
      }

      return { companies: result };
    },
  };
}

export async function findSimilarCompanies(
  seedDomain: string,
  options: { limit?: number; client: FiberClient }
): Promise<Company[]> {
  const { limit, client } = options;

  const response = await client.findSimilarCompanies({
    domain: seedDomain,
    limit,
  });

  const seedNorm = normalizeDomain(seedDomain);
  const seen = new Set<string>();
  const companies: Company[] = [];

  for (const fc of response.companies) {
    const domain = normalizeDomain(fc.domain);
    if (!domain || domain === seedNorm) continue;
    if (seen.has(domain)) continue;
    seen.add(domain);

    companies.push({
      domain,
      name: fc.name || domain,
      role: "battlefield",
      coverage_flags: [],
      source_versions: { fiber_lookup: "fiber-2026.06" },
    });
  }

  return companies;
}
