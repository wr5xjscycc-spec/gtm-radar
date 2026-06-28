// P3 · Phase 4 task #2: coverage assessment & flags (measurement-layer transparency).
//
// WHAT THIS IS (epistemic layer): coverage is a DESCRIPTIVE MEASUREMENT of how much
// data each entity actually carries — it is NEVER a causal claim and NEVER a reason
// to drop a row. Low coverage is FLAGGED so P1 can SURFACE it (ORCHESTRATION §6
// red-team transparency; CONTRACT.md epistemic layers). The whole point of this
// module is the anti-silent-drop guarantee: every company and page assessed here is
// PRESENT in the report, low-coverage ones merely carry low_coverage=true.
//
// RECONCILE WITH REALITY (red-team gotcha): the persisted `coverage_flags` on a
// company can go STALE or simply disagree with the data (e.g. a flag says
// firmographics_missing=false while firmographics is actually empty). This module
// trusts the DATA, not the flag: presence is recomputed from actual non-empty field
// content, so a wrong flag is corrected rather than propagated. enrichFirmographics
// / enrichOffpage set the flags honestly at write time; here we re-derive them so a
// downstream consumer (and the board) never shows a hollow row as "covered".

import type {
  Company,
  Page,
  CoverageAssessment,
  CoverageReport,
  CoverageFlags,
} from "./types";

/**
 * The three company-level feature families (CONTRACT.md record #2). A company's
 * coverage_score is the fraction of these that actually carry data.
 */
export const COMPANY_FEATURE_FAMILIES = ["firmographics", "offpage", "understanding"] as const;

/**
 * The two page-level content-feature families (CONTRACT.md record #3). The
 * deterministic vector is ALWAYS expected (parsed from HTML, low measurement error);
 * the subjective vector is also expected but the LLM pass may be absent/failed.
 * Keeping them separate mirrors types.ts (deterministic vs subjective must not blur).
 */
export const PAGE_FEATURE_FAMILIES = ["deterministic_features", "subjective_features"] as const;

/**
 * Default low-coverage threshold. An entity is `low_coverage` when its
 * coverage_score is STRICTLY BELOW this fraction. 0.5 means "fewer than half of the
 * expected families present" → flagged for P1 to surface (never excluded from fits).
 * Documented + echoed into CoverageReport.threshold so the number is reproducible.
 */
export const DEFAULT_COVERAGE_THRESHOLD = 0.5;

/** A trimmed non-empty string is real data; "", "  " and non-strings are not. */
function hasText(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

/** A finite number (INCLUDING 0 — a measured 0 is a real datum, see offpage.ts). */
function hasNumber(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v);
}

// ─────────────────────────────────────────────────────────────────────────────
// Company-level presence — recomputed from the ACTUAL data, not from the flag.
// ─────────────────────────────────────────────────────────────────────────────

/** Firmographics present when ≥1 of the five fields carries real (non-blank) data. */
export function hasFirmographics(company: Company): boolean {
  const f = company.firmographics;
  if (!f) return false;
  return (
    hasText(f.size) ||
    hasText(f.funding_stage) ||
    hasText(f.headcount_growth) ||
    hasText(f.hiring_velocity) ||
    (Array.isArray(f.tech_stack) && f.tech_stack.some((t) => hasText(t)))
  );
}

/** Off-page present when ≥1 of the eight numeric signals is a real reading (0 counts). */
export function hasOffpage(company: Company): boolean {
  const o = company.offpage;
  if (!o) return false;
  return (
    hasNumber(o.thirdparty_mentions) ||
    hasNumber(o.reddit_presence) ||
    hasNumber(o.g2_presence) ||
    hasNumber(o.wikipedia_presence) ||
    hasNumber(o.review_site_presence) ||
    hasNumber(o.brand_search_volume) ||
    hasNumber(o.backlink_density) ||
    hasNumber(o.entity_cooccurrence)
  );
}

/** Understanding present when category/icp/positioning carries real (non-blank) text. */
export function hasUnderstanding(company: Company): boolean {
  const u = company.understanding;
  if (!u) return false;
  return hasText(u.category) || hasText(u.icp) || hasText(u.positioning);
}

/**
 * Recompute `coverage_flags` from ACTUAL field presence — a pure, non-mutating
 * reconciliation. A stale/incorrect persisted flag is CORRECTED toward the data:
 * `*_missing` is true exactly when the family carries no real data. This is what
 * keeps a hollow row from being shown as "covered".
 */
export function reconcileCompanyFlags(company: Company): CoverageFlags {
  return {
    firmographics_missing: !hasFirmographics(company),
    offpage_missing: !hasOffpage(company),
    understanding_missing: !hasUnderstanding(company),
  };
}

/**
 * Assess one company's coverage. A family counts as PRESENT only when the company
 * actually carries non-empty data for it (the coverage_flags are NOT trusted — they
 * may disagree with the data, and we resolve toward the data). `missing` lists the
 * absent families; coverage_score = present/3; low_coverage when strictly below the
 * threshold. The company is SURFACED regardless — never dropped.
 */
export function assessCompanyCoverage(
  company: Company,
  threshold: number = DEFAULT_COVERAGE_THRESHOLD,
): CoverageAssessment {
  const present: Record<(typeof COMPANY_FEATURE_FAMILIES)[number], boolean> = {
    firmographics: hasFirmographics(company),
    offpage: hasOffpage(company),
    understanding: hasUnderstanding(company),
  };

  const missing = COMPANY_FEATURE_FAMILIES.filter((fam) => !present[fam]);
  const presentCount = COMPANY_FEATURE_FAMILIES.length - missing.length;
  const coverage_score = presentCount / COMPANY_FEATURE_FAMILIES.length;

  return {
    kind: "company",
    key: company.domain,
    missing: [...missing],
    coverage_score,
    low_coverage: coverage_score < threshold,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Page-level presence — deterministic vector (always expected) + subjective vector.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deterministic features present when the core deterministic fields exist. These
 * are parsed from HTML and should always be there; absence means the extractor
 * didn't run / the row is malformed, which is itself low coverage worth surfacing.
 * `freshness_days` is intentionally excluded from the core check (it is legitimately
 * `null` when undeterminable — null is a value, not a gap).
 */
export function hasDeterministicFeatures(page: Page): boolean {
  const c = page.content_features;
  if (!c) return false;
  return (
    typeof c.schema_markup === "boolean" &&
    typeof c.comparison_table === "boolean" &&
    hasNumber(c.word_count) &&
    !!c.heading_structure &&
    hasNumber(c.heading_structure.h1) &&
    hasNumber(c.heading_structure.h2) &&
    hasNumber(c.heading_structure.h3) &&
    hasNumber(c.query_term_coverage)
  );
}

/**
 * Subjective features present when the gpt-4o-mini-extracted fields exist
 * (direct_answer_first et al.). The subjective pass is optional in the type, so its
 * absence is a real coverage gap — flagged, not dropped.
 */
export function hasSubjectiveFeatures(page: Page): boolean {
  const c = page.content_features;
  if (!c) return false;
  return (
    typeof c.direct_answer_first === "boolean" &&
    hasNumber(c.stats_density) &&
    hasNumber(c.citation_density) &&
    hasNumber(c.quote_density) &&
    typeof c.listicle_vs_prose === "string" &&
    c.listicle_vs_prose.length > 0
  );
}

/**
 * Assess one page's coverage against its two expected families. `missing` names the
 * absent vectors ("deterministic_features" / "subjective_features"); coverage_score
 * = present/expected; low_coverage when strictly below the threshold. The page is
 * SURFACED regardless — never dropped.
 */
export function assessPageCoverage(
  page: Page,
  threshold: number = DEFAULT_COVERAGE_THRESHOLD,
): CoverageAssessment {
  const present: Record<(typeof PAGE_FEATURE_FAMILIES)[number], boolean> = {
    deterministic_features: hasDeterministicFeatures(page),
    subjective_features: hasSubjectiveFeatures(page),
  };

  const missing = PAGE_FEATURE_FAMILIES.filter((fam) => !present[fam]);
  const presentCount = PAGE_FEATURE_FAMILIES.length - missing.length;
  const coverage_score = presentCount / PAGE_FEATURE_FAMILIES.length;

  return {
    kind: "page",
    key: page.url,
    missing: [...missing],
    coverage_score,
    low_coverage: coverage_score < threshold,
  };
}

/**
 * Roll up coverage across every company and page. CRITICAL transparency invariant:
 * the report INCLUDES one assessment per input entity — low-coverage rows are
 * present and flagged, NEVER omitted. `threshold` is echoed so low_coverage is
 * reproducible; `low_coverage_count` is the number of flagged entities (surfaced,
 * not dropped).
 */
export function buildCoverageReport(
  companies: Company[],
  pages: Page[],
  opts?: { threshold?: number },
): CoverageReport {
  const threshold = opts?.threshold ?? DEFAULT_COVERAGE_THRESHOLD;

  const companyAssessments = companies.map((c) => assessCompanyCoverage(c, threshold));
  const pageAssessments = pages.map((p) => assessPageCoverage(p, threshold));

  const low_coverage_count =
    companyAssessments.filter((a) => a.low_coverage).length +
    pageAssessments.filter((a) => a.low_coverage).length;

  return {
    companies: companyAssessments,
    pages: pageAssessments,
    threshold,
    low_coverage_count,
  };
}
