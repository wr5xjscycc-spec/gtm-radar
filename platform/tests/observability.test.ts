import { describe, it, expect } from "vitest";
import { opsSummary, budgetHealth, RunRecord, CYCLE_BUDGET_USD } from "../src/observability";

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  cycle_id: "c1", workspace_id: "ws", queries_issued: 40, calls_made: 120,
  spend_usd: 95, per_engine: { openai: { calls: 120, errors: 3 } }, ts: 1, ...over,
});

describe("opsSummary — spend is visible, budget health flagged", () => {
  it("aggregates spend/calls/queries and per-engine error rate", () => {
    const s = opsSummary([
      run({ cycle_id: "c1", spend_usd: 95, calls_made: 120, per_engine: { openai: { calls: 120, errors: 3 } } }),
      run({ cycle_id: "c2", spend_usd: 105, calls_made: 100, per_engine: { openai: { calls: 100, errors: 7 } } }),
    ]);
    expect(s.cycles).toBe(2);
    expect(s.total_spend).toBe(200);
    expect(s.avg_spend_per_cycle).toBe(100);
    expect(s.total_calls).toBe(220); // 120 + 100
    // 10 errors / 220 engine-calls
    expect(s.per_engine_error_rate.openai).toBeCloseTo(10 / 220, 4);
    expect(s.within_budget).toBe(true);
  });

  it("flags an over-budget cycle", () => {
    const s = opsSummary([run({ spend_usd: 140 })]);
    expect(s.over_budget_cycles).toBe(1);
    expect(s.within_budget).toBe(false);
  });

  it("handles empty (no divide-by-zero)", () => {
    const s = opsSummary([]);
    expect(s.avg_spend_per_cycle).toBe(0);
    expect(s.within_budget).toBe(true);
  });
});

describe("budgetHealth", () => {
  it("ok / warn / over thresholds", () => {
    expect(budgetHealth(60).status).toBe("ok");
    expect(budgetHealth(0.85 * CYCLE_BUDGET_USD).status).toBe("warn");
    expect(budgetHealth(CYCLE_BUDGET_USD).status).toBe("over");
    expect(budgetHealth(200).status).toBe("over");
  });
});
