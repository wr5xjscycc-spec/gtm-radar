import { describe, it, expect } from "vitest";
import {
  wilsonCI,
  positionWeight,
  averagePositionWeight,
  aggregateRuns,
  needsMoreSamples,
  type RunRecord,
  type AggregateResult,
} from "../src/aggregate";

const mockRun = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  query_id: "qry_test",
  page_url: "https://acme.com/pricing",
  company_domain: "acme.com",
  engine: "openai",
  model_version: "gpt-4o-2024-08-06",
  run_idx: 0,
  appeared: true,
  cited: true,
  position: 0,
  source_urls: ["https://acme.com/pricing"],
  ts: Date.now(),
  ...overrides,
});

describe("wilsonCI", () => {
  it("returns 0-1 for empty sample", () => {
    const ci = wilsonCI(0, 0);
    expect(ci.low).toBe(0);
    expect(ci.high).toBe(1);
  });

  it("returns 0-low for k=0", () => {
    const ci = wilsonCI(0, 10);
    expect(ci.low).toBeCloseTo(0, 2);
    expect(ci.high).toBeLessThan(0.35);
  });

  it("is symmetric for k=n/2", () => {
    const ci = wilsonCI(5, 10);
    expect(ci.low).toBeLessThan(0.5);
    expect(ci.high).toBeGreaterThan(0.5);
    expect(ci.high - 0.5).toBeCloseTo(0.5 - ci.low, 3);
  });

  it("tightens with more samples", () => {
    const ciSmall = wilsonCI(50, 100);
    const ciLarge = wilsonCI(500, 1000);
    const spanSmall = ciSmall.high - ciSmall.low;
    const spanLarge = ciLarge.high - ciLarge.low;
    expect(spanLarge).toBeLessThan(spanSmall);
  });

  it("handles k=n (all cited)", () => {
    const ci = wilsonCI(10, 10);
    expect(ci.high).toBeCloseTo(1, 5);
    expect(ci.low).toBeGreaterThan(0.65);
  });

  it("holds known reference values", () => {
    // 3 out of 3 → P=1.0, Wilson CI (z=1.96) ≈ [0.434, 1.0]
    const ci = wilsonCI(3, 3);
    expect(ci.low).toBeCloseTo(0.434, 2);
    expect(ci.high).toBeCloseTo(1.0, 2);

    // 2 out of 3 → P≈0.667, Wilson CI ≈ [0.208, 0.957]
    const ci2 = wilsonCI(2, 3);
    expect(ci2.low).toBeCloseTo(0.208, 1);
    expect(ci2.high).toBeCloseTo(0.957, 1);

    // 1 out of 3 → P≈0.333, Wilson CI ≈ [0.044, 0.792]
    const ci3 = wilsonCI(1, 3);
    expect(ci3.low).toBeCloseTo(0.044, 1);
    expect(ci3.high).toBeCloseTo(0.792, 1);
  });
});

describe("positionWeight", () => {
  it("returns 1.0 for position 0", () => {
    expect(positionWeight(0)).toBe(1.0);
  });

  it("returns 0.5 for position 1", () => {
    expect(positionWeight(1)).toBe(0.5);
  });

  it("returns 0.25 for position 3", () => {
    expect(positionWeight(3)).toBe(0.25);
  });

  it("returns 0 for null position", () => {
    expect(positionWeight(null)).toBe(0);
  });

  it("decays with higher position", () => {
    expect(positionWeight(0)).toBeGreaterThan(positionWeight(1));
    expect(positionWeight(1)).toBeGreaterThan(positionWeight(2));
    expect(positionWeight(2)).toBeGreaterThan(positionWeight(5));
  });
});

describe("averagePositionWeight", () => {
  it("returns 0 for empty array", () => {
    expect(averagePositionWeight([])).toBe(0);
  });

  it("computes average across runs", () => {
    // Cited at position 0 (weight 1.0), position 1 (weight 0.5), not cited (null → 0)
    expect(averagePositionWeight([0, 1, null])).toBeCloseTo(0.5, 5);
  });
});

describe("aggregateRuns", () => {
  it("computes P_cited from runs", () => {
    const runs = [
      mockRun({ cited: true, run_idx: 0 }),
      mockRun({ cited: true, run_idx: 1 }),
      mockRun({ cited: false, run_idx: 2 }),
    ];

    const agg = aggregateRuns(
      "qry_test",
      "https://acme.com/pricing",
      "acme.com",
      "openai",
      runs,
    );

    expect(agg.K).toBe(3);
    expect(agg.P_cited).toBeCloseTo(2 / 3, 5);
    expect(agg.ci_low).toBeLessThan(agg.P_cited);
    expect(agg.ci_high).toBeGreaterThan(agg.P_cited);
    expect(agg.position_weight).toBeGreaterThan(0);
    expect(agg.engine).toBe("openai");
    expect(agg.model_version).toBe("gpt-4o-2024-08-06");
  });

  it("handles empty runs", () => {
    const agg = aggregateRuns(
      "qry_test",
      "https://acme.com/pricing",
      "acme.com",
      "openai",
      [],
    );

    expect(agg.K).toBe(0);
    expect(agg.P_cited).toBe(0);
  });
});

describe("needsMoreSamples", () => {
  it("returns false when CI is narrow and does not straddle 0.5", () => {
    const agg: AggregateResult = {
      query_id: "qry_test",
      page_url: "https://acme.com/pricing",
      company_domain: "acme.com",
      engine: "openai",
      model_version: "gpt-4o",
      K: 10,
      P_cited: 0.9,
      ci_low: 0.85,
      ci_high: 0.95,
      position_weight: 0.9,
      runs: [],
    };

    expect(needsMoreSamples(agg)).toBe(false);
  });

  it("returns true when CI straddles 0.5 (ambiguous)", () => {
    const agg: AggregateResult = {
      query_id: "qry_test",
      page_url: "https://acme.com/pricing",
      company_domain: "acme.com",
      engine: "openai",
      model_version: "gpt-4o",
      K: 3,
      P_cited: 0.5,
      ci_low: 0.3,
      ci_high: 0.7,
      position_weight: 0.5,
      runs: [],
    };

    expect(needsMoreSamples(agg)).toBe(true);
  });

  it("returns true when CI span is wide", () => {
    const agg: AggregateResult = {
      query_id: "qry_test",
      page_url: "https://acme.com/pricing",
      company_domain: "acme.com",
      engine: "openai",
      model_version: "gpt-4o",
      K: 3,
      P_cited: 0.33,
      ci_low: 0.1,
      ci_high: 0.7,
      position_weight: 0.33,
      runs: [],
    };

    expect(needsMoreSamples(agg)).toBe(true);
  });

  it("returns false for very narrow CI", () => {
    const agg: AggregateResult = {
      query_id: "qry_test",
      page_url: "https://acme.com/pricing",
      company_domain: "acme.com",
      engine: "openai",
      model_version: "gpt-4o",
      K: 100,
      P_cited: 0.5,
      ci_low: 0.48,
      ci_high: 0.52,
      position_weight: 0.5,
      runs: [],
    };

    expect(needsMoreSamples(agg)).toBe(false);
  });
});
