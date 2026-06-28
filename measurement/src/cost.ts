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
