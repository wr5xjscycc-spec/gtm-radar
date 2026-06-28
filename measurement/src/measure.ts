import type { EngineAdapter } from "./engine";
import { adaptiveSample, type AdaptiveSampleConfig, DEFAULT_ADAPTIVE_CONFIG } from "./sampler";
import { type RunRecord, type AggregateResult } from "./aggregate";

export interface MeasureQueryOptions {
  queryId: string;
  queryText: string;
  targetDomain: string;
  pageUrl: string;
  engine: "openai" | "perplexity" | "gemini";
  adapter: EngineAdapter;
  adaptiveConfig?: AdaptiveSampleConfig;
}

export interface MeasureQueryResult {
  runs: RunRecord[];
  aggregate: AggregateResult;
  didExtend: boolean;
  K: number;
}

/**
 * Measure a single (query, page) pair through the full measurement pipeline:
 *   adaptive K-repeats → P_cited + Wilson CI + position_weight.
 *
 * This is the top-level entry point for P1's Convex action to call.
 * It delegates to adaptiveSample which handles the K=3→≈8 loop.
 */
export async function measureQuery(
  options: MeasureQueryOptions,
): Promise<MeasureQueryResult> {
  const { queryId, queryText, targetDomain, pageUrl, engine, adapter } = options;
  const config = options.adaptiveConfig ?? DEFAULT_ADAPTIVE_CONFIG;

  const result = await adaptiveSample(
    queryId,
    queryText,
    targetDomain,
    pageUrl,
    engine,
    adapter,
    config,
  );

  return {
    runs: result.runs,
    aggregate: result.aggregate,
    didExtend: result.didExtend,
    K: result.runs.length,
  };
}
