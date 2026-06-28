/**
 * Observability — per-cycle run records & spend (owner: P1, Phase 6).
 *
 * The cost model is tight (~$100–120/cycle) and judges (and our own unit
 * economics) care that spend is VISIBLE, not hidden. This summarizes the run
 * records P2 emits (queries issued, calls made, $ spend, per-engine error rates)
 * into the ops view. Pure + unit-tested.
 */

export interface RunRecord {
  cycle_id: string;
  workspace_id: string;
  queries_issued: number;
  calls_made: number;
  spend_usd: number;
  per_engine: Record<string, { calls: number; errors: number }>;
  ts: number;
}

export const CYCLE_BUDGET_USD = 120;

/** Roll run records into an ops summary, with a budget-health flag. */
export function opsSummary(
  runs: RunRecord[],
  budget = CYCLE_BUDGET_USD,
): {
  cycles: number;
  total_spend: number;
  total_calls: number;
  total_queries: number;
  avg_spend_per_cycle: number;
  per_engine_error_rate: Record<string, number>;
  over_budget_cycles: number;
  within_budget: boolean;
} {
  const cycles = runs.length;
  const total_spend = runs.reduce((s, r) => s + r.spend_usd, 0);
  const total_calls = runs.reduce((s, r) => s + r.calls_made, 0);
  const total_queries = runs.reduce((s, r) => s + r.queries_issued, 0);

  const engineCalls: Record<string, number> = {};
  const engineErrors: Record<string, number> = {};
  for (const r of runs) {
    for (const [e, v] of Object.entries(r.per_engine)) {
      engineCalls[e] = (engineCalls[e] ?? 0) + v.calls;
      engineErrors[e] = (engineErrors[e] ?? 0) + v.errors;
    }
  }
  const per_engine_error_rate: Record<string, number> = {};
  for (const e of Object.keys(engineCalls)) {
    per_engine_error_rate[e] = engineCalls[e] === 0 ? 0 : engineErrors[e] / engineCalls[e];
  }

  const over_budget_cycles = runs.filter((r) => r.spend_usd > budget).length;
  return {
    cycles,
    total_spend: round2(total_spend),
    total_calls,
    total_queries,
    avg_spend_per_cycle: cycles === 0 ? 0 : round2(total_spend / cycles),
    per_engine_error_rate,
    over_budget_cycles,
    within_budget: over_budget_cycles === 0,
  };
}

/** Budget health for a single in-flight cycle (drives the ops gauge). */
export function budgetHealth(
  spend: number,
  budget = CYCLE_BUDGET_USD,
): { pct: number; status: "ok" | "warn" | "over" } {
  const pct = budget === 0 ? 0 : spend / budget;
  const status = pct >= 1 ? "over" : pct >= 0.8 ? "warn" : "ok";
  return { pct: round2(pct), status };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
