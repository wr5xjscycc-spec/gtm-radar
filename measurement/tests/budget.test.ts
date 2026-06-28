import { describe, it, expect } from "vitest";
import {
  estimateSweepCost,
  degradeForBudget,
  buildSpendRecord,
  ENGINE_COST_PER_CALL,
} from "../src/budget";
import type { EngineName } from "../src/engine";

describe("estimateSweepCost", () => {
  it("estimates cost for a simple sweep", () => {
    // 10 pages × 1 engine (openai $0.03) × avgK=5.5 = 55 calls → $1.65
    const cost = estimateSweepCost(10, ["openai"], 3, 8);
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(5);
  });

  it("scales with more engines", () => {
    const single = estimateSweepCost(10, ["openai"], 3, 8);
    const multi = estimateSweepCost(10, ["openai", "perplexity"], 3, 8);
    expect(multi).toBeGreaterThan(single);
  });

  it("scales with more pages", () => {
    const few = estimateSweepCost(5, ["openai"], 3, 8);
    const many = estimateSweepCost(50, ["openai"], 3, 8);
    expect(many).toBeGreaterThan(few);
  });

  it("handles zero pages", () => {
    expect(estimateSweepCost(0, ["openai"], 3, 8)).toBe(0);
  });
});

describe("degradeForBudget", () => {
  it("no degradation when cost fits budget", () => {
    const result = degradeForBudget(
      100,
      50, // cost is well under budget
      10,
      ["openai"],
      { baseK: 3, maxK: 8 },
    );
    expect(result.degradationLevel).toBe("none");
    expect(result.droppedEngines).toHaveLength(0);
    expect(result.baseK).toBe(3);
    expect(result.maxK).toBe(8);
  });

  it("reduces K when cost exceeds budget", () => {
    // Estimate a huge cost to force K reduction
    const hugeCost = 10000;
    const result = degradeForBudget(
      120,
      hugeCost,
      10,
      ["openai"],
      { baseK: 3, maxK: 8 },
    );
    expect(result.degradationLevel).toBe("reduced_k");
    expect(result.baseK).toBeLessThan(3);
    expect(result.maxK).toBeLessThan(8);
    expect(result.droppedEngines).toHaveLength(0);
  });

  it("drops most expensive engine when K reduction alone is insufficient", () => {
    // Force degradation by making the K floor still too expensive
    const result = degradeForBudget(
      5, // very tight budget
      1000,
      100,
      ["openai", "perplexity", "gemini"] as EngineName[],
      { baseK: 1, maxK: 1 }, // already at minimum K
    );
    // At minimum K, still too expensive → drop most expensive (openai)
    expect(result.degradationLevel).toBe("dropped_engine");
    expect(result.droppedEngines).toContain("openai");
    expect(result.activeEngines).not.toContain("openai");
  });

  it("preserves at least one engine", () => {
    const result = degradeForBudget(
      0.01, // unrealistically tight
      1000,
      100,
      ["openai", "perplexity", "gemini"] as EngineName[],
      { baseK: 1, maxK: 1 },
    );
    expect(result.activeEngines.length).toBeGreaterThanOrEqual(1);
  });

  it("drops engines in cost order (openai first)", () => {
    const result = degradeForBudget(
      0.01,
      1000,
      100,
      ["perplexity", "openai", "gemini"] as EngineName[],
      { baseK: 1, maxK: 1 },
    );
    // OpenAI should be dropped first regardless of input order
    expect(result.droppedEngines).toContain("openai");
  });
});

describe("buildSpendRecord", () => {
  it("builds a spend record with cost totals", () => {
    const record = buildSpendRecord(
      "cust_001",
      "cycle_001",
      {
        openai: { calls: 100, errors: 2 },
        perplexity: { calls: 50, errors: 1 },
      },
      "none",
      120,
    );

    expect(record.customer_id).toBe("cust_001");
    expect(record.cycle_id).toBe("cycle_001");
    expect(record.totalCalls).toBe(150);

    const expectedOpenaiCost = 100 * ENGINE_COST_PER_CALL.openai;
    expect(record.perEngine.openai.cost).toBeCloseTo(expectedOpenaiCost, 3);
    expect(record.perEngine.openai.errorRate).toBeCloseTo(0.02, 5);

    expect(record.degradationLevel).toBe("none");
    expect(record.capped).toBe(false);
  });

  it("flags capped when cost exceeds budget limit", () => {
    const record = buildSpendRecord(
      "cust_001",
      "cycle_001",
      { openai: { calls: 10000, errors: 0 } },
      "reduced_k",
      120,
    );
    expect(record.capped).toBe(true);
    expect(record.degradationLevel).toBe("reduced_k");
  });

  it("handles empty engine stats", () => {
    const record = buildSpendRecord("cust_001", "cycle_001", {}, "none", 120);
    expect(record.totalCalls).toBe(0);
    expect(record.totalCost).toBe(0);
  });
});
