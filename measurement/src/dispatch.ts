// P2 (Measurement) — query→engine dispatch harness.
//
// Fans ONE QueryRecord out to its `target_engines`, calling each engine's adapter with that
// engine's API key. Engines run CONCURRENTLY with per-engine isolation: one engine throwing
// must never stop the others (forward-compatible with P2·6's K-repeats / retry layer). The
// harness itself never throws for a per-engine failure — outcomes are partitioned into
// `results` (succeeded), `skipped` (couldn't even attempt), and `failures` (attempted, threw).
//
// Adapters are injected via a registry so tests wire FAKE adapters; this module never calls the
// network on its own — the only real adapter (`runOpenAIQuery`) is referenced solely to seed
// DEFAULT_REGISTRY, and it too injects HTTP via `fetchImpl`.

import { runOpenAIQuery } from "./engines/openai";
import type { QueryRecord } from "./contract-records";
import type { Engine, EngineQueryResult } from "./types";

/**
 * An engine adapter: runs ONE grounded query and returns the engine-agnostic result.
 * Exactly the shape of `runOpenAIQuery` (see engines/openai.ts) so the real adapter and any
 * fake test double are interchangeable.
 */
export type EngineAdapter = (params: {
  query: string;
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
}) => Promise<EngineQueryResult>;

/** Map of engine → its adapter. Partial: an engine with no entry has "no adapter registered". */
export type EngineRegistry = Partial<Record<Engine, EngineAdapter>>;

/** The default wiring: only OpenAI is implemented today. Extended as P2 adds engines. */
export const DEFAULT_REGISTRY: EngineRegistry = { openai: runOpenAIQuery };

/** Why an engine was skipped before any adapter call was attempted. */
type Skip = { engine: Engine; reason: string };

/** A runnable engine: it has both an adapter and a usable API key. */
type Runnable = { engine: Engine; adapter: EngineAdapter; apiKey: string };

/** Outcome of dispatching one query across its target engines. */
export interface DispatchResult {
  /** Successful per-engine results, in `target_engines` order among the runnable engines. */
  results: EngineQueryResult[];
  /** Engines never attempted (no adapter / no api key), in `target_engines` order. */
  skipped: Skip[];
  /** Engines attempted whose adapter rejected, in `target_engines` order among the runnable. */
  failures: Array<{ engine: Engine; error: string }>;
}

/** Extract a human-readable message from an unknown thrown value. */
function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * Dispatch one query to each of its `target_engines`.
 *
 * For each engine, in `target_engines` order:
 *  - no adapter in the registry        → `skipped` with reason "no adapter registered" (no call);
 *  - adapter present but key missing/"" → `skipped` with reason "no api key" (no call);
 *  - otherwise (runnable)              → call its adapter with the query text + that engine's key.
 *
 * Runnable engines are invoked CONCURRENTLY via `Promise.allSettled`, so a rejection in one
 * engine is isolated from the rest. `results` preserves `target_engines` order among the
 * runnable engines (`allSettled` keeps input order regardless of settle timing). This function
 * never throws for a per-engine failure — such failures land in `failures`.
 *
 * @param query The query to fan out; `query.text` is sent to each adapter as `query`.
 * @param opts.apiKeys  Per-engine API keys; a missing or empty-string key skips that engine.
 * @param opts.registry Engine→adapter map; defaults to {@link DEFAULT_REGISTRY}.
 * @param opts.model     Optional model override, forwarded to every adapter.
 * @param opts.fetchImpl Optional injected fetch, forwarded to every adapter (mock in tests).
 */
export async function dispatchQuery(
  query: QueryRecord,
  opts: {
    apiKeys: Partial<Record<Engine, string>>;
    registry?: EngineRegistry;
    model?: string;
    fetchImpl?: typeof fetch;
  },
): Promise<DispatchResult> {
  const registry = opts.registry ?? DEFAULT_REGISTRY;

  const skipped: Skip[] = [];
  const runnable: Runnable[] = [];

  // Partition target engines into skipped vs runnable, preserving target_engines order.
  for (const engine of query.target_engines) {
    const adapter = registry[engine];
    if (!adapter) {
      skipped.push({ engine, reason: "no adapter registered" });
      continue;
    }
    const apiKey = opts.apiKeys[engine];
    if (!apiKey) {
      skipped.push({ engine, reason: "no api key" });
      continue;
    }
    runnable.push({ engine, adapter, apiKey });
  }

  // Run every runnable engine concurrently; allSettled isolates per-engine rejections and
  // preserves input order, so results/failures follow target_engines order among the runnable.
  const settled = await Promise.allSettled(
    runnable.map(({ adapter, apiKey }) =>
      adapter({
        query: query.text,
        apiKey,
        model: opts.model,
        fetchImpl: opts.fetchImpl,
      }),
    ),
  );

  const results: EngineQueryResult[] = [];
  const failures: Array<{ engine: Engine; error: string }> = [];

  settled.forEach((outcome, i) => {
    const { engine } = runnable[i]!;
    if (outcome.status === "fulfilled") {
      results.push(outcome.value);
    } else {
      failures.push({ engine, error: errorMessage(outcome.reason) });
    }
  });

  return { results, skipped, failures };
}
