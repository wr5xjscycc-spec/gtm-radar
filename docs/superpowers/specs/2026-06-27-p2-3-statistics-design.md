# P2·3 — Statistics layer + one-key three-engine backing (design/spec)

**Date:** 2026-06-27 · **Lane:** P2 (Measurement) · **Branch base:** `p1/phase-0-thin-slice`
**Status:** approved direction; this doc is the implementation contract for the build workflow.

## Goal

Deliver the P2·3 measurement deliverable — **P(cited) + confidence interval + position weight per (query, page, engine), produced over K adaptive repeats** — and make the full 3-engine pipeline runnable end-to-end from a **single OpenAI key** by backing the `perplexity` and `gemini` engine *slots* with OpenAI models (different model per slot so the numbers genuinely diverge).

Out of scope (deferred): real Perplexity/Gemini adapters (no keys yet); Convex persistence (deprioritized); budget caps / drift detection (P2·6).

## Non-negotiables carried from the lane

- **Per-engine, never merged.** `engine` is part of every aggregate group key. Cross-engine overlap is ~11%; merging is a correctness bug.
- **Pure functions, injected I/O.** Stats/aggregation/decision are pure (no network, no clock passed implicitly — `ts` is a param). Engine calls go through the injected registry so CI never hits the network.
- **Wilson, not normal approximation.** At K=3 near 0/1 the normal approx is wrong; Wilson is correct in our regime.
- **Style:** match the existing files (heavy doc-comments explaining *why*, defensive on bad input, `export function`, no classes). See `measurement.ts` / `labeling.ts` as exemplars.
- **TDD:** every module ships with its test file, written test-first, green before the module is "done".

---

## Part A — One-key three-engine backing

The real adapter `runOpenAIQuery` (engines/openai.ts) hardcodes `engine: "openai"` and already accepts a `model`. **Do not edit `openai.ts`.** Wrap it.

### New file: `src/engines/openai-backed.ts`

```ts
export const ENGINE_MODELS: Record<Engine, string> = {
  openai: "gpt-5",
  perplexity: "gpt-5-mini",   // OpenAI-backed STAND-IN until a real Perplexity key arrives
  gemini: "gpt-5-nano",       // OpenAI-backed STAND-IN until a real Gemini key arrives
};

// Wraps runOpenAIQuery, binds the model, and OVERRIDES the engine label so per-engine
// separation works. model_version stays the REAL OpenAI model the API returns (so the
// stand-in is self-evident in the data and drift detection stays real).
export function makeOpenAIBackedAdapter(opts: { engine: Engine; model: string }): EngineAdapter;

// All three slots wired to OpenAI-backed adapters with ENGINE_MODELS.
export function buildOpenAIBackedRegistry(): EngineRegistry;

// Spread one OpenAI key across all three slots for dispatch/adaptive apiKeys.
export function spreadOpenAIKey(key: string): Partial<Record<Engine, string>>;
```

`makeOpenAIBackedAdapter` returns an `EngineAdapter` (dispatch.ts signature) that calls `runOpenAIQuery({ query, apiKey, model: opts.model, fetchImpl })` and returns `{ ...result, engine: opts.engine }`.

**Tests** (`tests/engines/openai-backed.test.ts`, reuse the captured fixture `tests/fixtures/openai-responses-web_search.json` via a fake `fetchImpl`):
- adapter stamps the **overridden** engine label (perplexity/gemini), not "openai".
- `model_version` is the real value from the response, **not** the bound model id.
- citations parse identically to the direct adapter (same fixture → same citations).
- `buildOpenAIBackedRegistry()` has all three engines; each is callable.
- `spreadOpenAIKey("k")` → `{ openai:"k", perplexity:"k", gemini:"k" }`.

**Smoke test (live, NOT in CI — run by the human after the workflow):** one call per model id confirming the Responses `web_search` tool returns `url_citation`. If a model id rejects the tool, fall back is noted in the handoff; the constant is the only thing to change.

---

## Part B — Statistics core

### New file: `src/stats/wilson.ts`

```ts
// Wilson score interval for a binomial proportion. z defaults to 1.96 (95%).
// n === 0 → { low: 0, high: 1 } (maximal uncertainty, never NaN).
// Clamps to [0,1]. successes is clamped to [0, n].
export function wilsonInterval(successes: number, n: number, z?: number): { low: number; high: number };
```

**Tests** (`tests/stats/wilson.test.ts`): 0/3 (low=0, high<1), 3/3 (high=1, low<1), 1/3 straddles 0.5, n=0 → {0,1}; interval always within [0,1]; wider z widens the interval; a known reference value (e.g. 5/10 @ z=1.96 ≈ {0.237, 0.763}, tolerance 1e-3).

### New file: `src/stats/aggregate.ts`

```ts
export interface MeasurementAggregate {
  query_id: string;
  page_url: string;
  engine: Engine;
  model_version: string;   // from the rows (last-writer / consistent across runs)
  k: number;               // number of run-level rows in the group
  cited_count: number;
  p_cited: number;         // cited_count / k
  ci_low: number;
  ci_high: number;
  position_weight: number; // see below
}

// Group MeasurementRow[] by (query_id, page_url, engine); one aggregate per group.
export function aggregateRuns(rows: MeasurementRow[]): MeasurementAggregate[];
```

- `p_cited = cited_count / k`; CI from `wilsonInterval(cited_count, k)`.
- **position_weight** = mean reciprocal rank (`1/position`) over the **cited runs only**; `0` when never cited. This is a pure "*when cited, how high*" signal, deliberately **orthogonal to `p_cited`** (which already carries frequency — don't fold frequency in twice). Cited at #1 in 2 of 3 runs → 1.0; cited once at #1 and once at #3 → 0.667; never cited → 0.
- Grouping is **stable** (first-seen order). `(query_id, page_url, engine)` is the full key — same query+page on a different engine is a separate aggregate.

**Tests** (`tests/stats/aggregate.test.ts`): groups K rows into one aggregate with correct k/cited_count/p_cited; CI matches `wilsonInterval`; position_weight math (cited@#1 in 2 of 3 runs → 1.0; cited@#1 once + @#3 once → 0.667; uncited → 0); **same query+page, two engines → two aggregates** (per-engine invariant); empty input → `[]`.

### New file: `src/sampling/adaptive.ts`

**Pure decision fn:**
```ts
export interface AmbiguityOpts {
  threshold?: number;       // decision boundary τ, default 0.5
  focusDomains?: string[];  // if set, only pages whose normalized domain ∈ this set drive
                            // the decision (the customer's own page is what the demo/model
                            // care about); default: ALL pages in the pool.
}
// A page is UNRESOLVED iff its Wilson CI STRADDLES τ: ci_low < τ < ci_high — we still
// can't say which side of the boundary it's on. Returns true if ANY in-focus aggregate
// is unresolved.
//
// CRITICAL: do NOT use symmetric CI width. At τ=0.5 a confidently-uncited page (0/8 →
// {0,0.324}) and a confidently-cited page both RESOLVE despite width > 0.3, while a
// never-cited page at K=3 ({0,0.561}, width 0.56) is correctly still unresolved. A width
// threshold flags every never-cited page forever — and the pool is dominated by never-
// cited pages by construction ("0 of N cited") — so it would pin every query to kMax and
// kill the −40–50% cost lever. The straddle rule is the whole point.
export function anyAmbiguous(aggs: MeasurementAggregate[], opts?: AmbiguityOpts): boolean;
```

**Calibration (τ=0.5, kInitial=3, kMax=8) — agents must reproduce, tests assert these:**

| outcome | Wilson CI | straddles 0.5 → extend? |
|---|---|---|
| 0/3 | {0, 0.561} | yes |
| 0/4 | {0, 0.490} | **no — resolved at K=4** |
| 3/3 | {0.438, 1.0} | yes |
| 4/4 | {0.510, 1.0} | **no — resolved at K=4** |
| 2/4 | {0.150, 0.850} | yes — coin-flip runs to kMax |

So clear pages (cited-always or never-cited) resolve at K≈4; only genuine mid-rate pages climb to kMax. In the all-uncited demo pool every query stops at K=4 ≈ 50% saving vs fixed kMax.

**Adaptive orchestration** (the −40–50% cost lever). **Decision: adaptive unit is per-(query, engine), not per-page** — one query call labels the *entire* candidate pool, so you cannot sample one page more without re-running the whole query. Extend K while *any* page in that (query, engine) is still ambiguous.

```ts
export interface AdaptiveResult {
  rows: MeasurementRow[];                 // all run-level rows, all engines
  aggregates: MeasurementAggregate[];     // final per-(query,page,engine) aggregates
  perEngineK: Partial<Record<Engine, number>>;  // final K reached per engine
  failures: Array<{ engine: Engine; error: string }>;
}

export function measureAdaptive(params: {
  query: QueryRecord;
  candidatePool: CandidatePage[];
  registry: EngineRegistry;
  apiKeys: Partial<Record<Engine, string>>;
  ts: number;
  kInitial?: number;   // default 3
  kMax?: number;       // default 8
  threshold?: number;       // τ, forwarded to anyAmbiguous; default 0.5
  focusDomains?: string[];  // forwarded to anyAmbiguous; default all pages
  model?: string;
  fetchImpl?: typeof fetch;
}): Promise<AdaptiveResult>;
```

Loop, **independently per target engine** (per-engine isolation — one engine throwing lands in `failures`, never stops the others):
1. Skip engines with no adapter or no key (mirror dispatch's skip rules — they just don't appear in results).
2. For run index 0,1,2,… call the engine's adapter once; append `buildLabeledRows({ query, engineResult, candidatePool, ts, runIdx })`.
3. After each run, once `runIdx + 1 >= kInitial`: if `!anyAmbiguous(thisEngineAggregates, { threshold, focusDomains })` → stop this engine. Hard cap at `kMax`.
4. Adapter calls are made directly through `registry[engine]` (not `dispatchQuery`) so converged engines aren't re-run.

**Tests** (`tests/sampling/adaptive.test.ts`, fully offline with a **fake registry** whose adapters return scripted results per call index):
- `anyAmbiguous`: 0/3 → true (straddles 0.5); 0/8 → false; 3/3 → true; 4/4 → false; 2/4 → true; empty → false; `focusDomains` restricts which pages count (an out-of-focus ambiguous page doesn't force extension).
- a **never-cited** fake engine (kInitial=3, τ=0.5) resolves at K=4 → stops before kMax (assert adapter call count === 4).
- a **coin-flip** fake engine (alternating cited/uncited, p̂≈0.5) runs to `kMax` (call count === 8).
- two engines with different convergence → different `perEngineK`, rows/aggregates kept per-engine.
- a fake engine whose adapter throws → recorded in `failures`, other engine still completes.
- rows carry the right `run_idx` sequence and the engine label from the adapter result.

---

## Part C — Cost integration

Extend `src/cost.ts` (only the cost agent touches this file):
```ts
// Realized cost given the ACTUAL number of engine calls made (adaptive K varies).
export function realizedCostUSD(numEngineCalls: number, multiplier?: number): number;
// Savings vs naive fixed-kMax across a sweep, for the demo's "adaptive saved X%" line.
export function adaptiveSavingsUSD(params: {
  numQueries: number; numEngines: number; kMax: number; actualCalls: number; multiplier?: number;
}): { fixedCostUSD: number; actualCostUSD: number; savedUSD: number; savedPct: number };
```
**Tests** appended to `tests/cost.test.ts`: realized cost = calls × perToolCall × multiplier; savings math (fixed = numQueries×numEngines×kMax×rate×mult; pct correct; zero-division guarded when fixed=0).

---

## Verification (final gate, run after all modules land)

1. `npm run typecheck` (project-wide `tsc --noEmit`) — clean.
2. `npm test` — all prior 48 **plus** the new tests green.
3. Human-run live smoke test of the 3 gen-5 model ids (Part A) — confirm `url_citation` returns; record cost.

## File manifest (all NEW except cost.ts/cost.test.ts which are appended)

| File | Owner agent | Depends on |
|---|---|---|
| `src/engines/openai-backed.ts` + `tests/engines/openai-backed.test.ts` | Foundation | openai.ts, dispatch types |
| `src/stats/wilson.ts` + `tests/stats/wilson.test.ts` | Foundation | — |
| `src/cost.ts` (append) + `tests/cost.test.ts` (append) | Foundation | existing cost.ts |
| `src/stats/aggregate.ts` + `tests/stats/aggregate.test.ts` | Aggregate | wilson, types |
| `src/sampling/adaptive.ts` + `tests/sampling/adaptive.test.ts` | Adaptive | aggregate, pipeline, dispatch types |

Each agent runs **only its own test file** (`npx vitest run <path>`) while building; the project-wide typecheck + full suite run once at the end.
