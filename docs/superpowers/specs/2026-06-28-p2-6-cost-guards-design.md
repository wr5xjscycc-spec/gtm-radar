# P2·6 — Cost guards, reliability & drift detection (design/spec)

**Date:** 2026-06-28 · **Lane:** P2 (Measurement) · **Branch:** `p2/phase-6-cost-guards` (off `p2/phase-4-label-quality`)
**Status:** approved direction; implementation contract for the build workflow.

## Goal

Phase card P2·6 DoD: **a full sweep stays in budget, survives an engine failing, and flags any model-version change mid-sweep.** Per-engine isolation is already done (dispatch `allSettled`, adaptive `failures[]`). This phase adds: retry/backoff, model-drift detection, a budget guard, and a **resumable sweep** that ties them together.

**Budget posture = PAUSE-THEN-CONTINUE (user decision), not degrade.** When the ceiling can't fit the next query, the sweep pauses cleanly and returns a resumable checkpoint; a later invocation with that checkpoint + a fresh budget window continues the remaining queries. Every persisted query is full-quality (full K, all engines) — we spread work across budget windows rather than degrade rows. The query is the atomic unit: it runs fully or not at all (never half-measured).

Buildable now with `OPENAI_API_KEY` already in `.env`. No new keys.

## Non-negotiables

- **Pure / injectable.** No real network or clock in tests — `sleep` is injected into retry; the registry/adapters are injected into the sweep (fakes in tests).
- **Per-engine, never merged.** Drift and coverage are per-engine.
- **Never overrun the ceiling.** Budget is checked BEFORE starting a query using a worst-case reservation (see budget.ts). Conservative by design — a cap that can be exceeded is not a cap.
- **Surface, don't bury.** Drift, failures, and paused/skipped queries are returned explicitly.
- **Style:** match `measurement.ts` / `adaptive.ts` (heavy "why" doc-comments, `export function`, pure, no classes — stateful guard is a closure-over-locals object literal, not a class). **TDD**, test file first.

## Inputs (existing — do not modify)

`MeasurementRow`, `Engine` (types.ts) · `QueryRecord`, `CandidatePage` (contract-records.ts) · `measureAdaptive`, `AdaptiveResult` (sampling/adaptive.ts) · `aggregateRuns` (stats/aggregate.ts) · `EngineRegistry`, `EngineAdapter` (dispatch.ts) · `realizedCostUSD` (cost.ts).

---

## Module 1 — `src/reliability/retry.ts`

```ts
export interface RetryOpts {
  maxRetries?: number;       // default 3 (so up to 4 attempts total)
  baseDelayMs?: number;      // default 500
  factor?: number;           // backoff multiplier, default 2 → 500,1000,2000
  maxDelayMs?: number;       // optional cap per delay
  isRetryable?: (e: unknown) => boolean; // default: 429 / 5xx / network-ish
  sleep?: (ms: number) => Promise<void>; // injected; default real setTimeout
}
export function defaultIsRetryable(e: unknown): boolean; // matches 429, 5xx, ECONNRESET/ETIMEDOUT/"fetch failed"
export async function withRetry<T>(fn: () => Promise<T>, opts?: RetryOpts): Promise<T>;
```

`withRetry` calls `fn`; on throw, if `isRetryable(e)` and attempts remain, `await sleep(delay)` then retry; else rethrow the last error. Delay for retry `n` (0-based) = `min(maxDelayMs ?? ∞, baseDelayMs * factor**n)`. No randomness (deterministic for tests — do not use `Math.random`). `defaultIsRetryable` inspects `error.message` / `error.code` (the OpenAI adapter throws `Error("OpenAI Responses API error 429: …")`, so a `\b429\b` / `\b5\d\d\b` message match is the contract).

**Tests** (`tests/reliability/retry.test.ts`, injected `sleep` recording its args — instant):
- success first try → 0 sleeps, returns value.
- throws 429 twice then succeeds → 2 sleeps `[500,1000]`, returns value.
- always-429 → rethrows after `maxRetries`, sleeps `[500,1000,2000]` (3 sleeps at default).
- non-retryable error (e.g. `Error("400 bad request")`) → throws immediately, 0 sleeps.
- `maxDelayMs` caps the schedule; custom `factor`/`baseDelayMs` honored.
- `defaultIsRetryable`: 429/500/503/"fetch failed"/ECONNRESET → true; 400/401/404 → false.

---

## Module 2 — `src/quality/drift.ts`

```ts
export interface DriftedGroup { query_id: string; engine: Engine; versions: string[]; } // >1 version in one group
export interface EngineVersions { engine: Engine; versions: string[]; }                  // distinct across the sweep
export interface DriftReport {
  hasDrift: boolean;            // any drifted group
  driftedGroups: DriftedGroup[]; // (query,engine) groups whose run rows span >1 model_version
  perEngine: EngineVersions[];   // distinct model_versions seen per engine across all rows
}
export function detectModelDrift(rows: MeasurementRow[]): DriftReport;
```

The dangerous case is **mid-group drift**: aggregating P_cited over rows from two different `model_version`s mixes pre/post-update measurements. Group by `(query_id, engine)`; collect distinct `model_version`s (stable first-seen order); a group with >1 is drifted. `perEngine` lists distinct versions per engine across the whole sweep (cross-sweep visibility). Empty rows → `{ hasDrift:false, [], [] }`. Per-engine, never merged.

**Tests** (`tests/quality/drift.test.ts`): single version everywhere → no drift; one (query,engine) with 2 versions → that group in `driftedGroups`, `hasDrift` true; two engines each one version → no drift but both in `perEngine`; version order is first-seen; empty → no drift.

---

## Module 3 — `src/cost/budget.ts`

```ts
export interface BudgetGuard {
  spentUSD(): number;
  remainingUSD(): number;
  record(numEngineCalls: number): void;       // adds realizedCostUSD(calls)
  canAfford(numEngineCalls: number): boolean;  // would spent + cost stay <= ceiling?
}
export function makeBudgetGuard(opts: { ceilingUSD: number; multiplier?: number }): BudgetGuard;
// Worst-case calls for one query at the budget-reservation K (queries × never exceeds this).
export function worstCaseCalls(numEngines: number, kForBudget: number): number; // = numEngines * kForBudget
```

Closure over a private `spent` accumulator (no class). `canAfford(n)` is `spent + realizedCostUSD(n, multiplier) <= ceilingUSD` (inclusive — landing exactly on the ceiling is allowed). `record` clamps nothing; the sweep only ever records what `canAfford` cleared, so the ceiling holds.

**Tests** (`tests/cost/budget.test.ts`): record accumulates spend; `canAfford` true below/at ceiling, false above; `remainingUSD`; multiplier applied; `worstCaseCalls(3,8)===24`.

---

## Module 4 — `src/sweep.ts` (the integration — resumable, pausable)

```ts
export interface SweepCheckpoint {
  completedQueryIds: string[];  // queries fully measured so far (across all windows)
  totalSpentUSD: number;        // cumulative across windows (reporting)
}
export interface SweepResult {
  status: "complete" | "paused";
  rows: MeasurementRow[];                 // this window's rows
  aggregates: MeasurementAggregate[];     // aggregateRuns(rows)
  coverage: { completed: string[]; remaining: string[]; paused: boolean };
  windowSpentUSD: number;                 // spend THIS invocation (<= ceiling)
  drift: DriftReport;
  failures: Array<{ engine: Engine; error: string; query_id: string }>;
  checkpoint: SweepCheckpoint;            // pass back into runSweep to continue
}

export function runSweep(params: {
  queries: QueryRecord[];
  poolFor: (query: QueryRecord) => CandidatePage[]; // per-query candidate pool (P3's job; injected)
  registry: EngineRegistry;
  apiKeys: Partial<Record<Engine, string>>;
  ts: number;
  budgetCeilingUSD: number;                 // ceiling for THIS window
  kInitial?: number; kMax?: number;         // forwarded to measureAdaptive (defaults 3 / 8)
  kForBudget?: number;                      // worst-case K reserved per query, default kMax
  threshold?: number; focusDomains?: string[]; model?: string; fetchImpl?: typeof fetch;
  retry?: RetryOpts | false;                // wrap each adapter in withRetry; false = no retry
  resumeFrom?: SweepCheckpoint;             // continue a paused sweep
}): Promise<SweepResult>;
```

Algorithm:
1. `remaining = resumeFrom ? queries.filter(q => !completedQueryIds.includes(q.id)) : queries` (preserve order).
2. Wrap each adapter in the registry with `withRetry(() => adapter(args), retryOpts)` unless `retry === false` → a retry-registry passed to `measureAdaptive`.
3. `guard = makeBudgetGuard({ ceilingUSD: budgetCeilingUSD, multiplier })`.
4. For each query in `remaining`, in order:
   - `reserve = worstCaseCalls(numTargetEnginesWithKeyAndAdapter, kForBudget ?? kMax)`.
   - If `!guard.canAfford(reserve)` → **PAUSE**: stop the loop (do not start this query). Everything from here stays in `remaining`.
   - Else run `measureAdaptive(...)`; `guard.record(sum(perEngineK))`; append rows; tag each failure with `query_id`; mark the query completed.
5. `status = (all remaining processed) ? "complete" : "paused"`. `coverage.paused = status === "paused"`.
6. `drift = detectModelDrift(rows)` (this window's rows; caller can re-run over the union if desired).
7. `checkpoint = { completedQueryIds: [...prior, ...thisWindowCompleted], totalSpentUSD: (resumeFrom?.totalSpentUSD ?? 0) + windowSpentUSD }`.

**Never overruns:** a query starts only if its worst-case (kMax-reserved) cost fits remaining budget; adaptive almost always comes in under that. `kForBudget` lets a caller trade reservation conservatism for fewer pauses (default kMax = hard guarantee).

**Tests** (`tests/sweep.test.ts`, fake registry — no network, instant injected sleep):
- budget large enough for all queries → `status:"complete"`, all in `coverage.completed`, `remaining:[]`.
- budget that fits exactly 2 of 3 queries → `status:"paused"`, 2 completed + 1 remaining, `windowSpentUSD <= ceiling` (assert no overrun).
- resume: feed the paused `checkpoint` back with a fresh ceiling → the 3rd query runs, `status:"complete"`, `checkpoint.totalSpentUSD` = sum of both windows.
- an adapter that throws every time → its failure recorded (tagged with query_id), sweep continues to next query, coverage still marks the query completed (it ran; the engine just failed — per-engine isolation).
- retry recovery: an adapter that fails once (429) then succeeds → `withRetry` recovers it via injected sleep; query completes with rows.
- drift: a fake adapter that returns a different `model_version` on different queries → `result.drift.perEngine` shows both; a within-(query,engine) change shows in `driftedGroups`.
- per-engine separation preserved end-to-end.

---

## Verification (final gate — human)

1. `npm run typecheck` clean.
2. `npm test` — prior 144 + new green.
3. Optional live capstone: a tiny 2-query sweep with a low `budgetCeilingUSD` to watch a real pause + resume (uses `OPENAI_API_KEY`; ~$0.10–0.30).

## File manifest (all NEW) — build order

| File | Phase | Depends on |
|---|---|---|
| `src/reliability/retry.ts` + test | Foundation | — |
| `src/quality/drift.ts` + test | Foundation | types |
| `src/cost/budget.ts` + test | Foundation | cost (realizedCostUSD) |
| `src/sweep.ts` + test | Integration | retry, budget, drift, adaptive, aggregate, dispatch types |

Foundation modules are mutually independent → 3 parallel TDD agents. `sweep.ts` depends on all three → runs after. Each agent runs only its own test file; project-wide typecheck + full suite at the end.
