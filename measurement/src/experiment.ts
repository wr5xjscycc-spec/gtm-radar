// P2·5 Module 2 — experiment re-measurement orchestration.
//
// WHY THIS EXISTS: P2·5's DoD is to measure an experiment's pre/post citation rates, WINDOW them
// (`baseline`/`post`), and TAG them with `experiment_id` so P4 can run a difference-in-differences.
// The measurement core (measureAdaptive → buildLabeledRows) already emits run-level rows; it stamps
// them `window_tag:"adhoc"` with no `experiment_id`. Rather than thread two new params through the
// whole core (and re-test every layer beneath it), the design chose RE-TAG AFTER measurement: a pure
// post-pass rewrites exactly those two fields. The core stays untouched and tagging is trivially
// testable in isolation.
//
// THE NON-NEGOTIABLE — IDENTICAL-ARM PROTOCOL. Asymmetric measurement (different engines / K /
// cadence per arm) is the #1 DiD confound: any pre/post citation-rate delta could then be an artifact
// of HOW each arm was measured rather than the change under test. So treatment and control pages are
// measured in ONE `measureAdaptive` pass per query, under ONE shared config — and crucially they ride
// the SAME candidate pool. The symmetry is therefore STRUCTURAL (both arms are just pages in the same
// pool sampled by the same engines at the same K), not a property we promise and hope holds. This
// module's only job is to (a) run that one shared pass per query, (b) tag the rows, and (c) partition
// them by arm for P4 — it deliberately adds no per-arm branching that could break the symmetry.
//
// Per-engine, never merged (unchanged from the core). Pure / injectable: `tagExperimentRows` is pure
// & non-mutating; the orchestration takes an injected registry (fakes in tests — no real network).

import type { Engine, MeasurementRow } from "./types";
import type { QueryRecord, CandidatePage } from "./contract-records";
import type { EngineRegistry } from "./dispatch";
import { measureAdaptive } from "./sampling/adaptive";
import { type ExperimentRecord, type Arm, classifyArm } from "./experiment-records";

/**
 * Pure, NON-MUTATING re-tag of measurement rows onto an experiment window.
 *
 * Returns a NEW array of NEW row objects, each a shallow copy of the input with ONLY `window_tag`
 * and `experiment_id` rewritten — every other field is carried through verbatim. The input array and
 * its row objects are never touched, which is the entire reason re-tagging lives in a separate
 * post-pass: the measurement core can keep emitting `"adhoc"` rows and this function rewrites them
 * without anyone downstream having to reason about mutation.
 *
 * `windowTag` is restricted to the two experiment windows — re-measurement NEVER writes `"adhoc"`
 * (that value means "Phase-0/2 ad-hoc baseline, not part of an experiment"). The narrower literal
 * type makes an accidental `"adhoc"` here a compile error.
 *
 * @param rows         The rows to tag (typically the concatenation of one window's measureAdaptive
 *                     passes). May be empty (an empty array round-trips to an empty array).
 * @param windowTag    Which experiment window these rows belong to.
 * @param experimentId The experiment id to stamp on every row (P4's DiD join key).
 * @returns A fresh array of freshly-copied, tagged rows.
 */
export function tagExperimentRows(
  rows: MeasurementRow[],
  windowTag: "baseline" | "post",
  experimentId: string,
): MeasurementRow[] {
  // Spread copy per row so neither the array nor any row object is mutated; overwrite exactly the
  // two experiment fields and leave the rest of the (query, page, engine, run, label, ts…) shape intact.
  return rows.map((row) => ({ ...row, window_tag: windowTag, experiment_id: experimentId }));
}

/**
 * The outcome of re-measuring ONE window of an experiment.
 *
 * `rows` holds ALL tagged rows (both arms PLUS any neither-arm pool pages — e.g. a competitor that
 * shares the candidate pool). `byArm` is a partition of those same rows by `classifyArm`: a page in
 * NEITHER arm is present in `rows` but in NEITHER bucket (it is measured and tagged, but belongs to
 * no arm and so contributes to no DiD comparison). `failures` carries each per-engine failure tagged
 * with the query_id it occurred under, exactly as the sweep does — surfaced, never buried.
 */
export interface ExperimentWindowResult {
  /** The experiment these rows were re-measured for (stamped on every row). */
  experiment_id: string;
  /** Which window was re-measured. */
  window: "baseline" | "post";
  /** Every tagged row across every query (both arms + neither-arm pool pages). */
  rows: MeasurementRow[];
  /** The arm partition of `rows`: neither-arm pages appear in NEITHER bucket (but are in `rows`). */
  byArm: { treatment: MeasurementRow[]; control: MeasurementRow[] };
  /** Per-engine failures, each tagged with the query_id it occurred under (surface, don't bury). */
  failures: Array<{ engine: Engine; error: string; query_id: string }>;
}

/**
 * Re-measure ONE window of an experiment under the identical-arm protocol.
 *
 * For EACH query, run a SINGLE `measureAdaptive` pass with the SAME config (kInitial/kMax/threshold/
 * focusDomains/model/fetchImpl are shared across every query and — because both arms are just pages
 * in `poolFor(query)` — across both arms). That single shared pass IS the identical-arm guarantee:
 * treatment and control are measured by the same engines, at the same adaptive K, in the same call.
 * `poolFor(query)` MUST therefore include both of the query's arm pages (the caller owns pool
 * assembly; this module does not synthesize pools — that would risk an asymmetric pool per arm).
 *
 * Then:
 *  1. Concatenate every query's rows into one buffer; tag each per-engine failure with that query's
 *     id (mirrors sweep.ts — a surfaced failure traces back to the query it occurred under).
 *  2. `tagExperimentRows(allRows, window, experiment.id)` — rewrite window_tag + experiment_id on the
 *     whole buffer in one pure pass.
 *  3. Partition the TAGGED rows by `classifyArm(row.page_url, experiment)`: treatment / control land
 *     in their buckets; a `null` (neither-arm) page stays in `rows` but in neither bucket.
 *
 * Per-engine isolation lives INSIDE measureAdaptive: a thrown engine lands in its `failures` and
 * never stops the other engines (or the other arm — both arms ride every surviving engine's rows).
 *
 * @returns {@link ExperimentWindowResult} — all tagged rows, the arm partition, and query-tagged failures.
 */
export async function reMeasureExperimentWindow(params: {
  experiment: ExperimentRecord;
  window: "baseline" | "post";
  queries: QueryRecord[];
  /** Pool builder per query — MUST contain the query's treatment + control pages (caller-owned). */
  poolFor: (query: QueryRecord) => CandidatePage[];
  registry: EngineRegistry;
  apiKeys: Partial<Record<Engine, string>>;
  ts: number;
  kInitial?: number;
  kMax?: number;
  threshold?: number;
  focusDomains?: string[];
  model?: string;
  fetchImpl?: typeof fetch;
}): Promise<ExperimentWindowResult> {
  const {
    experiment,
    window,
    queries,
    poolFor,
    registry,
    apiKeys,
    ts,
    kInitial,
    kMax,
    threshold,
    focusDomains,
    model,
    fetchImpl,
  } = params;

  // --- Step 1: one shared measureAdaptive pass per query; concat rows + query-tagged failures ---
  const measuredRows: MeasurementRow[] = [];
  const failures: Array<{ engine: Engine; error: string; query_id: string }> = [];

  for (const query of queries) {
    // ONE pass over the query's whole pool (both arms + any neither-arm pages) with the SAME config
    // for every query — the structural identical-arm guarantee. We pass kInitial/kMax/threshold
    // through even when undefined so measureAdaptive applies its own documented defaults uniformly.
    const measured = await measureAdaptive({
      query,
      candidatePool: poolFor(query),
      registry,
      apiKeys,
      ts,
      kInitial,
      kMax,
      threshold,
      focusDomains,
      model,
      fetchImpl,
    });

    measuredRows.push(...measured.rows);
    // Tag each per-engine failure with the query_id so a surfaced failure traces back to its query.
    for (const f of measured.failures) {
      failures.push({ engine: f.engine, error: f.error, query_id: query.id });
    }
  }

  // --- Step 2: pure post-pass — stamp this window + experiment_id on the whole buffer ---
  const rows = tagExperimentRows(measuredRows, window, experiment.id);

  // --- Step 3: partition the TAGGED rows by arm. A neither-arm page (classifyArm → null) stays in
  // `rows` but lands in NEITHER bucket — measured and tagged, but part of no DiD comparison. ---
  const byArm: { treatment: MeasurementRow[]; control: MeasurementRow[] } = {
    treatment: [],
    control: [],
  };
  for (const row of rows) {
    const arm: Arm | null = classifyArm(row.page_url, experiment);
    if (arm === "treatment") {
      byArm.treatment.push(row);
    } else if (arm === "control") {
      byArm.control.push(row);
    }
    // arm === null → neither bucket (still present in `rows`).
  }

  return {
    experiment_id: experiment.id,
    window,
    rows,
    byArm,
    failures,
  };
}
