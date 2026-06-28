import { describe, it, expect } from "vitest";
import { normalizeDomain, sameDomain } from "../../convex/lib/domain";
import {
  joinCompanyToPages,
  joinAllCompaniesToPages,
  computeCoverageFlags,
  type InheritedPageRow,
} from "../src/joinIntegrity";
import type { Company } from "../src/fiber";
import type { PageRecord } from "../src/content";

function makeCompany(overrides: Partial<Company> & { domain: string }): Company {
  return {
    name: overrides.domain,
    role: "battlefield",
    firmographics: { size: "11-50", funding_stage: "seed" },
    offpage: { thirdparty_mentions: 5, reddit_presence: 1, g2_presence: 1, brand_search_volume: 200 },
    understanding: { category: "GTM analytics", icp: "growth teams", positioning: "leader" },
    coverage_flags: [],
    source_versions: { fiber_lookup: "fiber-2026.06" },
    ...overrides,
  };
}

function makePage(overrides: Partial<PageRecord> & { url: string; company_domain: string }): PageRecord {
  return {
    role: "candidate",
    content_features: {
      schema_markup: false,
      comparison_table: false,
      word_count: 500,
      heading_structure: "h1:1",
      freshness_days: 30,
      query_term_coverage: 0.5,
      direct_answer_first: false,
      stats_density: "none",
      citation_density: "none",
      quote_density: "none",
      listicle_vs_prose: "prose",
    },
    extractor_version: "extractor-2026.06-v2",
    scraped_at: "2026-06-01T00:00:00.000Z",
    cache_key: "cached",
    ...overrides,
  };
}

const ACME_COMPANY = makeCompany({
  domain: "acme.com",
  name: "Acme Analytics",
  role: "customer",
  firmographics: { size: "51-200", funding_stage: "series-a", tech_stack: ["react", "node"] },
  offpage: { thirdparty_mentions: 42, reddit_presence: 8, g2_presence: 1, wikipedia_presence: 1, brand_search_volume: 5400, backlink_density: 0.3, entity_cooccurrence: 12 },
  understanding: { category: "GTM analytics", icp: "PLG SaaS growth teams", positioning: "AI-answer citation measurement" },
});

const ACME_PAGES: PageRecord[] = [
  makePage({ url: "https://acme.com/pricing", company_domain: "acme.com", role: "candidate", content_features: { schema_markup: true, comparison_table: true, word_count: 1200, heading_structure: "h1:1 h2:3", freshness_days: 14, query_term_coverage: 0.8, direct_answer_first: false, stats_density: "medium", citation_density: "low", quote_density: "none", listicle_vs_prose: "mixed" } }),
  makePage({ url: "https://acme.com/about", company_domain: "acme.com", role: "candidate", content_features: { schema_markup: false, comparison_table: false, word_count: 800, heading_structure: "h1:1 h2:2", freshness_days: 45, query_term_coverage: 0.3, direct_answer_first: false, stats_density: "none", citation_density: "none", quote_density: "none", listicle_vs_prose: "prose" } }),
  makePage({ url: "https://acme.com/blog", company_domain: "acme.com", role: "candidate", content_features: { schema_markup: false, comparison_table: false, word_count: 1500, heading_structure: "h1:1 h2:5", freshness_days: 210, query_term_coverage: 0.6, direct_answer_first: true, stats_density: "low", citation_density: "medium", quote_density: "low", listicle_vs_prose: "prose" } }),
];

const COMPETITOR_COMPANY = makeCompany({
  domain: "competitor.com",
  name: "Competitor Inc",
  role: "competitor",
});

const COMPETITOR_PAGES: PageRecord[] = [
  makePage({ url: "https://competitor.com/pricing", company_domain: "competitor.com", role: "competitor" }),
];

describe("joinCompanyToPages", () => {
  it("attaches company context to every page row", () => {
    const result = joinCompanyToPages(ACME_COMPANY, ACME_PAGES);
    expect(result.joined.length).toBe(3);
    for (const row of result.joined) {
      expect(row.company_domain).toBe("acme.com");
      expect(row.company_name).toBe("Acme Analytics");
      expect(row.company_role).toBe("customer");
      expect(row.firmographics).toEqual({ size: "51-200", funding_stage: "series-a", tech_stack: ["react", "node"] });
      expect(row.offpage).toEqual({ thirdparty_mentions: 42, reddit_presence: 8, g2_presence: 1, wikipedia_presence: 1, brand_search_volume: 5400, backlink_density: 0.3, entity_cooccurrence: 12 });
      expect(row.understanding).toEqual({ category: "GTM analytics", icp: "PLG SaaS growth teams", positioning: "AI-answer citation measurement" });
    }
  });

  it("preserves page-specific features alongside inherited context", () => {
    const result = joinCompanyToPages(ACME_COMPANY, ACME_PAGES);
    const pricing = result.joined.find((r) => r.page_url === "https://acme.com/pricing");
    expect(pricing).toBeDefined();
    expect(pricing!.page_features.word_count).toBe(1200);
    expect(pricing!.page_features.schema_markup).toBe(true);

    const about = result.joined.find((r) => r.page_url === "https://acme.com/about");
    expect(about).toBeDefined();
    expect(about!.page_features.word_count).toBe(800);
  });

  it("reports orphan pages with mismatched domains", () => {
    const result = joinCompanyToPages(ACME_COMPANY, [
      ...ACME_PAGES,
      makePage({ url: "https://other.com/page", company_domain: "other.com" }),
    ]);
    expect(result.joined.length).toBe(3);
    expect(result.orphan_pages.length).toBe(1);
    expect(result.orphan_pages[0].url).toBe("https://other.com/page");
  });

  it("attaches empty company-level fields as null when missing", () => {
    const lean = makeCompany({ domain: "lean.com", name: "Lean Co", offpage: undefined, understanding: undefined, firmographics: undefined });
    const page = makePage({ url: "https://lean.com/page", company_domain: "lean.com" });
    const result = joinCompanyToPages(lean, [page]);
    expect(result.joined.length).toBe(1);
    expect(result.joined[0].offpage).toBeNull();
    expect(result.joined[0].understanding).toBeNull();
    expect(result.joined[0].firmographics).toBeNull();
  });

  it("inherits coverage flags from company to pages", () => {
    const flagged = makeCompany({ domain: "flagged.co", name: "Flagged", coverage_flags: ["low_offpage_coverage"] });
    const page = makePage({ url: "https://flagged.co/page", company_domain: "flagged.co" });
    const result = joinCompanyToPages(flagged, [page]);
    expect(result.joined[0].coverage_flags).toContain("low_offpage_coverage");
  });
});

describe("joinAllCompaniesToPages", () => {
  it("joins multiple companies to their respective pages", () => {
    const result = joinAllCompaniesToPages(
      [ACME_COMPANY, COMPETITOR_COMPANY],
      [...ACME_PAGES, ...COMPETITOR_PAGES],
    );
    expect(result.joined.length).toBe(4);
    const acmeRows = result.joined.filter((r) => r.company_domain === "acme.com");
    const compRows = result.joined.filter((r) => r.company_domain === "competitor.com");
    expect(acmeRows.length).toBe(3);
    expect(compRows.length).toBe(1);
  });

  it("computes coverage_flags_summary across all companies", () => {
    const companies = [ACME_COMPANY, COMPETITOR_COMPANY];
    const allPages = [...ACME_PAGES, ...COMPETITOR_PAGES];
    const result = joinAllCompaniesToPages(companies, allPages);
    expect(typeof result.coverage_flags_summary).toBe("object");
  });
});

describe("normalizeDomain join integrity", () => {
  const baseDomains = ["acme.com", "competitor.com", "rival.io"];

  function rowsEqual(rows: InheritedPageRow[], expectedCount: number) {
    expect(rows.length).toBe(expectedCount);
    for (const r of rows) {
      expect(r.company_domain).toBe("acme.com");
      expect(r.company_name).toBe("Acme Analytics");
    }
  }

  it("joins www-prefixed pages to bare company domain", () => {
    const pages = [makePage({ url: "https://www.acme.com/pricing", company_domain: "www.acme.com" })];
    const result = joinCompanyToPages(ACME_COMPANY, pages);
    rowsEqual(result.joined, 1);
  });

  it("joins http pages to https-keyed company domain", () => {
    const pages = [makePage({ url: "http://acme.com/pricing", company_domain: "acme.com" })];
    const result = joinCompanyToPages(ACME_COMPANY, pages);
    rowsEqual(result.joined, 1);
  });

  it("joins uppercase domains to lowercased company domain", () => {
    const pages = [makePage({ url: "https://ACME.COM/pricing", company_domain: "ACME.COM" })];
    const result = joinCompanyToPages(ACME_COMPANY, pages);
    rowsEqual(result.joined, 1);
  });

  it("joins www + uppercase + http combinations", () => {
    const pages = [makePage({ url: "http://WWW.Acme.COM/pricing", company_domain: "WWW.ACME.COM" })];
    const result = joinCompanyToPages(ACME_COMPANY, pages);
    rowsEqual(result.joined, 1);
  });

  it("strips subdomains to match registrable domain", () => {
    const pages = [makePage({ url: "https://blog.acme.com/article", company_domain: "blog.acme.com" })];
    const result = joinCompanyToPages(ACME_COMPANY, pages);
    rowsEqual(result.joined, 1);
  });

  it("joins pages with trailing slash to domain without", () => {
    const pages = [makePage({ url: "https://acme.com/", company_domain: "acme.com" })];
    const result = joinCompanyToPages(ACME_COMPANY, pages);
    rowsEqual(result.joined, 1);
  });

  it("does NOT join different registrable domains", () => {
    const pages = [makePage({ url: "https://acme.co.uk/page", company_domain: "acme.co.uk" })];
    const result = joinCompanyToPages(ACME_COMPANY, pages);
    expect(result.joined.length).toBe(0);
    expect(result.orphan_pages.length).toBe(1);
  });

  it("reports all variant-domain pages as joined, not orphaned", () => {
    const pages = [
      makePage({ url: "https://acme.com/p1", company_domain: "acme.com" }),
      makePage({ url: "https://www.acme.com/p2", company_domain: "www.acme.com" }),
      makePage({ url: "http://acme.com/p3", company_domain: "acme.com" }),
      makePage({ url: "https://BLOG.ACME.COM/p4", company_domain: "BLOG.ACME.COM" }),
    ];
    const result = joinCompanyToPages(ACME_COMPANY, pages);
    expect(result.joined.length).toBe(4);
    expect(result.orphan_pages.length).toBe(0);
  });
});

describe("sameDomain utility", () => {
  it("returns true for matching pairs", () => {
    expect(sameDomain("https://www.acme.com", "acme.com")).toBe(true);
    expect(sameDomain("http://acme.com", "https://ACME.COM")).toBe(true);
    expect(sameDomain("blog.acme.com", "acme.com")).toBe(true);
  });

  it("returns false for different domains", () => {
    expect(sameDomain("acme.com", "competitor.com")).toBe(false);
    expect(sameDomain("acme.com", "acme.co.uk")).toBe(false);
  });
});

describe("computeCoverageFlags", () => {
  it("flags missing firmographics", () => {
    const company = makeCompany({ domain: "x.com", name: "X", firmographics: {} });
    const flags = computeCoverageFlags(company, []);
    expect(flags).toContain("missing_firmographics");
  });

  it("flags missing offpage signals", () => {
    const company = makeCompany({ domain: "x.com", name: "X", offpage: undefined });
    const flags = computeCoverageFlags(company, []);
    expect(flags).toContain("missing_offpage_signals");
  });

  it("flags low offpage coverage when most signals are zero", () => {
    const company = makeCompany({ domain: "x.com", name: "X", offpage: { thirdparty_mentions: 0, reddit_presence: 0, g2_presence: 0, brand_search_volume: 0 } });
    const flags = computeCoverageFlags(company, []);
    expect(flags).toContain("low_offpage_coverage");
  });

  it("does not flag low offpage coverage when signals are present", () => {
    const flags = computeCoverageFlags(ACME_COMPANY, []);
    expect(flags).not.toContain("low_offpage_coverage");
    expect(flags).not.toContain("missing_offpage_signals");
    expect(flags).not.toContain("missing_firmographics");
  });

  it("flags missing understanding", () => {
    const company = makeCompany({ domain: "x.com", name: "X", understanding: undefined });
    const flags = computeCoverageFlags(company, []);
    expect(flags).toContain("missing_understanding");
  });

  it("flags stale pages (freshness_days >= 180)", () => {
    const company = makeCompany({ domain: "x.com", name: "X" });
    const pages = [makePage({ url: "https://x.com/old", company_domain: "x.com", content_features: { schema_markup: false, comparison_table: false, word_count: 100, heading_structure: "h1:1", freshness_days: 200, query_term_coverage: 0.1, direct_answer_first: false, stats_density: "none", citation_density: "none", quote_density: "none", listicle_vs_prose: "prose" } })];
    const flags = computeCoverageFlags(company, pages);
    expect(flags.some((f) => f.startsWith("stale_pages:"))).toBe(true);
  });

  it("reports zeros for featureless pages", () => {
    const company = makeCompany({ domain: "x.com", name: "X" });
    const pages = [makePage({ url: "https://x.com/bare", company_domain: "x.com", content_features: { schema_markup: false, comparison_table: false, word_count: 0, heading_structure: "h1:0", freshness_days: null, query_term_coverage: null, direct_answer_first: false, stats_density: "none", citation_density: "none", quote_density: "none", listicle_vs_prose: "prose" } })];
    const flags = computeCoverageFlags(company, pages);
    expect(flags.some((f) => f.startsWith("featureless_pages:"))).toBe(true);
  });

  it("computes page-level flags for individual rows", () => {
    const company = makeCompany({ domain: "bare.co", name: "Bare", firmographics: {}, offpage: undefined, understanding: undefined, coverage_flags: [] });
    const page = makePage({ url: "https://bare.co/empty", company_domain: "bare.co", content_features: { schema_markup: false, comparison_table: false, word_count: 0, heading_structure: "h1:0", freshness_days: null, query_term_coverage: null, direct_answer_first: false, stats_density: "none", citation_density: "none", quote_density: "none", listicle_vs_prose: "prose" } });
    const result = joinCompanyToPages(company, [page]);
    expect(result.joined[0].coverage_flags).toContain("zero_word_count");
  });

  it("does NOT drop low-coverage rows — flags them instead", () => {
    const company = makeCompany({ domain: "low.co", name: "Low", offpage: undefined, understanding: undefined, firmographics: {}, coverage_flags: ["low_offpage_coverage"] });
    const page = makePage({ url: "https://low.co/page", company_domain: "low.co" });
    const result = joinCompanyToPages(company, [page]);
    expect(result.joined.length).toBe(1);
    expect(result.joined[0].coverage_flags.length).toBeGreaterThanOrEqual(1);
  });
});
