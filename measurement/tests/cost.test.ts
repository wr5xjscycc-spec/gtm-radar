import { describe, it, expect } from "vitest";
import {
  OPENAI_WEB_SEARCH_COST,
  estimateOpenAIQueryCostUSD,
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
