import { describe, it, expect } from "vitest";
import {
  OPENAI_WEB_SEARCH_COST,
  estimateOpenAIQueryCostUSD,
  realizedCostUSD,
  adaptiveSavingsUSD,
} from "../src/cost";

// P2·1 artifact: the OpenAI web_search cost posture (ARCHITECTURE.md §4.2 / §11), which P2·6's
// budget guards consume. The headline number the architecture cites is ≈$0.02 per measured query
// once the hidden ~2× sub-search multiplier is included.
describe("OpenAI web_search cost model", () => {
  it("encodes the $10 / 1,000-call base rate and the sub-search multiplier", () => {
    expect(OPENAI_WEB_SEARCH_COST.perToolCallUSD).toBeCloseTo(0.01, 10); // $10 / 1000
    expect(OPENAI_WEB_SEARCH_COST.subSearchMultiplier).toBeGreaterThanOrEqual(2);
  });

  it("estimates ≈$0.02 for a single measured query (1 repeat, default multiplier)", () => {
    expect(estimateOpenAIQueryCostUSD(1)).toBeCloseTo(0.02, 6);
  });

  it("drops the multiplier to the bare call cost when multiplier=1", () => {
    expect(estimateOpenAIQueryCostUSD(1, 1, 1)).toBeCloseTo(0.01, 6);
  });

  it("scales by queries × repeats (a 400-query K=3 sweep ≈ $24)", () => {
    expect(estimateOpenAIQueryCostUSD(400, 3)).toBeCloseTo(24, 6);
  });

  it("is zero for zero queries", () => {
    expect(estimateOpenAIQueryCostUSD(0)).toBe(0);
  });
});

// P2·3 Part C: adaptive sampling makes K vary per (query, engine), so the demo needs the
// REALIZED cost (priced off the actual call count) and the saving vs a naive fixed-kMax sweep.
describe("realizedCostUSD", () => {
  it("prices the actual call count at perToolCall × default 2× multiplier", () => {
    // 10 calls × $0.01 × 2 = $0.20
    expect(realizedCostUSD(10)).toBeCloseTo(0.2, 6);
  });

  it("drops to the bare per-call cost when multiplier=1", () => {
    expect(realizedCostUSD(10, 1)).toBeCloseTo(0.1, 6);
  });

  it("is zero for zero calls", () => {
    expect(realizedCostUSD(0)).toBe(0);
  });

  it("matches estimateOpenAIQueryCostUSD when calls = queries × repeats", () => {
    // a fixed 400-query K=3 sweep is 1200 calls ⇒ same $24 the estimate reports
    expect(realizedCostUSD(1200)).toBeCloseTo(estimateOpenAIQueryCostUSD(400, 3), 6);
  });
});

describe("adaptiveSavingsUSD", () => {
  it("computes fixed vs actual cost and the saved percentage", () => {
    // fixed = 100 queries × 3 engines × 8 kMax × $0.01 × 2 = $48
    // actual = 1200 calls × $0.01 × 2 = $24  ⇒ saved $24 = 50%
    const r = adaptiveSavingsUSD({
      numQueries: 100,
      numEngines: 3,
      kMax: 8,
      actualCalls: 1200,
    });
    expect(r.fixedCostUSD).toBeCloseTo(48, 6);
    expect(r.actualCostUSD).toBeCloseTo(24, 6);
    expect(r.savedUSD).toBeCloseTo(24, 6);
    expect(r.savedPct).toBeCloseTo(50, 6);
  });

  it("honours a custom multiplier consistently across fixed and actual", () => {
    // multiplier=1: fixed = 100×3×8×0.01 = $24, actual = 1200×0.01 = $12 ⇒ 50%
    const r = adaptiveSavingsUSD({
      numQueries: 100,
      numEngines: 3,
      kMax: 8,
      actualCalls: 1200,
      multiplier: 1,
    });
    expect(r.fixedCostUSD).toBeCloseTo(24, 6);
    expect(r.actualCostUSD).toBeCloseTo(12, 6);
    expect(r.savedPct).toBeCloseTo(50, 6);
  });

  it("reports zero saving when actual equals fixed (no adaptive lever fired)", () => {
    const r = adaptiveSavingsUSD({
      numQueries: 10,
      numEngines: 1,
      kMax: 8,
      actualCalls: 80, // 10×1×8
    });
    expect(r.savedUSD).toBeCloseTo(0, 6);
    expect(r.savedPct).toBeCloseTo(0, 6);
  });

  it("guards division-by-zero: fixed cost = 0 ⇒ savedPct = 0, never NaN", () => {
    const r = adaptiveSavingsUSD({
      numQueries: 0,
      numEngines: 3,
      kMax: 8,
      actualCalls: 0,
    });
    expect(r.fixedCostUSD).toBe(0);
    expect(r.savedPct).toBe(0);
    expect(Number.isNaN(r.savedPct)).toBe(false);
  });
});
