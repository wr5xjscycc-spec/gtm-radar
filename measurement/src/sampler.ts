import type { EngineAdapter, EngineName, EngineResult } from "./engine";
import { normalizeDomain } from "../../convex/lib/domain";
import {
  type RunRecord,
  type AggregateResult,
  aggregateRuns,
  needsMoreSamples,
} from "./aggregate";

export interface AdaptiveSampleConfig {
  /** Base number of runs to start with. */
  baseK: number;
  /** Maximum runs to extend to. */
  maxK: number;
  /** CI span threshold — wider than this triggers extension. */
  wideThreshold: number;
}

export const DEFAULT_ADAPTIVE_CONFIG: AdaptiveSampleConfig = {
  baseK: 3,
  maxK: 8,
  wideThreshold: 0.3,
};

export interface AdaptiveSampleResult {
  runs: RunRecord[];
  aggregate: AggregateResult;
  didExtend: boolean;
  extensionCount: number;
}

/**
 * Run the adaptive sampling loop for a single (query, page) pair.
 *
 * 1. Start with `config.baseK` runs.
 * 2. Compute the aggregate (P_cited + Wilson CI).
 * 3. If CI is narrow enough AND does not straddle 0.5, stop.
 * 4. Otherwise extend up to `config.maxK` runs.
 *
 * Each run calls the engine adapter with a fresh call (no caching).
 * `run_idx` increments across the full batch.
 */
export async function adaptiveSample(
  queryId: string,
  queryText: string,
  targetDomain: string,
  pageUrl: string,
  engine: EngineName,
  adapter: EngineAdapter,
  config: AdaptiveSampleConfig = DEFAULT_ADAPTIVE_CONFIG,
): Promise<AdaptiveSampleResult> {
  const runs: RunRecord[] = [];
  const totalRuns = config.maxK;
  let didExtend = false;

  for (let i = 0; i < totalRuns; i++) {
    const result: EngineResult = await adapter.measure(queryText, {
      targetDomain,
    });

    const nd = normalizeDomain(targetDomain);
    const citedDomains = result.source_urls.map((u) => normalizeDomain(u));
    const matchedIdx = citedDomains.indexOf(nd);
    const cited = matchedIdx !== -1;

    runs.push({
      query_id: queryId,
      page_url: pageUrl,
      company_domain: targetDomain,
      engine,
      model_version: result.model_version,
      run_idx: i,
      appeared: result.appeared,
      cited,
      position: cited ? matchedIdx : null,
      source_urls: result.source_urls,
      ts: Date.now(),
    });

    // Check after baseK runs whether we need to continue
    if (i + 1 === config.baseK && i + 1 < totalRuns) {
      const partial = aggregateRuns(queryId, pageUrl, targetDomain, engine, runs);
      if (!needsMoreSamples(partial, config.wideThreshold)) {
        // Stop early — CI is tight enough
        break;
      }
      didExtend = true;
    }
  }

  const aggregate = aggregateRuns(queryId, pageUrl, targetDomain, engine, runs);

  return {
    runs,
    aggregate,
    didExtend,
    extensionCount: didExtend ? runs.length - config.baseK : 0,
  };
}
