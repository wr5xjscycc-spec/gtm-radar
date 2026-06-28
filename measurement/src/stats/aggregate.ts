// P2.3 (Measurement, statistics core) -- per-engine run aggregation.
//
// Collapse the run-level `MeasurementRow[]` (one row per repeat) into one statistical summary
// per (query_id, page_url, engine). The group key is the FULL triple ON PURPOSE: `engine` is
// part of it because cross-engine citation overlap is ~11% (design spec, "Non-negotiables") --
// the same query+page measured on two engines is two genuinely different facts, and merging
// them is a correctness bug, not a tidy-up. Everything here is pure: no network, no clock; the
// numbers come only from the rows. Wilson endpoints come from the shared `wilsonInterval` so
// this layer and the adaptive sampler agree on the exact CI down to floating point.

import type { Engine, MeasurementRow } from "../types";
import { wilsonInterval } from "../stats/wilson";

/**
 * One per-(query, page, engine) statistical summary, computed over the K run-level rows in the
 * group. `p_cited` carries FREQUENCY (how often cited); `position_weight` carries QUALITY (when
 * cited, how high) -- the two are deliberately orthogonal so frequency is never counted twice.
 */
export interface MeasurementAggregate {
  query_id: string;
  page_url: string;
  engine: Engine;
  /** Model stamp carried from the rows (drift detection / reproducibility). */
  model_version: string;
  /** Number of run-level rows in the group (the K actually achieved for this group). */
  k: number;
  cited_count: number;
  /** `cited_count / k`. */
  p_cited: number;
  /** Wilson CI low endpoint -- from `wilsonInterval(cited_count, k)`. */
  ci_low: number;
  /** Wilson CI high endpoint -- from `wilsonInterval(cited_count, k)`. */
  ci_high: number;
  /**
   * Mean reciprocal rank (`1/position`) over the CITED runs ONLY; `0` when never cited.
   * Orthogonal to `p_cited` -- see interface header. cited@#1 in 2 of 3 runs -> 1.0; cited once
   * @#1 and once @#3 -> 0.667; never cited -> 0.
   */
  position_weight: number;
}

/** Mutable per-group accumulator; finalized into a `MeasurementAggregate` after the pass. */
interface Accumulator {
  query_id: string;
  page_url: string;
  engine: Engine;
  model_version: string;
  k: number;
  cited_count: number;
  /** Sum of reciprocal ranks over cited runs with a valid position -- divided by `cited_with_rank`. */
  rank_recip_sum: number;
  /** Count of cited runs that contributed a valid reciprocal rank (the divisor for the mean). */
  cited_with_rank: number;
}

// Separator for the composite group key. A NUL (U+0000) can never occur inside a real
// query_id/page_url/engine value, so no field can forge a group boundary by embedding the
// delimiter -- e.g. ("a|b","c") and ("a","b|c") would collide under a "|" delimiter but not here.
const KEY_SEP = String.fromCharCode(0);

/**
 * Group `rows` by `(query_id, page_url, engine)` and emit one `MeasurementAggregate` per group,
 * in STABLE first-seen order (the order each distinct key first appears in `rows`). Stability
 * matters because downstream layers (adaptive, demo) iterate aggregates positionally and expect
 * a deterministic ordering from the same input.
 *
 * Per group:
 * - `k`            = number of rows in the group.
 * - `cited_count`  = rows with `cited === true`.
 * - `p_cited`      = `cited_count / k`.
 * - CI             = `wilsonInterval(cited_count, k)` (the shared numeric ground truth).
 * - `position_weight` = mean of `1/position` over the CITED runs only; `0` when none cited. We
 *   average over cited runs, NOT over all K, so the signal stays orthogonal to `p_cited`
 *   (folding frequency in twice would double-count it). A run flagged `cited` but missing a
 *   valid `position` (upstream inconsistency) is skipped defensively rather than producing NaN.
 * - `model_version` = carried from the rows. Runs of one group share a model_version by
 *   construction; we take the last-seen value (last-writer) so a re-measure with a bumped stamp
 *   surfaces the newer one rather than the stale first.
 *
 * Empty input -> `[]`.
 */
export function aggregateRuns(rows: MeasurementRow[]): MeasurementAggregate[] {
  // Insertion-ordered map keyed on the full triple. A Map preserves first-insertion iteration
  // order in JS, which is exactly the stable first-seen ordering the contract requires.
  const groups = new Map<string, Accumulator>();

  for (const row of rows) {
    const key = `${row.query_id}${KEY_SEP}${row.page_url}${KEY_SEP}${row.engine}`;

    let acc = groups.get(key);
    if (acc === undefined) {
      acc = {
        query_id: row.query_id,
        page_url: row.page_url,
        engine: row.engine,
        model_version: row.model_version,
        k: 0,
        cited_count: 0,
        rank_recip_sum: 0,
        cited_with_rank: 0,
      };
      groups.set(key, acc);
    }

    acc.k += 1;
    // Last-writer model_version: same across a real group, but a re-measure should surface the
    // newer stamp rather than pin the stale first one.
    acc.model_version = row.model_version;

    if (row.cited) {
      acc.cited_count += 1;
      // position_weight averages over cited runs only. Guard against a cited row with a
      // null/0/negative position (upstream inconsistency) so we never divide by zero or emit NaN.
      if (typeof row.position === "number" && row.position > 0) {
        acc.rank_recip_sum += 1 / row.position;
        acc.cited_with_rank += 1;
      }
    }
  }

  const out: MeasurementAggregate[] = [];
  for (const acc of groups.values()) {
    const ci = wilsonInterval(acc.cited_count, acc.k);
    out.push({
      query_id: acc.query_id,
      page_url: acc.page_url,
      engine: acc.engine,
      model_version: acc.model_version,
      k: acc.k,
      cited_count: acc.cited_count,
      // k >= 1 here (a group only exists because a row created it), so this never divides by zero.
      p_cited: acc.cited_count / acc.k,
      ci_low: ci.low,
      ci_high: ci.high,
      // Mean over cited runs that carried a usable rank; 0 when none did (never cited, or every
      // cited run lacked a valid position). Orthogonal to p_cited by construction.
      position_weight: acc.cited_with_rank > 0 ? acc.rank_recip_sum / acc.cited_with_rank : 0,
    });
  }

  return out;
}
