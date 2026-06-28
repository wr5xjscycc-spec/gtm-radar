// P2·6 Module 4 — the resumable, pausable sweep (the integration).
//
// WHY THIS EXISTS: the prior three modules each guarantee one property — retry absorbs transient
// blips, drift surfaces a model rollover, the budget guard refuses to overrun. This module is the
// seam that runs a full sweep with ALL THREE in force at once, and adds the policy the design
// chose for the budget posture: PAUSE-THEN-CONTINUE, not degrade. When the ceiling can't fit the
// NEXT query's worst case, the sweep stops cleanly and hands back a resumable checkpoint; a later
// invocation with that checkpoint + a fresh budget window finishes the rest. Every persisted query
// is full-quality (full adaptive K, all its engines) — we spread work across windows rather than
// water down rows.
//
// THE QUERY IS THE ATOMIC UNIT. A query runs fully or not at all (never half-measured), and it
// starts ONLY if its worst-case reservation fits the remaining budget. That ordering — reserve the
// max BEFORE starting, record the actual (≤ reserve) AFTER — is the whole reason the ceiling holds:
// "a cap that can be exceeded is not a cap." Adaptive almost always comes in under the kMax
// reservation, so the recorded spend trails the reserve and the guarantee is conservative by design.
//
// Pure / injectable throughout: no real network, no real clock. The registry/adapters are injected
// (fakes in tests); `sleep` is injected into retry. Per-engine, never merged — drift, failures, and
// coverage are all reported per the units the lower modules already keep separate.

import type { Engine, MeasurementRow } from "./types";
import type { QueryRecord, CandidatePage } from "./contract-records";
import type { EngineRegistry, EngineAdapter } from "./dispatch";
import { measureAdaptive } from "./sampling/adaptive";
import { aggregateRuns, type MeasurementAggregate } from "./stats/aggregate";
import { makeBudgetGuard, worstCaseCalls } from "./cost/budget";
import { detectModelDrift, type DriftReport } from "./quality/drift";
import { withRetry, type RetryOpts } from "./reliability/retry";

/** Default hard cap on per-engine repeats — mirrors adaptive.ts so the reservation matches reality. */
const DEFAULT_K_MAX = 8;
/** Default initial repeats before convergence is allowed — forwarded to measureAdaptive. */
const DEFAULT_K_INITIAL = 3;

/**
 * A resumable checkpoint. Pass it back into {@link runSweep} as `resumeFrom` to continue a paused
 * sweep in a fresh budget window. Both fields are CUMULATIVE across every window run so far.
 */
export interface SweepCheckpoint {
  /** Queries fully measured so far, across all windows (a query the sweep already completed). */
  completedQueryIds: string[];
  /** Cumulative USD spent across all windows — for reporting; the per-window cap is enforced live. */
  totalSpentUSD: number;
}

/**
 * The outcome of one sweep invocation (one budget window). `rows`/`aggregates`/`windowSpentUSD`/
 * `drift` describe THIS window; `checkpoint` is the cumulative cursor to resume from.
 */
export interface SweepResult {
  /** "complete" iff every remaining query ran; "paused" iff the budget stopped the loop early. */
  status: "complete" | "paused";
  /** This window's run-level rows (every engine's K repeats, concatenated). */
  rows: MeasurementRow[];
  /** `aggregateRuns(rows)` over this window's rows — per (query, page, engine), never merged. */
  aggregates: MeasurementAggregate[];
  /**
   * Per-query coverage for this window. `completed` are the queries THIS window finished;
   * `remaining` are the not-yet-run queries (empty iff complete); `paused` mirrors the status.
   */
  coverage: { completed: string[]; remaining: string[]; paused: boolean };
  /** Spend THIS invocation — always ≤ `budgetCeilingUSD` (the no-overrun guarantee). */
  windowSpentUSD: number;
  /** Drift over this window's rows: per-engine versions + any mid-(query,engine) drifted group. */
  drift: DriftReport;
  /** Per-engine failures, each tagged with the query_id it occurred under (surface, don't bury). */
  failures: Array<{ engine: Engine; error: string; query_id: string }>;
  /** Cumulative cursor — feed back into `runSweep` as `resumeFrom` to continue the remaining work. */
  checkpoint: SweepCheckpoint;
}

/**
 * Wrap one adapter so every call retries transient failures (via {@link withRetry}). The wrapper
 * preserves the exact `EngineAdapter` signature so the retry-registry is a drop-in for the real one
 * inside `measureAdaptive`. `retryOpts` is forwarded verbatim, so an injected instant `sleep` (in
 * tests) and the deterministic backoff schedule both flow through unchanged.
 */
function wrapAdapterWithRetry(adapter: EngineAdapter, retryOpts: RetryOpts): EngineAdapter {
  return (params) => withRetry(() => adapter(params), retryOpts);
}

/**
 * Build a retry-registry from `registry`: each adapter wrapped in `withRetry`. When `retry` is
 * `false` the original registry is returned untouched (no retry layer at all). Only target engines
 * matter downstream, but we wrap the whole registry for simplicity — `measureAdaptive` only ever
 * invokes the adapters it loops, so wrapping an unused engine is harmless.
 */
function buildRetryRegistry(registry: EngineRegistry, retry: RetryOpts | false): EngineRegistry {
  if (retry === false) return registry; // retry explicitly disabled — pass adapters through raw.
  const retryOpts = retry ?? {}; // undefined ⇒ default RetryOpts (3 retries, 500ms base, etc.).
  const wrapped: EngineRegistry = {};
  for (const engine of Object.keys(registry) as Engine[]) {
    const adapter = registry[engine];
    if (adapter) wrapped[engine] = wrapAdapterWithRetry(adapter, retryOpts);
  }
  return wrapped;
}

/**
 * Run a full sweep over `queries`, staying within `budgetCeilingUSD` for THIS window and returning
 * a resumable checkpoint. See the file header for the PAUSE-THEN-CONTINUE policy and why the
 * ceiling can never be overrun.
 *
 * Algorithm:
 *  1. `remaining` = the queries not already completed by `resumeFrom` (order preserved). A fresh
 *     sweep (no `resumeFrom`) processes all queries.
 *  2. Wrap each registry adapter in `withRetry` (unless `retry === false`) → the retry-registry the
 *     adaptive measurement actually calls.
 *  3. Open a budget guard for this window's ceiling.
 *  4. For each remaining query, IN ORDER:
 *       - reserve = worstCaseCalls(#TARGET engines with BOTH an adapter and a key, kForBudget ?? kMax).
 *         (Count only `query.target_engines` — that is all `measureAdaptive` will ever run for it —
 *         so we never over-reserve for engines that won't be touched and pause prematurely.)
 *       - If the guard can't afford that reserve → PAUSE: stop the loop without starting this query.
 *         Everything from here stays in `remaining`.
 *       - Else measure the query adaptively, record the ACTUAL engine calls (Σ perEngineK), append
 *         its rows, tag each per-engine failure with the query_id, and mark the query completed.
 *  5. status = (all remaining processed) ? "complete" : "paused".
 *  6. drift = detectModelDrift over THIS window's rows; aggregates = aggregateRuns over them.
 *  7. checkpoint = cumulative completed ids + cumulative spend (prior windows + this one).
 */
export async function runSweep(params: {
  queries: QueryRecord[];
  poolFor: (query: QueryRecord) => CandidatePage[];
  registry: EngineRegistry;
  apiKeys: Partial<Record<Engine, string>>;
  ts: number;
  budgetCeilingUSD: number;
  kInitial?: number;
  kMax?: number;
  kForBudget?: number;
  threshold?: number;
  focusDomains?: string[];
  model?: string;
  fetchImpl?: typeof fetch;
  retry?: RetryOpts | false;
  resumeFrom?: SweepCheckpoint;
}): Promise<SweepResult> {
  const {
    queries,
    poolFor,
    registry,
    apiKeys,
    ts,
    budgetCeilingUSD,
    kInitial = DEFAULT_K_INITIAL,
    kMax = DEFAULT_K_MAX,
    kForBudget,
    threshold,
    focusDomains,
    model,
    fetchImpl,
    retry,
    resumeFrom,
  } = params;

  // --- Step 1: what's left to run this window (preserve query order) ---
  // A resumed sweep skips queries already completed in a prior window; a fresh sweep runs all.
  const alreadyCompleted = new Set(resumeFrom?.completedQueryIds ?? []);
  const remaining = resumeFrom
    ? queries.filter((q) => !alreadyCompleted.has(q.id))
    : queries.slice();

  // --- Step 2: the retry-registry measureAdaptive will call ---
  const retryRegistry = buildRetryRegistry(registry, retry ?? {});

  // --- Step 3: the budget guard for THIS window. multiplier is left to its default (the
  // conservative 2× baked into cost.ts) — runSweep takes no multiplier override. ---
  const guard = makeBudgetGuard({ ceilingUSD: budgetCeilingUSD });

  // The reservation K: how many repeats per (query, engine) we PRE-CHARGE. Defaults to kMax so the
  // worst-case reservation is the hard guarantee; a caller can lower it (kForBudget) to trade
  // reservation conservatism for fewer pauses.
  const reservationK = kForBudget ?? kMax;

  const rows: MeasurementRow[] = [];
  const failures: Array<{ engine: Engine; error: string; query_id: string }> = [];
  const completedThisWindow: string[] = [];

  // --- Step 4: process queries in order; pause the instant the next worst case won't fit ---
  let paused = false;
  for (const query of remaining) {
    // Count ONLY this query's target engines that are actually runnable (adapter + key present).
    // That intersection is exactly what measureAdaptive will loop, so the reservation matches the
    // maximum work the query can do — no more (over-reserve → premature pause), no less (under-
    // reserve → overrun risk).
    const runnableTargets = query.target_engines.filter(
      (engine) => registry[engine] !== undefined && Boolean(apiKeys[engine]),
    ).length;
    const reserve = worstCaseCalls(runnableTargets, reservationK);

    // PAUSE-THEN-CONTINUE: if even the worst case won't fit, stop WITHOUT starting this query. It
    // (and everything after) stays in `remaining`. We never start a query we might not finish.
    if (!guard.canAfford(reserve)) {
      paused = true;
      break;
    }

    // Measure the query fully (full adaptive K, all its engines). Per-engine isolation lives inside
    // measureAdaptive: a thrown engine lands in its `failures` and never stops the others.
    const measured = await measureAdaptive({
      query,
      candidatePool: poolFor(query),
      registry: retryRegistry,
      apiKeys,
      ts,
      kInitial,
      kMax,
      threshold,
      focusDomains,
      model,
      fetchImpl,
    });

    // Record the ACTUAL engine calls (Σ of the per-engine final K). This is ≤ the reserve we
    // already cleared, so the running spend can never push past the ceiling.
    const actualCalls = Object.values(measured.perEngineK).reduce<number>((sum, k) => sum + (k ?? 0), 0);
    guard.record(actualCalls);

    rows.push(...measured.rows);
    // Tag each per-engine failure with the query_id so a surfaced failure traces back to its query.
    for (const f of measured.failures) {
      failures.push({ engine: f.engine, error: f.error, query_id: query.id });
    }

    // The query RAN (its engines were attempted) → it is completed, even if one engine failed.
    // Per-engine isolation: an engine failing is not a query failing.
    completedThisWindow.push(query.id);
  }

  // --- Step 5: status + coverage ---
  // `remaining` not started = the slice we never reached (only non-empty when paused).
  const notStarted = remaining.filter((q) => !completedThisWindow.includes(q.id)).map((q) => q.id);
  const status: SweepResult["status"] = paused ? "paused" : "complete";

  // --- Step 6: drift + aggregates over THIS window's rows ---
  const drift = detectModelDrift(rows);
  const aggregates = aggregateRuns(rows);

  // --- Step 7: cumulative checkpoint (prior windows + this one) ---
  const windowSpentUSD = guard.spentUSD();
  const checkpoint: SweepCheckpoint = {
    completedQueryIds: [...(resumeFrom?.completedQueryIds ?? []), ...completedThisWindow],
    totalSpentUSD: (resumeFrom?.totalSpentUSD ?? 0) + windowSpentUSD,
  };

  return {
    status,
    rows,
    aggregates,
    coverage: { completed: completedThisWindow, remaining: notStarted, paused },
    windowSpentUSD,
    drift,
    failures,
    checkpoint,
  };
}
