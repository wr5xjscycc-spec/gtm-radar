// P3 · Phase 4 task #1 required test: join-integrity tests.
//
// Proves company-level context (the DOMINANT off-page/firmographics/understanding
// signals) inherits to EVERY page joined on the normalized domain, and that a
// www/subdomain join MISS is SURFACED as an orphan — never a silent drop. Losing
// off-page signals via a bad join is the worst failure in this lane (ORCHESTRATION §6),
// so the join is audited rather than trusted.

import { describe, it, expect } from "vitest";

import {
  joinPagesToCompanies,
  inheritedContext,
  JOIN_VERSION,
} from "../src/join";
import { normalizeDomain } from "../src/domain";
import type { Company, Page, OffPage, Firmographics, Understanding } from "../src/types";

// ── inline builders ──────────────────────────────────────────────────────────

function makeCompany(overrides: Partial<Company> = {}): Company {
  return {
    domain: "example.com",
    name: "Example",
    role: "battlefield",
    firmographics: { size: "201-500", funding_stage: "Series B" },
    offpage: { thirdparty_mentions: 42, g2_presence: 1, brand_search_volume: 9000 },
    understanding: { category: "PM tool", icp: "mid-market", positioning: "fast" },
    coverage_flags: [
      "firmographics_missing",
      "offpage_missing",
      "understanding_missing",
    ],
    source_versions: { battlefield: "fiber/find-similar-companies@v1" },
    ...overrides,
  };
}

function makePage(overrides: Partial<Page> = {}): Page {
  return {
    company_domain: "example.com",
    url: "https://example.com/blog/post",
    role: "candidate",
    content_features: {
      schema_markup: false,
      comparison_table: false,
      word_count: 800,
      heading_structure: 6, // h1=1 + h2=3 + h3=2
      freshness_days: 10,
      query_term_coverage: 0.5,
    },
    extractor_version: "extractor@v1",
    scraped_at: Date.parse("2026-06-27T00:00:00.000Z"),
    cache_key: "example.com|hash|extractor@v1",
    ...overrides,
  };
}

describe("join-integrity — version", () => {
  it("exposes a stable join version stamp", () => {
    expect(JOIN_VERSION).toBe("join/normalized-domain@v1");
  });
});

describe("join-integrity — inheritance (EVERY page inherits company context)", () => {
  it("two pages of one company BOTH carry its offpage + firmographics + understanding", () => {
    const offpage: OffPage = { thirdparty_mentions: 1234, g2_presence: 1, backlink_density: 0.7 };
    const firmographics: Firmographics = { size: "1000+", tech_stack: ["React", "AWS"] };
    const understanding: Understanding = { category: "CRM", positioning: "enterprise" };
    const company = makeCompany({ offpage, firmographics, understanding });

    const pageA = makePage({ url: "https://example.com/a" });
    const pageB = makePage({ url: "https://example.com/b" });

    const { joined } = joinPagesToCompanies([company], [pageA, pageB]);
    expect(joined).toHaveLength(2);

    for (const jp of joined) {
      expect(jp.company_found).toBe(true);
      // The DOMINANT signal must reach every page (this is the whole point).
      expect(jp.offpage).toEqual(offpage);
      expect(jp.firmographics).toEqual(firmographics);
      expect(jp.understanding).toEqual(understanding);
      expect(jp.company_coverage_flags).toEqual(company.coverage_flags);
    }

    // Per-row COPIES (not shared refs): equal by value, but mutating one page's
    // inherited context must not corrupt a sibling or the source company.
    expect(joined[0].offpage).toEqual(joined[1].offpage);
    expect(joined[0].offpage).not.toBe(joined[1].offpage);
    expect(joined[0].offpage).not.toBe(company.offpage);
    joined[0].offpage!.thirdparty_mentions = 999;
    expect(joined[1].offpage!.thirdparty_mentions).toBe(1234);
    expect(company.offpage!.thirdparty_mentions).toBe(1234);
  });

  it("inheritedContext returns exactly the small company-level subset", () => {
    const company = makeCompany();
    expect(inheritedContext(company)).toEqual({
      firmographics: company.firmographics,
      offpage: company.offpage,
      understanding: company.understanding,
      company_coverage_flags: company.coverage_flags,
    });
  });
});

describe("join-integrity — domain mismatch is SURFACED, never dropped", () => {
  it("asana.com page orphans against monday.com company but is STILL emitted", () => {
    // normalizeDomain strips ALL subdomains (eTLD+1), so different registrable
    // domains do NOT match — the orphan is correctly surfaced.
    expect(normalizeDomain("monday.com")).toBe("monday.com");
    expect(normalizeDomain("asana.com")).toBe("asana.com");

    const company = makeCompany({ domain: "monday.com" });
    const page = makePage({
      company_domain: "asana.com",
      url: "https://asana.com/post",
    });

    const { joined, report } = joinPagesToCompanies([company], [page]);

    // Not silently dropped — the page is still in the output.
    expect(joined).toHaveLength(1);
    expect(joined[0].company_found).toBe(false);
    // No off-page signal was (falsely) inherited.
    expect(joined[0].offpage).toBeUndefined();
    expect(joined[0].firmographics).toBeUndefined();
    expect(joined[0].understanding).toBeUndefined();

    // Surfaced as an orphan for P1 visibility.
    expect(report.orphan_pages).toEqual([
      { url: "https://asana.com/post", company_domain: "asana.com" },
    ]);
    expect(report.joined).toBe(0);
    // And the company that lost all its pages is flagged childless.
    expect(report.childless_companies).toEqual(["monday.com"]);
  });

  it("www IS normalized on both sides — does NOT cause a false orphan", () => {
    const company = makeCompany({ domain: "example.com" });
    const page = makePage({ company_domain: "www.example.com" });

    const { joined, report } = joinPagesToCompanies([company], [page]);

    expect(joined[0].company_found).toBe(true);
    expect(joined[0].company_domain).toBe("example.com");
    expect(joined[0].offpage).toEqual(company.offpage);
    expect(report.orphan_pages).toHaveLength(0);
    expect(report.childless_companies).toHaveLength(0);
    expect(report.joined).toBe(1);
  });

  it("a non-normalized company key is still matched (defensive re-normalization)", () => {
    // Even if a producer slipped a www-prefixed company domain through, the audit
    // re-normalizes both sides so the page still finds its company.
    const company = makeCompany({ domain: "WWW.Example.com/" });
    const page = makePage({ company_domain: "https://example.com/x" });

    const { joined, report } = joinPagesToCompanies([company], [page]);
    expect(joined[0].company_found).toBe(true);
    expect(joined[0].company_domain).toBe("example.com");
    expect(report.joined).toBe(1);
  });
});

describe("join-integrity — childless companies & orphan pages", () => {
  it("a company with no pages appears in childless_companies", () => {
    const withPages = makeCompany({ domain: "covered.com" });
    const childless = makeCompany({ domain: "lonely.com" });
    const page = makePage({ company_domain: "covered.com" });

    const { report } = joinPagesToCompanies([withPages, childless], [page]);
    expect(report.childless_companies).toEqual(["lonely.com"]);
  });

  it("childless_companies is sorted and deduped", () => {
    const companies = [
      makeCompany({ domain: "zebra.com" }),
      makeCompany({ domain: "alpha.com" }),
      makeCompany({ domain: "mid.com" }),
    ];
    const { report } = joinPagesToCompanies(companies, []);
    expect(report.childless_companies).toEqual(["alpha.com", "mid.com", "zebra.com"]);
  });

  it("a page with no company appears in orphan_pages", () => {
    const company = makeCompany({ domain: "example.com" });
    const page = makePage({ company_domain: "unknown.com", url: "https://unknown.com/p" });

    const { joined, report } = joinPagesToCompanies([company], [page]);
    expect(joined[0].company_found).toBe(false);
    expect(report.orphan_pages).toEqual([
      { url: "https://unknown.com/p", company_domain: "unknown.com" },
    ]);
  });
});

describe("join-integrity — no page is ever dropped", () => {
  it("joined array length == input pages length; report.joined counts only matches", () => {
    const company = makeCompany({ domain: "example.com" });
    const pages = [
      makePage({ company_domain: "example.com", url: "u1" }),
      makePage({ company_domain: "example.com", url: "u2" }),
      makePage({ company_domain: "orphan.com", url: "u3" }),
      makePage({ company_domain: "different.com", url: "u4" }),
    ];

    const { joined, report } = joinPagesToCompanies([company], pages);

    // Every input page survives — coverage honesty.
    expect(joined).toHaveLength(pages.length);
    // Only the two true matches are counted as joined.
    expect(report.joined).toBe(2);
    expect(report.orphan_pages).toHaveLength(2);
    expect(joined.filter((j) => j.company_found)).toHaveLength(2);
  });

  it("handles empty inputs without error", () => {
    const { joined, report } = joinPagesToCompanies([], []);
    expect(joined).toEqual([]);
    expect(report).toEqual({
      joined: 0,
      orphan_pages: [],
      childless_companies: [],
      duplicate_domains: [],
      unjoinable_companies: [],
    });
  });
});

describe("join-integrity — resilience (never crash)", () => {
  it("a page with an unparseable company_domain becomes an orphan without throwing", () => {
    const company = makeCompany({ domain: "example.com" });
    const badPage = makePage({ company_domain: "   ", url: "https://example.com/bad" });

    let result!: ReturnType<typeof joinPagesToCompanies>;
    expect(() => {
      result = joinPagesToCompanies([company], [badPage]);
    }).not.toThrow();

    expect(result.joined).toHaveLength(1);
    expect(result.joined[0].company_found).toBe(false);
    // Orphan recorded with the ORIGINAL (un-normalizable) domain value.
    expect(result.report.orphan_pages).toEqual([
      { url: "https://example.com/bad", company_domain: "   " },
    ]);
    expect(result.report.joined).toBe(0);
  });

  it("a company with an unparseable domain is SURFACED in unjoinable_companies (not silently dropped)", () => {
    const badCompany = makeCompany({ domain: "   " });
    const goodCompany = makeCompany({ domain: "good.com" });
    const page = makePage({ company_domain: "good.com" });

    let result!: ReturnType<typeof joinPagesToCompanies>;
    expect(() => {
      result = joinPagesToCompanies([badCompany, goodCompany], [page]);
    }).not.toThrow();

    expect(result.joined[0].company_found).toBe(true);
    // It can't be indexed/childless, but it must NOT vanish — surfaced as unjoinable.
    expect(result.report.unjoinable_companies).toEqual(["   "]);
    expect(result.report.childless_companies).toEqual([]);
  });

  it("a company-key COLLISION keeps the first and surfaces the loser (no wrong-company off-page)", () => {
    // Two companies normalize to the same key. Silently overwriting would make
    // this domain's pages inherit the WRONG company's dominant off-page signal.
    const first = makeCompany({ domain: "example.com", name: "First", offpage: { thirdparty_mentions: 1 } });
    const second = makeCompany({ domain: "www.example.com", name: "Second", offpage: { thirdparty_mentions: 999 } });
    const page = makePage({ company_domain: "example.com" });

    const { joined, report } = joinPagesToCompanies([first, second], [page]);

    // First wins — the page inherits First's off-page, never Second's.
    expect(joined[0].company_found).toBe(true);
    expect(joined[0].offpage!.thirdparty_mentions).toBe(1);
    // The loser is surfaced (normalized key), not silently dropped.
    expect(report.duplicate_domains).toEqual(["example.com"]);
  });

  it("clean inputs report empty audit arrays", () => {
    const { report } = joinPagesToCompanies([makeCompany()], [makePage()]);
    expect(report.duplicate_domains).toEqual([]);
    expect(report.unjoinable_companies).toEqual([]);
  });
});
