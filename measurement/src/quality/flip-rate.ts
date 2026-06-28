// P2·4 Module 1 — measurement-noise QA (flip-rate).
//
// LLM citation is a noisy measurement: the SAME (query, page, engine) measured K times can flip
// between cited and uncited. P4's hypothesis generator must not treat a 2/3 flip as ground truth,
// and we refuse to BURY that noise — we quantify it per group and surface the worst offenders.
//
// We integrate THREE complementary instability lenses over the same K binary `cited` outcomes:
//   - minority_fraction (PRIMARY): min(cited, k-cited)/k ∈ [0,0.5]. Order-free, magnitude of
//     disagreement, drives `flipped`. 0 = unanimous, 0.5 = maximal split.
//   - transition_rate (informational): adjacent label changes / (k-1) with rows ORDERED BY
//     run_idx. Runs are exchangeable so this is order-dependent and NOT a stable noise estimate —
//     kept because a run of clustered flips reads differently from alternating ones at a glance.
//   - entropy: binary Shannon entropy of p=cited/k in BITS ∈ [0,1]. 0 unanimous, 1 at p=0.5.
//
// Per-engine throughout — engines are NEVER merged (cross-engine citation overlap is ~11%; the
// same query+page on two engines is two different facts). Grouping reuses aggregate.ts's exact
// discipline: a NUL-separated composite key, stable first-seen order via Map iteration.
//
// Everything here is pure and defensive: no network, no clock, and no formula is allowed to emit
// NaN. k<2 groups (a single draw tells you nothing about flipping) are short-circuited to defined
// zeros and excluded from the eligible population and every mean.

import type { Engine, MeasurementRow } from "../types";

/**
 * The three instability lenses for ONE group, plus the unanimity flag. All derive from the same
 * K binary outcomes; see the file header for why each exists and which is primary.
 */
export interface InstabilityMetrics {
  /** min(cited_count, k-cited_count)/k ∈ [0,0.5]; 0 = unanimous. PRIMARY noise signal. */
  minority_fraction: number;
  /**
   * Adjacent label changes / (k-1), with rows ordered by `run_idx` ∈ [0,1]. Order-dependent and
   * runs are exchangeable → INFORMATIONAL only, never the basis for `flipped`.
   */
  transition_rate: number;
  /**
   * Binary Shannon entropy of p = cited_count/k, in BITS ∈ [0,1]. 0 when unanimous, 1 at p=0.5.
   * `0*log2(0)` is treated as 0 so p=0 and p=1 yield 0 rather than NaN.
   */
  entropy: number;
  /** `minority_fraction > 0` — i.e. the group is not unanimous, so the label flipped at least once. */
  flipped: boolean;
}

/** A group's instability metrics tagged with its identity (the full per-engine key) and counts. */
export interface GroupInstability extends InstabilityMetrics {
  query_id: string;
  page_url: string;
  engine: Engine;
  k: number;
  cited_count: number;
}

/** One per-engine roll-up. Engines are never merged — there is exactly one of these per engine. */
export interface EngineFlipReport {
  engine: Engine;
  /** Eligible groups (k >= 2). Only these contribute to the means and to `flip_fraction`. */
  n_groups: number;
  /** Groups with k < 2 — can't flip, excluded from `n_groups` and every mean. Surfaced, not dropped. */
  n_insufficient: number;
  /** Eligible groups with `flipped === true`. */
  n_flipped: number;
  /** `n_flipped / n_groups`; 0 when `n_groups === 0` (no division by zero). */
  flip_fraction: number;
  mean_minority_fraction: number;
  mean_transition_rate: number;
  mean_entropy: number;
  /** Flipped groups, worst-first by `minority_fraction` desc then `entropy` desc; stable on full ties. */
  unstable: GroupInstability[];
}

// NUL (U+0000) composite-key separator — identical discipline to aggregate.ts. A NUL can never
// occur inside a real query_id/page_url/engine, so no field can forge a group boundary (e.g.
// ("a|b","c") vs ("a","b|c") would collide under "|" but not here).
const KEY_SEP = String.fromCharCode(0);

/** Mutable per-group accumulator. We retain the run_idx/cited pairs because transition_rate needs
 * them re-sorted by run_idx after the full pass (rows may arrive shuffled). */
interface Accumulator {
  query_id: string;
  page_url: string;
  engine: Engine;
  k: number;
  cited_count: number;
  /** One {run_idx, cited} per row, in arrival order; sorted by run_idx only when finalizing. */
  runs: Array<{ run_idx: number; cited: boolean }>;
}

/**
 * `x * log2(x)` with the convention `0 * log2(0) = 0`. Pulling this out keeps the entropy formula
 * readable AND guarantees neither p=0 nor p=1 produces `NaN` (Math.log2(0) is -Infinity, and
 * 0 * -Infinity is NaN — so we must special-case x===0 BEFORE multiplying).
 */
function xLog2x(x: number): number {
  return x === 0 ? 0 : x * Math.log2(x);
}

/**
 * Binary Shannon entropy of a Bernoulli(p) in BITS: `-(p·log2 p + (1-p)·log2(1-p))`. 0 at p∈{0,1},
 * 1 at p=0.5. Defined for the full closed interval [0,1] via `xLog2x`'s 0·log0=0 convention.
 */
function binaryEntropy(p: number): number {
  return -(xLog2x(p) + xLog2x(1 - p));
}

/**
 * Compute every instability lens for one group of K outcomes.
 *
 * `runs` is the per-row {run_idx, cited} list AS ACCUMULATED (arrival order, possibly shuffled);
 * we sort a COPY by run_idx for transition counting because runs may arrive unordered and the
 * transition lens is the only order-dependent one. minority_fraction and entropy are order-free.
 *
 * For k < 2 every metric is a defined zero and `flipped` is false: a single draw (or none) carries
 * no information about flipping, and dividing by (k-1) would be 0/0. The caller still records such
 * a group in `n_insufficient` and excludes it from the eligible means.
 */
function computeMetrics(
  k: number,
  cited_count: number,
  runs: Array<{ run_idx: number; cited: boolean }>,
): InstabilityMetrics {
  // k < 2: short-circuit ALL lenses (never run the (k-1) divisor or the entropy formula here).
  if (k < 2) {
    return { minority_fraction: 0, transition_rate: 0, entropy: 0, flipped: false };
  }

  const minority_fraction = Math.min(cited_count, k - cited_count) / k;

  // transition_rate: order rows by run_idx ascending (ascending run_idx is the true temporal
  // order; rows may have arrived shuffled), then count adjacent label changes over (k-1) gaps.
  const ordered = [...runs].sort((a, b) => a.run_idx - b.run_idx);
  let transitions = 0;
  for (let i = 1; i < ordered.length; i++) {
    // `noUncheckedIndexedAccess` widens indexed access to `T | undefined`; bind locals so the
    // bounds-guaranteed elements (1 <= i < length) read as defined without a non-null assertion.
    const cur = ordered[i];
    const prev = ordered[i - 1];
    if (cur !== undefined && prev !== undefined && cur.cited !== prev.cited) transitions += 1;
  }
  const transition_rate = transitions / (k - 1);

  const entropy = binaryEntropy(cited_count / k);

  return { minority_fraction, transition_rate, entropy, flipped: minority_fraction > 0 };
}

/**
 * Group `rows` by `(query_id, page_url, engine)` and emit one `EngineFlipReport` per engine.
 *
 * Grouping is stable first-seen order (Map iteration over a NUL-separated key — exactly
 * aggregate.ts's discipline) so downstream consumers get deterministic ordering from the same
 * input. Engines are NEVER merged: each report covers one engine, and reports appear in
 * first-seen engine order.
 *
 * Per engine:
 * - Each group's three instability lenses are computed over its K outcomes.
 * - `n_groups`     = eligible groups (k >= 2). Only these feed the means and `flip_fraction`.
 * - `n_insufficient` = groups with k < 2 (surfaced explicitly; a single draw can't flip).
 * - `n_flipped`    = eligible groups that are not unanimous.
 * - `flip_fraction` and `mean_*` are 0 when there are no eligible groups (no NaN).
 * - `unstable`     = the flipped groups, worst-first by minority_fraction desc, tiebreak entropy
 *   desc; a full tie returns 0 so JS's stable sort preserves first-seen order.
 *
 * Empty input → `[]`.
 */
export function computeFlipRates(rows: MeasurementRow[]): EngineFlipReport[] {
  // Insertion-ordered map keyed on the full triple — first-seen group order (mirrors aggregate.ts).
  const groups = new Map<string, Accumulator>();
  // First-seen engine order, so the report array is deterministic without sorting engines.
  const engineOrder: Engine[] = [];
  const seenEngines = new Set<Engine>();

  for (const r of rows) {
    if (!seenEngines.has(r.engine)) {
      seenEngines.add(r.engine);
      engineOrder.push(r.engine);
    }

    const key = `${r.query_id}${KEY_SEP}${r.page_url}${KEY_SEP}${r.engine}`;
    let acc = groups.get(key);
    if (acc === undefined) {
      acc = { query_id: r.query_id, page_url: r.page_url, engine: r.engine, k: 0, cited_count: 0, runs: [] };
      groups.set(key, acc);
    }
    acc.k += 1;
    if (r.cited) acc.cited_count += 1;
    acc.runs.push({ run_idx: r.run_idx, cited: r.cited });
  }

  // Bucket finalized groups by engine, preserving first-seen group order within each engine.
  const byEngine = new Map<Engine, GroupInstability[]>();
  for (const acc of groups.values()) {
    const metrics = computeMetrics(acc.k, acc.cited_count, acc.runs);
    const group: GroupInstability = {
      query_id: acc.query_id,
      page_url: acc.page_url,
      engine: acc.engine,
      k: acc.k,
      cited_count: acc.cited_count,
      ...metrics,
    };
    let bucket = byEngine.get(acc.engine);
    if (bucket === undefined) {
      bucket = [];
      byEngine.set(acc.engine, bucket);
    }
    bucket.push(group);
  }

  const reports: EngineFlipReport[] = [];
  for (const engine of engineOrder) {
    const all = byEngine.get(engine) ?? [];

    // Split eligible (k>=2) from insufficient (k<2). Only eligible groups feed means/flip_fraction.
    const eligible = all.filter((g) => g.k >= 2);
    const n_insufficient = all.length - eligible.length;
    const n_groups = eligible.length;

    const flippedGroups = eligible.filter((g) => g.flipped);
    const n_flipped = flippedGroups.length;

    // Guard every division on the empty-eligible case so an all-k<2 engine yields 0s, not NaN.
    const flip_fraction = n_groups === 0 ? 0 : n_flipped / n_groups;
    const mean = (sel: (g: GroupInstability) => number): number =>
      n_groups === 0 ? 0 : eligible.reduce((s, g) => s + sel(g), 0) / n_groups;

    // unstable: worst-first by minority_fraction desc, then entropy desc; full tie → 0 keeps the
    // stable first-seen order (JS Array.sort is stable). Sort a copy so we don't disturb `eligible`.
    const unstable = [...flippedGroups].sort((a, b) => {
      if (b.minority_fraction !== a.minority_fraction) return b.minority_fraction - a.minority_fraction;
      if (b.entropy !== a.entropy) return b.entropy - a.entropy;
      return 0;
    });

    reports.push({
      engine,
      n_groups,
      n_insufficient,
      n_flipped,
      flip_fraction,
      mean_minority_fraction: mean((g) => g.minority_fraction),
      mean_transition_rate: mean((g) => g.transition_rate),
      mean_entropy: mean((g) => g.entropy),
      unstable,
    });
  }

  return reports;
}
