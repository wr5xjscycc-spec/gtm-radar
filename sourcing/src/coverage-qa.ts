// P3 · Phase 6 task #2: launch-vertical COVERAGE QA sweep (transparency layer).
//
// WHAT THIS IS (epistemic layer): coverage QA is DESCRIPTIVE TRANSPARENCY. It runs
// the Phase-4 coverage assessment over the launch vertical's companies + pages and
// SURFACES every low-coverage entity so P1's coverage UI can render the gaps. It is
// NEVER a causal claim, and — critically — it does NOT exclude low-coverage rows from
// the dataset. Dropping low-coverage rows to make the vertical look complete would
// BIAS the model on a non-random subset, the exact silent-drop the red-team forbids
// (ORCHESTRATION §6 red-team transparency; P3 phase card "be honest about coverage
// gaps"). So the sweep's pass/fail is a TRANSPARENCY assertion ("every entity was
// accounted for, nothing silently dropped"), NOT a completeness gate.
//
// This module BUILDS ON coverage.ts (Phase 4) — it reuses buildCoverageReport and
// reconcileCompanyFlags rather than recomputing presence. The launch vertical is
// "fully wired, curated, and transparent about its gaps" (Phase 6 DoD).

import type {
  Company,
  Page,
  CoverageAssessment,
  CoverageFlags,
  VerticalCoverageQA,
} from "./types";
import {
  buildCoverageReport,
  reconcileCompanyFlags,
  DEFAULT_COVERAGE_THRESHOLD,
} from "./coverage";

/** Inputs to the launch-vertical coverage QA sweep. */
export interface SweepVerticalCoverageArgs {
  vertical: string;
  companies: Company[];
  pages: Page[];
  /** Low-coverage threshold; defaults to DEFAULT_COVERAGE_THRESHOLD (Phase 4). */
  threshold?: number;
}

/**
 * Run the coverage QA sweep over one vertical's companies + pages.
 *
 * Steps:
 *  1. Reuse the Phase-4 coverage report (buildCoverageReport) at the given threshold.
 *  2. SURFACE every low-coverage assessment (companies + pages) for P1's UI — the
 *     gaps made VISIBLE, never hidden.
 *  3. RECONCILE each company's persisted coverage_flags toward the actual data.
 *  4. `passed` = the TRANSPARENCY assertion: the report accounts for EVERY input
 *     entity (nothing silently dropped). A vertical with low coverage still PASSES
 *     as long as its gaps are surfaced — passed != "no gaps exist".
 */
export function sweepVerticalCoverage(args: SweepVerticalCoverageArgs): VerticalCoverageQA {
  const { vertical, companies, pages } = args;
  const threshold = args.threshold ?? DEFAULT_COVERAGE_THRESHOLD;

  // 1. Reuse Phase-4 coverage — every entity is assessed and PRESENT in the report.
  const report = buildCoverageReport(companies, pages, { threshold });

  // 2. Surface low-coverage entities (companies + pages) together for P1's coverage
  //    UI. These are FLAGGED, not removed — they remain in `report` as well.
  const surfaced_low_coverage: CoverageAssessment[] = [
    ...report.companies.filter((a) => a.low_coverage),
    ...report.pages.filter((a) => a.low_coverage),
  ];

  // 3. Reconcile each company's coverage flags toward the actual data (a stale or
  //    wrong persisted flag is corrected, never propagated).
  const reconciled_flags: Array<{ domain: string; coverage_flags: CoverageFlags }> =
    companies.map((c) => ({
      domain: c.domain,
      coverage_flags: reconcileCompanyFlags(c),
    }));

  // 4. Transparency assertion: nothing silently dropped — one assessment per input.
  const passed =
    report.companies.length === companies.length && report.pages.length === pages.length;

  return {
    vertical,
    report,
    surfaced_low_coverage,
    reconciled_flags,
    passed,
  };
}

/**
 * A small, HONEST human-readable summary of the surfaced gaps — one line per
 * low-coverage entity naming exactly which feature families are missing. Intended
 * for logs and P1's coverage UI. Lists EVERY surfaced gap (no truncation, no hiding).
 *
 * e.g. `["competitor.com: offpage, understanding missing"]`.
 */
export function coverageGaps(qa: VerticalCoverageQA): string[] {
  return qa.surfaced_low_coverage.map(
    (a) => `${a.key}: ${a.missing.join(", ")} missing`,
  );
}
