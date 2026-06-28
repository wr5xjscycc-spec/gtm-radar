// P3 · Phase 4 task #2 required test: coverage-flag tests.
//
// Proves the measurement-layer transparency contract:
//  - company/page coverage is computed from ACTUAL data presence,
//  - persisted coverage_flags are RECONCILED toward the data (a stale/wrong flag is
//    corrected, never propagated),
//  - and the anti-silent-drop guarantee: every entity is PRESENT in the report,
//    low-coverage ones merely flagged (ORCHESTRATION §6 red-team transparency).
// No network, no LLM — pure functions over inline contract-shaped objects.

import { describe, it, expect } from "vitest";

import {
  COMPANY_FEATURE_FAMILIES,
  PAGE_FEATURE_FAMILIES,
  DEFAULT_COVERAGE_THRESHOLD,
  assessCompanyCoverage,
  assessPageCoverage,
  buildCoverageReport,
  reconcileCompanyFlags,
} from "../src/coverage";
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
  freshness_days: null, // null is a value, not a gap — must NOT count as missing
  query_term_coverage: 0.8,
  // subjective vector:
  direct_answer_first: true,
  stats_density: 3.1,
  citation_density: 1.2,
  quote_density: 0.4,
  listicle_vs_prose: "mixed",
};

/** Page carrying whatever content_features are passed (deterministic+subjective by default). */
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

// ─────────────────────────────────────────────────────────────────────────────
// assessCompanyCoverage
// ─────────────────────────────────────────────────────────────────────────────

describe("assessCompanyCoverage", () => {
  it("fully-enriched company → missing:[], score 1, not low_coverage", () => {
    const a = assessCompanyCoverage(fullCompany());
    expect(a.kind).toBe("company");
    expect(a.key).toBe("asana.com");
    expect(a.missing).toEqual([]);
    expect(a.coverage_score).toBe(1);
    expect(a.low_coverage).toBe(false);
  });

  it("company missing offpage + understanding → both listed, score 1/3, low_coverage", () => {
    const company = fullCompany({ offpage: undefined, understanding: undefined });
    const a = assessCompanyCoverage(company);
    expect(a.missing.sort()).toEqual(["offpage", "understanding"]);
    expect(a.coverage_score).toBeCloseTo(1 / 3, 10);
    expect(a.low_coverage).toBe(true);
  });

  it("RECONCILES with reality: a flag claiming present but data empty → assessed missing", () => {
    // coverage_flags LIES (firmographics_missing:false) but firmographics is empty.
    // We trust the DATA, not the flag → firmographics is reported missing.
    const liar = fullCompany({
      firmographics: {}, // no real fields
      coverage_flags: {
        firmographics_missing: false, // stale/incorrect
        offpage_missing: false,
        understanding_missing: false,
      },
    });
    const a = assessCompanyCoverage(liar);
    expect(a.missing).toContain("firmographics");
    expect(a.coverage_score).toBeCloseTo(2 / 3, 10);
  });

  it("blank-string firmographics do not count as present (non-blank required)", () => {
    const blank = fullCompany({ firmographics: { size: "  ", tech_stack: [] } });
    const a = assessCompanyCoverage(blank);
    expect(a.missing).toContain("firmographics");
  });

  it("a measured 0 off-page reading still counts as present (0 is a real datum)", () => {
    const zero = fullCompany({ offpage: { reddit_presence: 0 } });
    const a = assessCompanyCoverage(zero);
    expect(a.missing).not.toContain("offpage");
  });

  it("threshold override is honored", () => {
    // 2/3 ≈ 0.667 present. Default 0.5 → not low; strict threshold 0.7 → low.
    const company = fullCompany({ understanding: undefined });
    expect(assessCompanyCoverage(company).low_coverage).toBe(false);
    expect(assessCompanyCoverage(company, 0.7).low_coverage).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// reconcileCompanyFlags
// ─────────────────────────────────────────────────────────────────────────────

describe("reconcileCompanyFlags", () => {
  it("returns flags matching ACTUAL presence", () => {
    const flags = reconcileCompanyFlags(fullCompany());
    expect(flags).toEqual({
      firmographics_missing: false,
      offpage_missing: false,
      understanding_missing: false,
    });
  });

  it("corrects a stale flag toward the data (flag says present, data empty)", () => {
    const liar = fullCompany({
      firmographics: undefined,
      coverage_flags: {
        firmographics_missing: false, // wrong
        offpage_missing: false,
        understanding_missing: false,
      },
    });
    const flags = reconcileCompanyFlags(liar);
    expect(flags.firmographics_missing).toBe(true); // corrected
    expect(flags.offpage_missing).toBe(false);
    expect(flags.understanding_missing).toBe(false);
  });

  it("does NOT mutate the input company", () => {
    const company = fullCompany({ firmographics: undefined });
    const snapshot = structuredClone(company);
    reconcileCompanyFlags(company);
    expect(company).toEqual(snapshot);
    // original (incorrect) persisted flag is untouched on the input
    expect(company.coverage_flags.firmographics_missing).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// assessPageCoverage
// ─────────────────────────────────────────────────────────────────────────────

describe("assessPageCoverage", () => {
  it("full deterministic + subjective → missing:[], score 1, not low_coverage", () => {
    const a = assessPageCoverage(makePage(fullDeterministic));
    expect(a.kind).toBe("page");
    expect(a.key).toBe("https://asana.com/product");
    expect(a.missing).toEqual([]);
    expect(a.coverage_score).toBe(1);
    expect(a.low_coverage).toBe(false);
  });

  it("deterministic-only page (no subjective) → 'subjective_features' missing, score 1/2", () => {
    const detOnly: ContentFeatures = {
      schema_markup: false,
      comparison_table: true,
      word_count: 500,
      heading_structure: { h1: 1, h2: 0, h3: 0 },
      freshness_days: 10,
      query_term_coverage: 0.5,
      // no subjective fields
    };
    const a = assessPageCoverage(makePage(detOnly));
    expect(a.missing).toEqual(["subjective_features"]);
    expect(a.coverage_score).toBe(0.5);
    // low_coverage follows the threshold: 0.5 is NOT strictly below 0.5
    expect(a.low_coverage).toBe(0.5 < DEFAULT_COVERAGE_THRESHOLD);
    expect(a.low_coverage).toBe(false);
    // but a stricter threshold flags it
    expect(assessPageCoverage(makePage(detOnly), 0.6).low_coverage).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildCoverageReport — the anti-silent-drop guarantee
// ─────────────────────────────────────────────────────────────────────────────

describe("buildCoverageReport", () => {
  const companies: Company[] = [
    fullCompany({ domain: "asana.com" }),
    // low coverage: nothing enriched
    fullCompany({
      domain: "ghost.com",
      firmographics: undefined,
      offpage: undefined,
      understanding: undefined,
    }),
  ];
  const pages: Page[] = [
    makePage(fullDeterministic, { url: "https://asana.com/a" }),
    // low coverage: empty content_features object → both families missing
    makePage({} as ContentFeatures, { url: "https://ghost.com/x" }),
  ];

  it("includes EVERY company and page — low-coverage rows are NOT dropped", () => {
    const report = buildCoverageReport(companies, pages);
    expect(report.companies).toHaveLength(companies.length);
    expect(report.pages).toHaveLength(pages.length);
  });

  it("the low-coverage entity is FLAGGED but still PRESENT (anti-silent-drop)", () => {
    const report = buildCoverageReport(companies, pages);

    const ghostCompany = report.companies.find((a) => a.key === "ghost.com");
    expect(ghostCompany).toBeDefined();
    expect(ghostCompany!.low_coverage).toBe(true);
    expect(ghostCompany!.coverage_score).toBe(0);
    expect(ghostCompany!.missing.sort()).toEqual([...COMPANY_FEATURE_FAMILIES].sort());

    const ghostPage = report.pages.find((a) => a.key === "https://ghost.com/x");
    expect(ghostPage).toBeDefined();
    expect(ghostPage!.low_coverage).toBe(true);
    expect(ghostPage!.missing.sort()).toEqual([...PAGE_FEATURE_FAMILIES].sort());
  });

  it("low_coverage_count counts flagged companies + pages; threshold echoed", () => {
    const report = buildCoverageReport(companies, pages);
    expect(report.threshold).toBe(DEFAULT_COVERAGE_THRESHOLD);
    // ghost.com (company) + ghost page = 2 flagged; asana rows fully covered.
    expect(report.low_coverage_count).toBe(2);
  });

  it("threshold override is honored and echoed", () => {
    // At threshold 1, EVERY entity below perfect coverage is flagged.
    const report = buildCoverageReport(companies, pages, { threshold: 1 });
    expect(report.threshold).toBe(1);
    // ghost company + ghost page are low; asana company/page are perfect (score 1).
    expect(report.low_coverage_count).toBe(2);
    // still includes everything
    expect(report.companies).toHaveLength(2);
    expect(report.pages).toHaveLength(2);
  });
});
