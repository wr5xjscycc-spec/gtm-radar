// P2·3 (Measurement, adaptive sampling) — the −40–50% cost lever.
//
// Two pieces live here:
//   1. `anyAmbiguous` — the PURE decision: is any (in-focus) page still on the fence about τ?
//   2. `measureAdaptive` — the orchestration that keeps repeating a (query, engine) until its
//      pages resolve (or it hits a hard cap), INDEPENDENTLY per engine.
//
// Why this saves money: the demo's candidate pools are dominated by never-cited pages ("0 of N
// cited") by construction. A naive K=kMax-always policy pays for kMax repeats on every query.
// Adaptive stops as soon as the answer is no longer in doubt — and the design's calibration shows
// a confidently-uncited page resolves at K≈4, so the all-uncited pool stops at ~half of kMax.
//
// The straddle rule (NOT a CI-width rule) is the entire mechanism — see `anyAmbiguous` for why a
// width rule would pin every never-cited page to kMax and erase the saving. Per-engine throughout
// (cross-engine overlap ~11%) — the decision for one engine reads ONLY that engine's aggregates.

import type { Engine, MeasurementRow } from "../types";
import type { QueryRecord, CandidatePage } from "../contract-records";
import type { EngineRegistry } from "../dispatch";
import { aggregateRuns, type MeasurementAggregate } from "../stats/aggregate";
import { buildLabeledRows } from "../pipeline";
import { normalizeDomain } from "../normalize";

/** Default decision boundary: is the page cited more or less than half the time? */
const DEFAULT_THRESHOLD = 0.5;
/** Default minimum repeats before we're allowed to declare convergence. */
const DEFAULT_K_INITIAL = 3;
/** Default hard cap on repeats — a genuine coin-flip page would otherwise sample forever. */
const DEFAULT_K_MAX = 8;

export interface AmbiguityOpts {
  /** Decision boundary τ. Default 0.5. */
  threshold?: number;
  /**
   * If set, only pages whose normalized domain ∈ this set drive the decision. The customer's own
   * page is what the demo/model care about — an out-of-focus page being unresolved must NOT keep
   * burning repeats. Entries are normalized (so a raw URL or a `www.` host matches). Default: ALL
   * pages in the pool drive the decision. An EXPLICITLY empty array matches nothing (and so the
   * result is `false`) — "only pages in the set" with an empty set is vacuously no pages.
   */
  focusDomains?: string[];
}

/**
 * Is ANY in-focus aggregate still UNRESOLVED about τ?
 *
 * A page is unresolved iff its Wilson CI STRADDLES τ: `ci_low < τ < ci_high`. While the interval
 * spans the boundary we genuinely cannot say which side the true rate lies on, so more evidence
 * could still flip the call — keep sampling. Once the whole interval sits on one side (`ci_high <=
 * τ` ⇒ confidently below, or `ci_low >= τ` ⇒ confidently above) the page is decided and stops
 * driving extension.
 *
 * CRITICAL — this is a straddle test, NOT a CI-width test. At τ=0.5 a confidently-uncited page
 * (0/8 → {0, 0.324}) RESOLVES even though its width (0.324) is large, while a never-cited page at
 * K=3 ({0, 0.561}) is correctly still unresolved. A width threshold would flag EVERY never-cited
 * page as ambiguous forever; since the pool is dominated by never-cited pages, that pins every
 * query to kMax and kills the cost lever. The asymmetry of the Wilson interval near 0 and 1 is
 * exactly what lets us tell "confidently uncited" (resolved) from "don't know yet" (unresolved).
 *
 * Strict inequalities matter at the calibration boundary: 0/4 → {0, 0.490} has `ci_high = 0.490 <
 * 0.5`, so it does NOT straddle and resolves at K=4; 4/4 → {0.510, 1.0} has `ci_low = 0.510 >
 * 0.5`, also resolved. Both are the spec's "resolved at K=4" rows.
 *
 * @returns `true` if any in-focus aggregate straddles τ; `false` for an empty list (nothing to be
 *   uncertain about) and when every in-focus aggregate is resolved.
 */
export function anyAmbiguous(aggs: MeasurementAggregate[], opts?: AmbiguityOpts): boolean {
  const threshold = opts?.threshold ?? DEFAULT_THRESHOLD;

  // Build the focus set once (normalized) when provided. `undefined` ⇒ no filter (all pages drive
  // the decision). An explicitly-empty array yields an empty set ⇒ no page is in focus ⇒ false.
  const focus =
    opts?.focusDomains === undefined
      ? undefined
      : new Set(opts.focusDomains.map((d) => normalizeDomain(d)).filter((d) => d !== ""));

  for (const agg of aggs) {
    if (focus !== undefined && !focus.has(normalizeDomain(agg.page_url))) continue; // out of focus
    if (agg.ci_low < threshold && threshold < agg.ci_high) return true; // straddles τ → unresolved
  }
  return false;
}

export interface AdaptiveResult {
  /** All run-level rows across every engine that ran (each engine's K repeats concatenated). */
  rows: MeasurementRow[];
  /** Final per-(query, page, engine) aggregates over those rows. */
  aggregates: MeasurementAggregate[];
  /** Final K reached per engine. Present ONLY for engines that completed at least one run. */
  perEngineK: Partial<Record<Engine, number>>;
  /** Engines whose adapter threw — recorded, never re-thrown, so other engines still finish. */
  failures: Array<{ engine: Engine; error: string }>;
}

/** Extract a human-readable message from an unknown thrown value (mirrors dispatch.ts). */
function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * Adaptively measure one query across its `target_engines`, extending K per engine until that
 * engine's pages resolve about τ (or it hits `kMax`). The adaptive UNIT is (query, engine), NOT
 * (query, page): one query call labels the ENTIRE candidate pool at once, so you cannot sample a
 * single page more without re-running the whole query. Therefore we extend K while ANY in-focus
 * page on that engine is still ambiguous, and stop the whole engine when none are.
 *
 * Per-engine isolation is a correctness requirement, not a nicety:
 *  - Engines are looped INDEPENDENTLY. One engine's adapter throwing lands in `failures` and never
 *    stops the others — and contributes no rows, no aggregate, no `perEngineK` entry.
 *  - The convergence decision for an engine reads ONLY that engine's own rows (a private buffer),
 *    never a merged pool — cross-engine citation overlap is ~11%, so a different engine's
 *    ambiguity must not keep this engine sampling (and vice-versa).
 *
 * Skip rules mirror dispatch's: an engine with no adapter, or no/empty API key, is simply absent
 * from the results (no call, no failure, no `perEngineK` entry).
 *
 * Loop per runnable engine, run index 0,1,2,…:
 *  1. Call `registry[engine]` DIRECTLY with `query.text` (not `dispatchQuery`, so already-converged
 *     engines are never re-run as a side effect of fanning the whole query out again).
 *  2. Append `buildLabeledRows({ query, engineResult, candidatePool, ts, runIdx })` to this
 *     engine's buffer.
 *  3. Once `runIdx + 1 >= kInitial`, stop this engine if `!anyAmbiguous(thisEngineAggregates,
 *     { threshold, focusDomains })`. Hard cap at `kMax`.
 *
 * @returns Concatenated rows/aggregates across engines that ran, per-engine final K, and the list
 *   of engines that threw. Aggregates are recomputed once at the end from the surviving rows.
 */
export async function measureAdaptive(params: {
  query: QueryRecord;
  candidatePool: CandidatePage[];
  registry: EngineRegistry;
  apiKeys: Partial<Record<Engine, string>>;
  ts: number;
  kInitial?: number;
  kMax?: number;
  threshold?: number;
  focusDomains?: string[];
  model?: string;
  fetchImpl?: typeof fetch;
}): Promise<AdaptiveResult> {
  const {
    query,
    candidatePool,
    registry,
    apiKeys,
    ts,
    kInitial = DEFAULT_K_INITIAL,
    kMax = DEFAULT_K_MAX,
    threshold = DEFAULT_THRESHOLD,
    focusDomains,
    model,
    fetchImpl,
  } = params;

  const rows: MeasurementRow[] = [];
  const perEngineK: Partial<Record<Engine, number>> = {};
  const failures: Array<{ engine: Engine; error: string }> = [];

  // Loop engines independently. We `await` each engine in turn for deterministic, simple per-engine
  // isolation — a throw is caught here and confined to `failures`; the for-loop carries on. (The
  // engines have no shared state, so sequential vs concurrent is a behavior-neutral choice; we pick
  // sequential for a stable row order and the clearest isolation boundary.)
  for (const engine of query.target_engines) {
    const adapter = registry[engine];
    if (!adapter) continue; // no adapter registered → skipped, mirrors dispatch (no call/failure)
    const apiKey = apiKeys[engine];
    if (!apiKey) continue; // no/empty api key → skipped

    // Private per-engine buffer: the convergence decision reads ONLY these rows so a different
    // engine's ambiguity can never keep THIS engine sampling.
    const engineRows: MeasurementRow[] = [];

    try {
      for (let runIdx = 0; runIdx < kMax; runIdx++) {
        // Call the adapter DIRECTLY (not dispatchQuery) with the query TEXT.
        const engineResult = await adapter({ query: query.text, apiKey, model, fetchImpl });

        engineRows.push(
          ...buildLabeledRows({ query, engineResult, candidatePool, ts, runIdx }),
        );

        // Once we have at least kInitial repeats, stop as soon as no in-focus page straddles τ.
        // `runIdx + 1` is the count of completed runs.
        if (runIdx + 1 >= kInitial) {
          const engineAggs = aggregateRuns(engineRows);
          if (!anyAmbiguous(engineAggs, { threshold, focusDomains })) break;
        }
      }

      // Engine completed (converged or hit kMax). Commit its rows and record the K it reached.
      // perEngineK is set ONLY on successful completion — never eagerly — so a thrown engine has
      // no entry. We derive K from distinct run indices rather than row count (a multi-page pool
      // yields several rows per run).
      rows.push(...engineRows);
      perEngineK[engine] = new Set(engineRows.map((r) => r.run_idx)).size;
    } catch (reason) {
      // Per-engine isolation: this engine threw mid-run. Record it and move on; do NOT commit its
      // partial rows and do NOT set a perEngineK entry. Other engines are unaffected.
      failures.push({ engine, error: errorMessage(reason) });
    }
  }

  // Recompute aggregates once over the committed rows. aggregateRuns groups on the full
  // (query, page, engine) triple, so per-engine separation is preserved automatically.
  const aggregates = aggregateRuns(rows);

  return { rows, aggregates, perEngineK, failures };
}
