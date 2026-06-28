import type { EngineName } from "./engine";

export interface RunRecord {
  query_id: string;
  page_url: string;
  company_domain: string;
  engine: EngineName;
  model_version: string;
  run_idx: number;
  appeared: boolean;
  cited: boolean;
  position: number | null;
  source_urls: string[];
  ts: number;
  window_tag: "baseline" | "post" | "adhoc";
  experiment_id?: string;
}

export interface AggregateResult {
  query_id: string;
  page_url: string;
  company_domain: string;
  engine: EngineName;
  model_version: string;
  K: number;
  P_cited: number;
  ci_low: number;
  ci_high: number;
  position_weight: number;
  runs: RunRecord[];
}

/**
 * Wilson score interval for a binomial proportion (95% CI, z=1.96).
 * Returns { low, high } in [0, 1]. Handles edge cases (k=0, k=n, n=0).
 */
export function wilsonCI(
  k: number,
  n: number,
  z: number = 1.96,
): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 1 };
  if (k < 0) k = 0;
  if (k > n) k = n;

  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / denom;

  return {
    low: Math.max(0, centre - margin),
    high: Math.min(1, centre + margin),
  };
}

/**
 * Compute position weight from a citation's index in the results list.
 *
 * Uses inverse-rank weighting: weight = 1 / (position + 1).
 * Position 0 → weight 1.0, position 1 → 0.5, position 2 → 0.33, ...
 */
export function positionWeight(position: number | null): number {
  if (position === null || position < 0) return 0;
  return 1 / (position + 1);
}

/**
 * Compute the average position weight across K runs.
 * Only runs where the page was cited contribute; uncited runs contribute 0.
 */
export function averagePositionWeight(positions: (number | null)[]): number {
  if (positions.length === 0) return 0;
  let total = 0;
  for (const pos of positions) {
    total += positionWeight(pos);
  }
  return total / positions.length;
}

/**
 * Aggregate K run-level records into a single AggregateResult with
 * P_cited, Wilson CI, and position_weight.
 */
export function aggregateRuns(
  queryId: string,
  pageUrl: string,
  companyDomain: string,
  engine: EngineName,
  runs: RunRecord[],
): AggregateResult {
  const K = runs.length;
  const citedCount = runs.filter((r) => r.cited).length;
  const positions = runs.map((r) => r.position);
  const ci = wilsonCI(citedCount, K);

  const latestModelVersion =
    runs.length > 0 ? runs[runs.length - 1].model_version : "unknown";

  return {
    query_id: queryId,
    page_url: pageUrl,
    company_domain: companyDomain,
    engine,
    model_version: latestModelVersion,
    K,
    P_cited: K > 0 ? citedCount / K : 0,
    ci_low: ci.low,
    ci_high: ci.high,
    position_weight: averagePositionWeight(positions),
    runs,
  };
}

/**
 * Determine whether a page needs more samples.
 *
 * Extends sampling when the result is truly ambiguous:
 *   1. CI span is wide (> threshold), AND
 *   2. Proportion is not extreme (between 0.15–0.85), AND
 *   3. CI straddles the 0.5 midpoint.
 *
 * Unanimous results (k=0 or k=n) always stop early, even though the
 * Wilson CI for small n technically spans 0.5 — the practical answer
 * is already clear.
 */
export function needsMoreSamples(
  aggregate: AggregateResult,
  wideThreshold: number = 0.3,
): boolean {
  const span = aggregate.ci_high - aggregate.ci_low;

  if (span <= wideThreshold) return false;

  if (aggregate.P_cited >= 0.85 || aggregate.P_cited <= 0.15) return false;

  const straddlesMidpoint =
    aggregate.ci_low < 0.5 && aggregate.ci_high > 0.5;
  return straddlesMidpoint;
}
