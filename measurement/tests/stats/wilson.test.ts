import { describe, it, expect } from "vitest";
import { wilsonInterval } from "../../src/stats/wilson";

// P2·3 stats core: Wilson score interval for a binomial proportion.
// Wilson (NOT normal approximation) because at K=3 near 0/1 the normal approx is
// wrong in our regime (design spec §"Non-negotiables"). The reference values below
// are EXACT contract numbers — the aggregate + adaptive layers depend on them.

const TOL = 1e-3;

describe("wilsonInterval", () => {
  it("n === 0 → {low:0, high:1} (maximal uncertainty, never NaN)", () => {
    const r = wilsonInterval(0, 0);
    expect(r.low).toBe(0);
    expect(r.high).toBe(1);
    // Even with phantom successes the empty-sample case stays maximal, never NaN.
    const r2 = wilsonInterval(5, 0);
    expect(Number.isNaN(r2.low)).toBe(false);
    expect(Number.isNaN(r2.high)).toBe(false);
    expect(r2.low).toBe(0);
    expect(r2.high).toBe(1);
  });

  it("reference value 5/10 @ z=1.96 ≈ {0.237, 0.763}", () => {
    const r = wilsonInterval(5, 10, 1.96);
    expect(r.low).toBeCloseTo(0.237, 3);
    expect(r.high).toBeCloseTo(0.763, 3);
  });

  it("0/3 → low 0, high < 1 (≈ {0, 0.561})", () => {
    const r = wilsonInterval(0, 3, 1.96);
    expect(r.low).toBe(0);
    expect(r.high).toBeLessThan(1);
    expect(Math.abs(r.high - 0.561)).toBeLessThan(TOL);
  });

  it("0/8 → ≈ {0, 0.324} (confidently-uncited resolves below 0.5)", () => {
    const r = wilsonInterval(0, 8, 1.96);
    expect(r.low).toBe(0);
    expect(Math.abs(r.high - 0.324)).toBeLessThan(TOL);
  });

  it("3/3 → high 1, low < 1 (≈ {0.438, 1.0})", () => {
    const r = wilsonInterval(3, 3, 1.96);
    expect(r.high).toBe(1);
    expect(r.low).toBeLessThan(1);
    expect(Math.abs(r.low - 0.438)).toBeLessThan(TOL);
  });

  it("1/3 straddles 0.5 (low < 0.5 < high)", () => {
    const r = wilsonInterval(1, 3, 1.96);
    expect(r.low).toBeLessThan(0.5);
    expect(r.high).toBeGreaterThan(0.5);
  });

  it("always returns an interval clamped within [0, 1] across the full grid", () => {
    for (let n = 1; n <= 12; n++) {
      for (let s = 0; s <= n; s++) {
        const r = wilsonInterval(s, n, 1.96);
        expect(r.low).toBeGreaterThanOrEqual(0);
        expect(r.low).toBeLessThanOrEqual(1);
        expect(r.high).toBeGreaterThanOrEqual(0);
        expect(r.high).toBeLessThanOrEqual(1);
        expect(r.low).toBeLessThanOrEqual(r.high);
      }
    }
  });

  it("clamps successes to [0, n] (out-of-range successes never throw or leave [0,1])", () => {
    // successes > n behaves like the all-success case (clamped to n).
    const over = wilsonInterval(99, 3, 1.96);
    const allHits = wilsonInterval(3, 3, 1.96);
    expect(over.low).toBeCloseTo(allHits.low, 10);
    expect(over.high).toBeCloseTo(allHits.high, 10);
    // negative successes behaves like the zero-success case (clamped to 0).
    const under = wilsonInterval(-5, 3, 1.96);
    const noHits = wilsonInterval(0, 3, 1.96);
    expect(under.low).toBeCloseTo(noHits.low, 10);
    expect(under.high).toBeCloseTo(noHits.high, 10);
  });

  it("a wider z widens the interval (higher confidence ⇒ more uncertainty)", () => {
    const narrow = wilsonInterval(5, 10, 1.96); // ~95%
    const wide = wilsonInterval(5, 10, 2.576); // ~99%
    expect(wide.low).toBeLessThan(narrow.low);
    expect(wide.high).toBeGreaterThan(narrow.high);
    expect(wide.high - wide.low).toBeGreaterThan(narrow.high - narrow.low);
  });

  it("defaults z to 1.96 when omitted", () => {
    const explicit = wilsonInterval(5, 10, 1.96);
    const defaulted = wilsonInterval(5, 10);
    expect(defaulted.low).toBeCloseTo(explicit.low, 12);
    expect(defaulted.high).toBeCloseTo(explicit.high, 12);
  });
});
