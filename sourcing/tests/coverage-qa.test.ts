// P3 · Phase 6 task #2 required test: coverage-QA assertions — low-coverage
// surfaced, not dropped.
//
// Proves the launch-vertical transparency contract:
//  - the sweep accounts for EVERY company + page (nothing silently dropped) → passed,
//  - low-coverage entities are FLAGGED and SURFACED for P1's UI, but still PRESENT,
//  - company coverage_flags are RECONCILED toward the actual data,
//  - the threshold override is honored (stricter → surfaces more),
//  - coverageGaps lists the missing families honestly,
//  - empty inputs pass with no surfaced gaps and no crash.
// No network, no LLM — pure functions over inline contract-shaped objects.

import { describe, it, expect } from "vitest";

import { sweepVerticalCoverage, coverageGaps } from "../src/coverage-qa";
import { DEFAULT_COVERAGE_THRESHOLD } from "../src/coverage";
import type { Company, Page, ContentFeatures } from "../src/types";

// ─────────────────────────────────────────────────────────────────────────────
// Inline contract-shaped builders.
// ─────────────────────────────────────────────────────────────────────────────

/** Fully-enriched company — all three families carry real data. */
function fullCompany(overrides: Partial<Company> = {}): Company {
  return {
    domain: "asana.com",
    name: "Asana",
    role: "battlefield",
    firmographics: { size: "201-500", tech_stack: ["React"] },
    offpage: { thirdparty_mentions: 12, reddit_presence: 0 },
    understanding: { category: "work management", icp: "teams", positioning: "..." },
    coverage_flags: {
      firmographics_missing: false,
      offpage_missing: false,
      understanding_missing: false,
    },
    source_versions: { battlefield: "fiber/find-similar-companies@v1" },
    ...overrides,
  };
}

const fullDeterministic: ContentFeatures = {
  schema_markup: true,
  comparison_table: false,
  word_count: 1200,
  heading_structure: { h1: 1, h2: 4, h3: 6 },
  freshness_days: null,
  query_term_coverage: 0.8,
  direct_answer_first: true,
  stats_density: 3.1,
  citation_density: 1.2,
  quote_density: 0.4,
  listicle_vs_prose: "mixed",
};

function makePage(content: ContentFeatures, overrides: Partial<Page> = {}): Page {
  return {
    company_domain: "asana.com",
    url: "https://asana.com/product",
    role: "candidate",
    content_features: content,
    extractor_version: "extractor@v1",
    scraped_at: "2026-01-01T00:00:00.000Z",
    cache_key: "asana.com|hash|extractor@v1",
    ...overrides,
  };
}

// A vertical mixing fully-enriched and low-coverage entities.
function mixedVertical(): { companies: Company[]; pages: Page[] } {
  const companies: Company[] = [
    fullCompany({ domain: "asana.com" }),
    // low coverage: nothing enriched at all → score 0.
    fullCompany({
      domain: "ghost.com",
      firmographics: undefined,
      offpage: undefined,
      understanding: undefined,
    }),
  ];
  const pages: Page[] = [
    makePage(fullDeterministic, { url: "https://asana.com/a" }),
    // low coverage: empty content_features → both families missing.
    makePage({} as ContentFeatures, {
      url: "https://ghost.com/x",
      company_domain: "ghost.com",
    }),
  ];
  return { companies, pages };
}

// ─────────────────────────────────────────────────────────────────────────────
// sweepVerticalCoverage — anti-silent-drop + surfacing.
// ─────────────────────────────────────────────────────────────────────────────

describe("sweepVerticalCoverage — low-coverage surfaced, not dropped", () => {
  it("accounts for EVERY entity (counts equal inputs) and passes — nothing dropped", () => {
    const { companies, pages } = mixedVertical();
    const qa = sweepVerticalCoverage({ vertical: "fintech", companies, pages });

    expect(qa.vertical).toBe("fintech");
    expect(qa.report.companies).toHaveLength(companies.length);
    expect(qa.report.pages).toHaveLength(pages.length);
    // passed = transparency assertion, NOT "no gaps". Gaps exist but are surfaced.
    expect(qa.passed).toBe(true);
    expect(qa.report.low_coverage_count).toBeGreaterThan(0);
  });

  it("THE KEY ASSERTION: the low-coverage entity is SURFACED and still PRESENT", () => {
    const { companies, pages } = mixedVertical();
    const qa = sweepVerticalCoverage({ vertical: "fintech", companies, pages });

    const surfacedKeys = qa.surfaced_low_coverage.map((a) => a.key);
    // The sparse company + sparse page are SURFACED (made visible), not absent.
    expect(surfacedKeys).toContain("ghost.com");
    expect(surfacedKeys).toContain("https://ghost.com/x");

    // ...AND they are still present in the full report (never dropped to look complete).
    expect(qa.report.companies.map((a) => a.key)).toContain("ghost.com");
    expect(qa.report.pages.map((a) => a.key)).toContain("https://ghost.com/x");

    // The fully-enriched ones are NOT surfaced (they have no gaps to show).
    expect(surfacedKeys).not.toContain("asana.com");
    expect(surfacedKeys).not.toContain("https://asana.com/a");
  });

  it("RECONCILES company flags toward reality (stored flag disagrees with data)", () => {
    // coverage_flags LIE (firmographics_missing:false) but firmographics is empty.
    const liar = fullCompany({
      domain: "liar.com",
      firmographics: undefined,
      coverage_flags: {
        firmographics_missing: false, // stale / wrong
        offpage_missing: false,
        understanding_missing: false,
      },
    });
    const qa = sweepVerticalCoverage({
      vertical: "fintech",
      companies: [liar],
      pages: [],
    });

    const flags = qa.reconciled_flags.find((f) => f.domain === "liar.com");
    expect(flags).toBeDefined();
    // corrected toward the DATA, not the stale persisted flag.
    expect(flags!.coverage_flags.firmographics_missing).toBe(true);
    expect(flags!.coverage_flags.offpage_missing).toBe(false);
    expect(flags!.coverage_flags.understanding_missing).toBe(false);
  });

  it("threshold override is honored — a stricter threshold surfaces MORE entities", () => {
    const { companies, pages } = mixedVertical();

    const lenient = sweepVerticalCoverage({
      vertical: "fintech",
      companies,
      pages,
      threshold: DEFAULT_COVERAGE_THRESHOLD,
    });
    const strict = sweepVerticalCoverage({
      vertical: "fintech",
      companies,
      pages,
      threshold: 1, // every below-perfect entity becomes low-coverage
    });

    expect(strict.report.threshold).toBe(1);
    expect(strict.surfaced_low_coverage.length).toBeGreaterThanOrEqual(
      lenient.surfaced_low_coverage.length,
    );
    // Both still account for everything — surfacing more, dropping nothing.
    expect(strict.passed).toBe(true);
    expect(strict.report.companies).toHaveLength(companies.length);
    expect(strict.report.pages).toHaveLength(pages.length);
  });

  it("empty inputs → passed true, no surfaced gaps, no crash", () => {
    const qa = sweepVerticalCoverage({ vertical: "fintech", companies: [], pages: [] });
    expect(qa.passed).toBe(true);
    expect(qa.surfaced_low_coverage).toEqual([]);
    expect(qa.reconciled_flags).toEqual([]);
    expect(qa.report.low_coverage_count).toBe(0);
    expect(coverageGaps(qa)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// coverageGaps — honest human-readable summary.
// ─────────────────────────────────────────────────────────────────────────────

describe("coverageGaps", () => {
  it("lists the missing families for each surfaced low-coverage entity", () => {
    // company missing offpage + understanding (firmographics present).
    const partial = fullCompany({
      domain: "competitor.com",
      offpage: undefined,
      understanding: undefined,
    });
    const qa = sweepVerticalCoverage({
      vertical: "fintech",
      companies: [partial],
      pages: [],
    });

    const gaps = coverageGaps(qa);
    expect(gaps).toHaveLength(1);
    const line = gaps[0];
    expect(line).toContain("competitor.com");
    expect(line).toContain("offpage");
    expect(line).toContain("understanding");
    // firmographics is present → must NOT be named as a gap.
    expect(line).not.toContain("firmographics");
  });

  it("names a page's missing vectors honestly", () => {
    const qa = sweepVerticalCoverage({
      vertical: "fintech",
      companies: [],
      pages: [
        makePage({} as ContentFeatures, {
          url: "https://ghost.com/x",
          company_domain: "ghost.com",
        }),
      ],
    });
    const gaps = coverageGaps(qa);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain("https://ghost.com/x");
    expect(gaps[0]).toContain("deterministic_features");
    expect(gaps[0]).toContain("subjective_features");
  });
});
