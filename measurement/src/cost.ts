// P2·1 artifact — OpenAI Responses + web_search cost posture.
// Source: docs/ARCHITECTURE.md §4.2 (cost table) and §11 (cost architecture).
// Consumed later by P2·6 budget caps / graceful degradation.

export const OPENAI_WEB_SEARCH_COST = {
  /** Base rate: $10 per 1,000 web_search tool calls ⇒ $0.01 / call. */
  perToolCallUSD: 0.01,
  /** Each web_search call fans out to multiple sub-searches (community-confirmed ~2–3×).
   *  Budget conservatively at 2× — under-budgeting here mis-calibrates the Phase-6 cost guards. */
  subSearchMultiplier: 2,
  /** ~8k input tokens are billed per call on top of the per-call fee (noted for token budgeting). */
  inputTokensPerCall: 8000,
} as const;

/**
 * Estimate the USD cost of measuring queries on OpenAI web_search.
 * @param numQueries        number of distinct queries
 * @param repeatsPerQuery   K-repeats per query (default 1)
 * @param multiplier        sub-search multiplier (default = the conservative 2×)
 */
export function estimateOpenAIQueryCostUSD(
  numQueries: number,
  repeatsPerQuery = 1,
  multiplier: number = OPENAI_WEB_SEARCH_COST.subSearchMultiplier,
): number {
  return numQueries * repeatsPerQuery * OPENAI_WEB_SEARCH_COST.perToolCallUSD * multiplier;
}

// ---------------------------------------------------------------------------
// P2·3 Part C — adaptive cost integration.
//
// Adaptive sampling (src/sampling/adaptive.ts) lets K vary per (query, engine):
// clear pages resolve at K≈4, only genuine mid-rate pages climb to kMax. So the
// up-front estimate (which assumes a uniform K) no longer prices what actually ran.
// These two helpers close that gap: realizedCostUSD prices the OBSERVED call count,
// and adaptiveSavingsUSD contrasts it with the naive fixed-kMax sweep to produce the
// demo's "adaptive saved X%" headline.
// ---------------------------------------------------------------------------

/**
 * Realized cost given the ACTUAL number of engine calls made.
 *
 * Each engine call is one OpenAI web_search tool call, billed at `perToolCallUSD`
 * and fanned out by the sub-search `multiplier`. Because adaptive K varies, the
 * caller must pass the count of calls it truly issued rather than a K×queries product.
 *
 * @param numEngineCalls total adapter/engine calls issued across the sweep
 * @param multiplier     sub-search multiplier (default = the conservative 2×)
 */
export function realizedCostUSD(
  numEngineCalls: number,
  multiplier: number = OPENAI_WEB_SEARCH_COST.subSearchMultiplier,
): number {
  return numEngineCalls * OPENAI_WEB_SEARCH_COST.perToolCallUSD * multiplier;
}

/**
 * Savings of adaptive sampling vs a naive fixed-kMax sweep.
 *
 * The naive baseline runs every (query, engine) the full `kMax` times, so its cost is
 * `numQueries × numEngines × kMax` calls priced through `realizedCostUSD`. The actual
 * cost prices the calls adaptive truly issued (`actualCalls`). `savedPct` is guarded
 * against division-by-zero (e.g. an empty sweep) so it returns 0 rather than NaN —
 * the demo string formats this directly and must never render "NaN%".
 *
 * @param numQueries number of distinct queries in the sweep
 * @param numEngines number of target engines per query
 * @param kMax       the fixed K the naive baseline would have used
 * @param actualCalls total engine calls adaptive actually made
 * @param multiplier sub-search multiplier (default = the conservative 2×); applied
 *                   identically to both sides so the ratio is multiplier-invariant
 */
export function adaptiveSavingsUSD(params: {
  numQueries: number;
  numEngines: number;
  kMax: number;
  actualCalls: number;
  multiplier?: number;
}): { fixedCostUSD: number; actualCostUSD: number; savedUSD: number; savedPct: number } {
  const multiplier = params.multiplier ?? OPENAI_WEB_SEARCH_COST.subSearchMultiplier;
  const fixedCalls = params.numQueries * params.numEngines * params.kMax;
  const fixedCostUSD = realizedCostUSD(fixedCalls, multiplier);
  const actualCostUSD = realizedCostUSD(params.actualCalls, multiplier);
  const savedUSD = fixedCostUSD - actualCostUSD;
  const savedPct = fixedCostUSD > 0 ? (savedUSD / fixedCostUSD) * 100 : 0;
  return { fixedCostUSD, actualCostUSD, savedUSD, savedPct };
}
