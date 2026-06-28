// P3 · Phase 6 (final), task #1 — finalize + validate the ONE launch vertical.
//
// The wedge is VERTICAL-FIRST. The Phase-6 gotcha (red-team "positioning trap"):
// "resist the urge to go horizontal — depth in one vertical beats shallow coverage
// everywhere." This module enforces that depth-in-one-vertical discipline: it curates
// a grounded query set down to a SINGLE vertical (REJECTING any cross-vertical query
// rather than silently absorbing it — that contamination is scope creep), dedupes the
// survivors, attaches that vertical's CMS targets (handed to P4), and runs transparent
// validation GATES. Every failed gate is surfaced as a human-readable `issues` string;
// the pack is RETURNED even when it fails validation (never throw away the work or hide
// why it failed — the honesty rule). It owns no network and imports no SDK.

import { seedSourceRatio } from "./queries";
import type { CmsTarget, Query, SeedSourceRatio, VerticalPack } from "./types";

/** Stable version tag for the assembled, validated launch vertical pack. */
export const VERTICAL_PACK_VERSION = "vertical-pack@v1";

/**
 * Default minimum curated-query count. The phase card targets 300–500 queries in
 * production; the FLOOR here is kept modest (and overridable) so tests can validate
 * with small sets without faking hundreds of queries.
 */
export const DEFAULT_MIN_QUERIES = 50;

/**
 * Default floor on the real-seeded ratio (non-llm_expand / total). Mirrors the
 * Phase-2 query guard (`DEFAULT_MIN_REAL_SEEDED_RATIO`): keep a healthy grounded
 * majority-ish so the pack isn't dominated by invented llm_expand queries.
 */
export const DEFAULT_MIN_REAL_RATIO = 0.4;

/** Fold a query to its canonical comparison form: trimmed, lowercased, single-spaced. */
function normalizeText(text: string): string {
  return String(text ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Fold a vertical slug to its canonical form (trim + lowercase). Both sides of every
 * vertical comparison go through this so a casing/whitespace mismatch (e.g. a query
 * tagged "Project-Management" vs config "project-management") can't be MISLABELED as
 * cross-vertical contamination — which would emit a false honesty signal.
 */
function normalizeVertical(vertical: string): string {
  return String(vertical ?? "").trim().toLowerCase();
}

/** True when every query already belongs to `vertical` (no cross-vertical contamination). */
export function isSingleVertical(queries: Query[], vertical: string): boolean {
  const target = normalizeVertical(vertical);
  return queries.every((q) => normalizeVertical(q.vertical) === target);
}

/**
 * Curate a raw query set down to ONE vertical: keep ONLY queries whose vertical
 * matches `vertical` (the anti-horizontal gate), then DEDUPE by normalized text
 * (trim + lowercase + collapse whitespace), keeping the first occurrence. A dropped
 * duplicate is normal curation (not an issue); a dropped off-vertical query is a
 * contamination signal reported by `buildVerticalPack`.
 */
export function curateQueries(queries: Query[], vertical: string): Query[] {
  const target = normalizeVertical(vertical);
  const seen = new Set<string>();
  const curated: Query[] = [];
  for (const q of queries) {
    if (normalizeVertical(q.vertical) !== target) continue; // anti-horizontal: drop cross-vertical
    const key = normalizeText(q.text);
    if (seen.has(key)) continue; // dedupe; first-seen wins
    seen.add(key);
    curated.push(q);
  }
  return curated;
}

export interface BuildVerticalPackArgs {
  vertical: string;
  queries: Query[];
  cmsTargets: CmsTarget[];
  /** Floor on curated-query count (defaults to DEFAULT_MIN_QUERIES). */
  minQueries?: number;
  /** Floor on the real-seeded ratio (defaults to DEFAULT_MIN_REAL_RATIO). */
  minRealRatio?: number;
}

/**
 * Build the finalized, validated launch vertical pack. Curation + validation pipeline:
 *  1. Single-vertical scoping — drop cross-vertical queries (contamination → issue).
 *  2. Dedupe curated queries by normalized text (a dropped dup is fine, not an issue).
 *  3. Keep only CMS targets for this vertical (a mismatched target → issue, excluded).
 *  4. Compute the real-vs-llm_expand seed_source_ratio over the curated set.
 *  5. Gates: ≥1 query after scoping AND size ≥ minQueries AND realRatio ≥ minRealRatio
 *     AND ≥1 CMS target AND no cross-vertical contamination. Each failed gate appends a
 *     clear string to `issues`; `validated = issues.length === 0`.
 * The pack is RETURNED even when invalid, with `issues` populated (transparency).
 */
export function buildVerticalPack(args: BuildVerticalPackArgs): VerticalPack {
  const { vertical, queries, cmsTargets } = args;
  const minQueries = args.minQueries ?? DEFAULT_MIN_QUERIES;
  const minRealRatio = args.minRealRatio ?? DEFAULT_MIN_REAL_RATIO;

  const issues: string[] = [];
  const targetVertical = normalizeVertical(vertical);

  // 1 + 2. Single-vertical scoping then dedupe (vertical compared case-insensitively).
  const crossVertical = queries.filter((q) => normalizeVertical(q.vertical) !== targetVertical);
  const curated = curateQueries(queries, vertical);

  if (crossVertical.length > 0) {
    const offVerticals = [...new Set(crossVertical.map((q) => q.vertical))].sort();
    issues.push(
      `cross-vertical contamination: excluded ${crossVertical.length} quer${
        crossVertical.length === 1 ? "y" : "ies"
      } from other vertical(s) [${offVerticals.join(", ")}] — the pack must stay single-vertical (${vertical}).`,
    );
  }

  // 3. Validate CMS targets: keep only those for this vertical; flag mismatches.
  const validCmsTargets = cmsTargets.filter((t) => normalizeVertical(t.vertical) === targetVertical);
  const mismatchedCms = cmsTargets.filter((t) => normalizeVertical(t.vertical) !== targetVertical);
  if (mismatchedCms.length > 0) {
    const offVerticals = [...new Set(mismatchedCms.map((t) => t.vertical))].sort();
    issues.push(
      `excluded ${mismatchedCms.length} CMS target(s) for other vertical(s) [${offVerticals.join(
        ", ",
      )}] — CMS targets must match the launch vertical (${vertical}).`,
    );
  }

  // 4. Seed-source ratio over the curated set, mapped into the contract type.
  const ratio = seedSourceRatio(curated);
  const seed_source_ratio: SeedSourceRatio = {
    total: ratio.total,
    real: ratio.real,
    llm_expand: ratio.llm_expand,
    realRatio: ratio.realRatio,
  };

  // 5. Gates.
  if (curated.length < 1) {
    issues.push(`no queries remain for vertical "${vertical}" after single-vertical scoping.`);
  }
  if (curated.length < minQueries) {
    issues.push(
      `query pack too small: ${curated.length} curated quer${
        curated.length === 1 ? "y" : "ies"
      } < minimum ${minQueries}.`,
    );
  }
  // Ratio gate only meaningful on a non-empty curated set (0/0 is undefined noise;
  // the empty case is already covered by the "no queries remain" issue above).
  if (seed_source_ratio.total > 0 && seed_source_ratio.realRatio < minRealRatio) {
    issues.push(
      `real-seed ratio too low: ${seed_source_ratio.realRatio.toFixed(3)} (${
        seed_source_ratio.real
      }/${seed_source_ratio.total}) < floor ${minRealRatio} — llm_expand is dominating the pack.`,
    );
  }
  if (validCmsTargets.length < 1) {
    issues.push(
      `no CMS target for vertical "${vertical}" — P4 needs at least one publish destination.`,
    );
  }

  return {
    vertical,
    version: VERTICAL_PACK_VERSION,
    queries: curated,
    cms_targets: validCmsTargets,
    seed_source_ratio,
    validated: issues.length === 0,
    issues,
  };
}
