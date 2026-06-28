import { describe, it, expect } from "vitest";
import { generateCoverageQAReport } from "../src/coverageQA";
import { buildVerticalPack } from "../src/verticalPack";
import type { Company } from "../src/fiber";
import type { PageRecord } from "../src/content";

const PACK = buildVerticalPack();

function makeCompany(overrides: Partial<Company> & { domain: string; name: string }): Company {
  return {
    role: "competitor",
    firmographics: { size: "51-200" },
    offpage: { reddit_presence: 5 },
    understanding: { category: "GTM analytics", icp: "B2B SaaS", positioning: "Leader", what_you_are: "Test" },
    coverage_flags: [],
    ...overrides,
  };
}

function makePage(overrides: Partial<PageRecord> & { url: string; company_domain: string }): PageRecord {
  return {
    role: "competitor",
    content_features: {
      schema_markup: true,
      comparison_table: false,
      word_count: 500,
      heading_structure: "h1:1 h2:3",
      freshness_days: 30,
      query_term_coverage: 0.5,
      direct_answer_first: true,
      stats_density: "medium",
      citation_density: "low",
      quote_density: "none",
      listicle_vs_prose: "prose",
    },
    extractor_version: "extractor-2026.06-v3",
    scraped_at: new Date().toISOString(),
    cache_key: "test",
    ...overrides,
  };
}

describe("generateCoverageQAReport", () => {
  it("produces a well-shaped report with no flags for ideal data", () => {
    const companies: Company[] = [
      makeCompany({ domain: "acme.com", name: "Acme" }),
    ];
    const pages: PageRecord[] = [
      makePage({ url: "https://acme.com/pricing", company_domain: "acme.com" }),
    ];

    const report = generateCoverageQAReport(PACK, companies, pages);

    expect(report.vertical).toBe("GTM analytics");
    expect(report.pack_queries_total).toBeGreaterThan(0);
    expect(report.companies_total).toBe(1);
    expect(report.pages_total).toBe(1);
    expect(report.low_coverage_items).toEqual([]);
    expect(report.flags).toEqual([]);
  });

  it("flags missing firmographics as low coverage", () => {
    const companies: Company[] = [
      makeCompany({ domain: "acme.com", name: "Acme", firmographics: {} }),
    ];
    const pages: PageRecord[] = [
      makePage({ url: "https://acme.com/pricing", company_domain: "acme.com" }),
    ];

    const report = generateCoverageQAReport(PACK, companies, pages);
    const missingFirmo = report.low_coverage_items.filter(
      (i) => i.type === "missing_firmographics"
    );
    expect(missingFirmo.length).toBe(1);
    expect(missingFirmo[0].company_name).toBe("Acme");
    expect(report.flags).toContain("low_coverage_items:1");
  });

  it("flags missing offpage as low coverage", () => {
    const companies: Company[] = [
      makeCompany({ domain: "acme.com", name: "Acme", offpage: undefined }),
    ];
    const pages: PageRecord[] = [
      makePage({ url: "https://acme.com/pricing", company_domain: "acme.com" }),
    ];

    const report = generateCoverageQAReport(PACK, companies, pages);
    const missing = report.low_coverage_items.filter(
      (i) => i.type === "missing_offpage"
    );
    expect(missing.length).toBe(1);
  });

  it("flags missing understanding as low coverage", () => {
    const companies: Company[] = [
      makeCompany({ domain: "acme.com", name: "Acme", understanding: undefined }),
    ];
    const pages: PageRecord[] = [
      makePage({ url: "https://acme.com/pricing", company_domain: "acme.com" }),
    ];

    const report = generateCoverageQAReport(PACK, companies, pages);
    const missing = report.low_coverage_items.filter(
      (i) => i.type === "missing_understanding"
    );
    expect(missing.length).toBe(1);
  });

  it("flags stale pages as low coverage", () => {
    const companies: Company[] = [
      makeCompany({ domain: "staleco.com", name: "StaleCo" }),
    ];
    const pages: PageRecord[] = [
      makePage({
        url: "https://staleco.com/old",
        company_domain: "staleco.com",
        content_features: {
          schema_markup: true,
          comparison_table: false,
          word_count: 100,
          heading_structure: "h1:1",
          freshness_days: 200,
          query_term_coverage: null,
          direct_answer_first: false,
          stats_density: "none",
          citation_density: "none",
          quote_density: "none",
          listicle_vs_prose: "prose",
        },
      }),
    ];

    const report = generateCoverageQAReport(PACK, companies, pages);
    const stale = report.low_coverage_items.filter(
      (i) => i.type === "stale_page"
    );
    expect(stale.length).toBe(1);
    expect(stale[0].reason).toContain("200 days");
  });

  it("flags featureless pages as low coverage", () => {
    const companies: Company[] = [
      makeCompany({ domain: "emptyco.com", name: "EmptyCo" }),
    ];
    const pages: PageRecord[] = [
      makePage({
        url: "https://emptyco.com/page",
        company_domain: "emptyco.com",
        content_features: {
          schema_markup: false,
          comparison_table: false,
          word_count: 0,
          heading_structure: "none",
          freshness_days: null,
          query_term_coverage: null,
          direct_answer_first: false,
          stats_density: "none",
          citation_density: "none",
          quote_density: "none",
          listicle_vs_prose: "prose",
        },
      }),
    ];

    const report = generateCoverageQAReport(PACK, companies, pages);
    const featureless = report.low_coverage_items.filter(
      (i) => i.type === "featureless_page"
    );
    expect(featureless.length).toBe(1);
  });

  it("flags orphan pages whose company domain is not in company records", () => {
    const companies: Company[] = [
      makeCompany({ domain: "acme.com", name: "Acme" }),
    ];
    const pages: PageRecord[] = [
      makePage({ url: "https://orphan.com/page", company_domain: "orphan.com" }),
    ];

    const report = generateCoverageQAReport(PACK, companies, pages);
    const orphans = report.low_coverage_items.filter(
      (i) => i.type === "orphan_page"
    );
    expect(orphans.length).toBe(1);
    expect(orphans[0].company_domain).toBe("orphan.com");
  });

  it("reports llm_expand_ratio from the pack", () => {
    const companies: Company[] = [];
    const pages: PageRecord[] = [];

    const report = generateCoverageQAReport(PACK, companies, pages);
    expect(report.pack_llm_expand_ratio).toBe(PACK.llm_expand_ratio);
    expect(report.pack_llm_expand_ratio).toBeGreaterThan(0);
    expect(report.pack_llm_expand_ratio).toBeLessThan(0.5);
  });

  it("reports seed_source breakdown in coverage_by_source", () => {
    const companies: Company[] = [];
    const pages: PageRecord[] = [];

    const report = generateCoverageQAReport(PACK, companies, pages);
    expect(report.coverage_by_source.llm_expand).toBe(PACK.llm_expand_query_count);
    expect(report.coverage_by_source.grounded).toBe(PACK.grounded_query_count);
    expect(report.coverage_by_source.paa).toBeGreaterThanOrEqual(0);
    expect(report.coverage_by_source.keyword).toBeGreaterThanOrEqual(0);
    expect(report.coverage_by_source.reddit).toBeGreaterThanOrEqual(0);
    expect(report.coverage_by_source.analytics).toBeGreaterThanOrEqual(0);
  });

  it("flags no enrichment when companies and pages are empty", () => {
    const report = generateCoverageQAReport(PACK, [], []);
    expect(report.flags).toContain("no_companies_in_enrichment");
    expect(report.flags).toContain("no_pages_in_enrichment");
  });

  it("multiple low-coverage items produce a single low_coverage_items flag", () => {
    const companies: Company[] = [
      makeCompany({ domain: "a.com", name: "A", offpage: undefined }),
      makeCompany({ domain: "b.com", name: "B", firmographics: {} }),
    ];
    const pages: PageRecord[] = [];

    const report = generateCoverageQAReport(PACK, companies, pages);
    const lowFlag = report.flags.find((f) => f.startsWith("low_coverage_items"));
    expect(lowFlag).toBeTruthy();
    const count = parseInt(lowFlag!.split(":")[1], 10);
    expect(count).toBeGreaterThanOrEqual(2);
  });
});
