import type { EngineAdapter, EngineName, EngineResult } from "./engine";
import { ENGINE_NAMES } from "./engine";
import { parseCitations, type KnownPage, type KnownCompany } from "./parse";
import { labelMeasurements, type LabelResult, type CandidatePoolItem } from "./label";

export interface QueryRecord {
  _id: string;
  workspaceId: string;
  customer_id: string;
  vertical: string;
  text: string;
  seed_source: string;
  target_engines: string[];
}

export interface DispatchCoverage {
  total_engines: number;
  succeeded: number;
  failed: number;
  partial: boolean;
}

export interface DispatchContext {
  knownPages: KnownPage[];
  knownCompanies: KnownCompany[];
  candidatePool: CandidatePoolItem[];
}

export interface DispatchResult {
  rows: LabelResult[];
  coverage: DispatchCoverage;
}

/**
 * Map engine name → { adapter, keyEnvVar }.
 * Only includes the adapter if the env var is set (key exists).
 */
export function availableEngines(
  adapters: Record<string, EngineAdapter>,
  keyMap: Record<string, string>,
): Array<{ name: string; adapter: EngineAdapter }> {
  return Object.entries(adapters)
    .filter(([name]) => {
      const envVar = keyMap[name];
      return !envVar || !!process.env[envVar];
    })
    .map(([name, adapter]) => ({ name, adapter }));
}

/**
 * Fan-out dispatch: run each target engine, collect results.
 * One engine failing does NOT kill the run — partial coverage is flagged.
 */
export async function dispatch(
  query: QueryRecord,
  adapters: Record<string, EngineAdapter>,
  keyMap: Record<string, string>,
  context: DispatchContext,
): Promise<DispatchResult> {
  const results: LabelResult[] = [];
  const coverage: DispatchCoverage = {
    total_engines: query.target_engines.length,
    succeeded: 0,
    failed: 0,
    partial: false,
  };

  for (const engineName of query.target_engines) {
    const adapter = adapters[engineName];
    if (!adapter) {
      coverage.failed++;
      continue;
    }

    const envVar = keyMap[engineName];
    if (envVar && !process.env[envVar]) {
      coverage.failed++;
      continue;
    }

    try {
      const candidatePool = context.candidatePool;
      if (candidatePool.length === 0) {
        coverage.failed++;
        continue;
      }

      // Measure against the first candidate page's domain as target
      const targetDomain = candidatePool[0].company_domain;
      const engineResult: EngineResult = await adapter.measure(
        query.text,
        { targetDomain },
      );

      const labeled = labelMeasurements(
        query._id,
        engineResult,
        candidatePool,
      );

      results.push(labeled);
      coverage.succeeded++;
    } catch (err) {
      coverage.failed++;
    }
  }

  coverage.partial = coverage.failed > 0 && coverage.succeeded > 0;

  return { rows: results, coverage };
}
