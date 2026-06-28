import { describe, it, expect } from "vitest";
import {
  RUNG,
  licensedRung,
  canRenderCausal,
  makeClaim,
  assertHypothesisCopy,
  crossesZero,
  rankedGaps,
} from "../src/claimLadder";

// ── THE MANDATORY HONESTY TEST (must never regress) ─────────────────────────
describe("claim-ladder guard: causal is IMPOSSIBLE without a lift_result", () => {
  it("makeClaim(CAUSAL) THROWS when there is no lift_result", () => {
    expect(() => makeClaim(RUNG.CAUSAL, { hasModelFit: true })).toThrow(
      /lift_result/,
    );
    expect(() => makeClaim(RUNG.CAUSAL, {})).toThrow();
  });

  it("makeClaim(CAUSAL) succeeds ONLY with a lift_result", () => {
    expect(makeClaim(RUNG.CAUSAL, { hasLiftResult: true }).rung).toBe(RUNG.CAUSAL);
  });

  it("canRenderCausal is false without a lift_result, true with one", () => {
    expect(canRenderCausal({ hasModelFit: true })).toBe(false);
    expect(canRenderCausal({ hasLiftResult: true })).toBe(true);
  });
});

describe("licensedRung — evidence determines the ceiling", () => {
  it("nothing -> descriptive; model_fit -> hypothesis; lift_result -> causal", () => {
    expect(licensedRung({})).toBe(RUNG.DESCRIPTIVE);
    expect(licensedRung({ hasMeasurement: true })).toBe(RUNG.DESCRIPTIVE);
    expect(licensedRung({ hasModelFit: true })).toBe(RUNG.HYPOTHESIS);
    expect(licensedRung({ hasLiftResult: true })).toBe(RUNG.CAUSAL);
  });

  it("a too-high request is downgraded to the licensed rung (never overclaims)", () => {
    // ask for causal-ish but only model_fit exists -> capped at hypothesis
    expect(makeClaim(RUNG.HYPOTHESIS, { hasModelFit: true }).rung).toBe(RUNG.HYPOTHESIS);
    expect(makeClaim(RUNG.HYPOTHESIS, {}).rung).toBe(RUNG.DESCRIPTIVE);
  });
});

describe("hypothesis copy lint — no promise/causal language at Rung 1", () => {
  it("throws on overclaiming copy", () => {
    expect(() => assertHypothesisCopy("Add a comparison table and you'll win"))
      .toThrow();
    expect(() => assertHypothesisCopy("This proves you'll rank #1")).toThrow();
    expect(() => assertHypothesisCopy("comparison_table causes citations")).toThrow();
  });

  it("accepts honest hypothesis copy", () => {
    expect(() =>
      assertHypothesisCopy(
        "comparison_table correlates with citation in this category; test it",
      ),
    ).not.toThrow();
  });
});

describe("rankedGaps — noise flags are load-bearing", () => {
  it("separates surviving signals from noise (incl. CI-crosses-zero)", () => {
    const { surviving, noise } = rankedGaps([
      { feature: "comparison_table", posterior_median: 0.8, ci_low: 0.2, ci_high: 1.4, noise_flag: false },
      { feature: "offpage", posterior_median: 0.6, ci_low: 0.1, ci_high: 1.1, noise_flag: false },
      { feature: "word_count", posterior_median: 0.05, ci_low: -0.3, ci_high: 0.4, noise_flag: true },
      // not flagged by the model, but CI crosses zero -> still noise (guard)
      { feature: "freshness", posterior_median: 0.2, ci_low: -0.1, ci_high: 0.5, noise_flag: false },
    ]);
    expect(surviving.map((c) => c.feature)).toEqual(["comparison_table", "offpage"]);
    expect(noise.map((c) => c.feature).sort()).toEqual(["freshness", "word_count"]);
  });

  it("crossesZero", () => {
    expect(crossesZero(-0.1, 0.5)).toBe(true);
    expect(crossesZero(0.2, 1.4)).toBe(false);
  });
});
