import type { EngineName } from "./engine";

/**
 * Estimated per-call cost by engine (from COSTS.md).
 * OpenAI web_search is the most expensive due to sub-search multiplier.
 */
export const ENGINE_COST_PER_CALL: Record<string, number> = {
  openai: 0.030,
  perplexity: 0.010,
  gemini: 0.012,
};

/** Degradation order: most expensive engine dropped first. */
export const DEGRADATION_ORDER: EngineName[] = ["openai", "perplexity", "gemini"];

export interface BudgetConfig {
  perCustomerBudget: number;
  maxEngines: number;
  baseK: number;
  maxK: number;
}

export const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  perCustomerBudget: 120,
  maxEngines: 3,
  baseK: 3,
  maxK: 8,
};

export type DegradationLevel = "none" | "reduced_k" | "dropped_engine";

export interface DegradedConfig {
  baseK: number;
  maxK: number;
  droppedEngines: EngineName[];
  activeEngines: EngineName[];
  degradationLevel: DegradationLevel;
}

export interface PerEngineSpend {
  calls: number;
  cost: number;
  errors: number;
  errorRate: number;
}

export interface SpendRecord {
  customer_id: string;
  cycle_id: string;
  totalCalls: number;
  totalCost: number;
  perEngine: Record<string, PerEngineSpend>;
  degradationLevel: DegradationLevel;
  capped: boolean;
  budgetLimit: number;
}

/**
 * Estimate the total cost of a sweep given page/engine/K counts.
 */
export function estimateSweepCost(
  pageCount: number,
  engines: EngineName[],
  baseK: number,
  maxK: number,
): number {
  const avgK = (baseK + maxK) / 2;
  const totalCalls = pageCount * engines.length * avgK;
  let totalCost = 0;
  for (const eng of engines) {
    totalCost += totalCalls / engines.length * (ENGINE_COST_PER_CALL[eng] ?? 0.03);
  }
  return totalCost;
}

/**
 * Apply budget degradation when estimated cost exceeds budget.
 *
 * Degradation order:
 *   1. Reduce K proportionally (floor at 1 baseK)
 *   2. Drop most expensive engines one by one until cost fits
 */
export function degradeForBudget(
  budget: number,
  estimatedCost: number,
  pageCount: number,
  engines: EngineName[],
  currentConfig: { baseK: number; maxK: number },
): DegradedConfig {
  if (estimatedCost <= budget) {
    return {
      baseK: currentConfig.baseK,
      maxK: currentConfig.maxK,
      droppedEngines: [],
      activeEngines: [...engines],
      degradationLevel: "none",
    };
  }

  let activeEngines = [...engines];
  let { baseK, maxK } = currentConfig;

  // Step 1: reduce K proportionally
  const ratio = Math.min(1, budget / estimatedCost);
  const newBaseK = Math.max(1, Math.round(baseK * ratio));
  const newMaxK = Math.max(newBaseK, Math.round(maxK * ratio));
  baseK = newBaseK;
  maxK = newMaxK;

  let remainingCost = estimateSweepCost(pageCount, activeEngines, baseK, maxK);

  if (remainingCost <= budget) {
    return {
      baseK,
      maxK,
      droppedEngines: [],
      activeEngines,
      degradationLevel: "reduced_k",
    };
  }

  // Step 2: drop most expensive engines until cost fits
  const sorted = [...activeEngines].sort(
    (a, b) => (ENGINE_COST_PER_CALL[b] ?? 0) - (ENGINE_COST_PER_CALL[a] ?? 0),
  );

  const dropped: EngineName[] = [];
  for (const eng of sorted) {
    if (activeEngines.length <= 1) break;
    activeEngines = activeEngines.filter((e) => e !== eng);
    dropped.push(eng);

    remainingCost = estimateSweepCost(pageCount, activeEngines, baseK, maxK);
    if (remainingCost <= budget) break;
  }

  return {
    baseK,
    maxK,
    droppedEngines: dropped,
    activeEngines,
    degradationLevel: dropped.length > 0 ? "dropped_engine" : "reduced_k",
  };
}

/**
 * Build a spend record from per-engine call/error counts.
 */
export function buildSpendRecord(
  customerId: string,
  cycleId: string,
  perEngineStats: Record<string, { calls: number; errors: number }>,
  degradationLevel: DegradationLevel,
  budgetLimit: number,
): SpendRecord {
  const perEngine: Record<string, PerEngineSpend> = {};
  let totalCalls = 0;
  let totalCost = 0;

  for (const [engine, stats] of Object.entries(perEngineStats)) {
    const cost = stats.calls * (ENGINE_COST_PER_CALL[engine] ?? 0.03);
    perEngine[engine] = {
      calls: stats.calls,
      cost,
      errors: stats.errors,
      errorRate: stats.calls > 0 ? stats.errors / stats.calls : 0,
    };
    totalCalls += stats.calls;
    totalCost += cost;
  }

  return {
    customer_id: customerId,
    cycle_id: cycleId,
    totalCalls,
    totalCost,
    perEngine,
    degradationLevel,
    capped: totalCost > budgetLimit,
    budgetLimit,
  };
}
