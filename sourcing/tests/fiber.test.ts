import { describe, it, expect } from "vitest";
import {
  findSimilarCompanies,
  createMockFiberClient,
  createLiveFiberClient,
  enrichFirmographics,
  type FiberCompanyResult,
} from "../src/fiber";
import { normalizeDomain } from "../../convex/lib/domain";

const mockResults: FiberCompanyResult[] = [
  {
    preferred_name: "Sprouts.ai",
    domains: ["sprouts.ai"],
    employee_count_consensus: { gte: 140, lte: 140 },
    funding_stage: "seed",
    historical_headcount: {
      latest_snapshot_date: "2025-11-01",
      snapshots: [
        { date: "2022-11-01", employees: 32 },
        { date: "2025-11-01", employees: 140 },
      ],
      growth: { "12m": { percent: 15.2 } },
    },
    li_job_posts_stats: { total_count: 21 },
    technologies_used: [{ name: "vercel" }, { name: "hubspot" }],
    platforms: { crm: ["Hubspot"], marketing: ["Clearbit"] },
  },
  {
    preferred_name: "Amplemarket",
    domains: ["amplemarket.com"],
    employee_count_consensus: { gte: 104, lte: 104 },
    funding_stage: "series_a",
    li_job_posts_stats: { total_count: 12 },
    technologies_used: [{ name: "ruby_on_rails" }],
  },
  {
    preferred_name: "InsightSquared",
    domains: ["insightsquared.com"],
    employee_count_consensus: { gte: 20, lte: 20 },
    funding_stage: "acquired",
  },
  {
    preferred_name: "Competitor Inc",
    domains: ["competitor.com"],
  },
];

describe("createLiveFiberClient", () => {
  it("throws without an API key", () => {
    expect(() => createLiveFiberClient("")).toThrow("FIBER_API_KEY");
  });

  it("returns a client with searchCompanies method when given a key", () => {
    const client = createLiveFiberClient("sk_test_key");
    expect(client.searchCompanies).toBeDefined();
    expect(typeof client.searchCompanies).toBe("function");
  });
});

describe("enrichFirmographics", () => {
  it("maps all fields from a rich Fiber result", () => {
    const r: FiberCompanyResult = {
      preferred_name: "Sprouts.ai",
      domains: ["sprouts.ai"],
      employee_count_consensus: { gte: 140, lte: 140 },
      funding_stage: "seed",
      historical_headcount: {
        latest_snapshot_date: "2025-11-01",
        snapshots: [],
        growth: { "12m": { percent: 15.2 } },
      },
      li_job_posts_stats: { total_count: 21 },
      technologies_used: [{ name: "vercel" }, { name: "hubspot" }],
      platforms: { crm: ["Salesforce"], marketing: ["Clearbit"] },
    };
    const f = enrichFirmographics(r);
    expect(f.size).toBe("51-200");
    expect(f.funding_stage).toBe("seed");
    expect(f.headcount_growth).toBe("15.2%");
    expect(f.hiring_velocity).toBe("medium");
    expect(f.tech_stack).toContain("vercel");
    expect(f.tech_stack).toContain("hubspot");
    expect(f.tech_stack).toContain("Salesforce");
  });

  it("handles sparse results gracefully", () => {
    const r: FiberCompanyResult = {
      preferred_name: "Minimal Inc",
    };
    const f = enrichFirmographics(r);
    expect(f.size).toBeUndefined();
    expect(f.funding_stage).toBeUndefined();
    expect(f.headcount_growth).toBeUndefined();
    expect(f.hiring_velocity).toBeUndefined();
    expect(f.tech_stack).toBeUndefined();
  });

  it("maps employee count to correct size bands", () => {
    const cases: Array<[number, number, string]> = [
      [1, 1, "1-10"],
      [11, 50, "11-50"],
      [51, 200, "51-200"],
      [201, 500, "201-500"],
      [501, 1000, "501-1000"],
      [1001, 5000, "1000+"],
    ];
    for (const [gte, lte, expected] of cases) {
      const f = enrichFirmographics({
        preferred_name: "Test",
        employee_count_consensus: { gte, lte },
      });
      expect(f.size).toBe(expected);
    }
  });
});

describe("findSimilarCompanies", () => {
  const client = createMockFiberClient(mockResults);

  it("returns companies from mock", async () => {
    const result = await findSimilarCompanies("acme.com", { client });
    expect(result.length).toBeGreaterThan(0);
  });

  it("normalizes every domain and is idempotent under normalizeDomain", async () => {
    const result = await findSimilarCompanies("acme.com", { client });
    for (const c of result) {
      expect(c.domain).toBe(normalizeDomain(c.domain));
    }
  });

  it("marks all returned records as role=battlefield", async () => {
    const result = await findSimilarCompanies("acme.com", { client });
    for (const c of result) {
      expect(c.role).toBe("battlefield");
    }
  });

  it("excludes the seed customer's own domain", async () => {
    const result = await findSimilarCompanies("acme.com", { client });
    const domains = result.map((c) => c.domain);
    expect(domains).not.toContain(normalizeDomain("acme.com"));
  });

  it("deduplicates companies with the same normalized domain", async () => {
    const dupeClient = createMockFiberClient([
      ...mockResults,
      { preferred_name: "Sprouts Dupe", domains: ["www.Sprouts.ai"] },
    ]);
    const result = await findSimilarCompanies("acme.com", {
      client: dupeClient,
    });
    const domains = result.map((c) => c.domain);
    expect(new Set(domains).size).toBe(domains.length);
    const sp = domains.filter((d) => d === "sprouts.ai");
    expect(sp.length).toBe(1);
  });

  it("respects the limit option", async () => {
    const result = await findSimilarCompanies("acme.com", {
      client,
      limit: 2,
    });
    expect(result.length).toBe(2);
  });

  it("stamps source_versions on every record", async () => {
    const result = await findSimilarCompanies("acme.com", { client });
    for (const c of result) {
      expect(c.source_versions).toBeDefined();
      expect(c.source_versions?.fiber_lookup).toBe("fiber-2026.06");
    }
  });

  it("maps firmographics from Fiber results", async () => {
    const result = await findSimilarCompanies("acme.com", { client });
    const sprout = result.find((c) => c.name === "Sprouts.ai");
    expect(sprout).toBeDefined();
    expect(sprout!.firmographics).toBeDefined();
    expect(sprout!.firmographics!.size).toBe("51-200");
    expect(sprout!.firmographics!.funding_stage).toBe("seed");
  });
});
