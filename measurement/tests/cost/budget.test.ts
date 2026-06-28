import { describe, it, expect } from "vitest";
import { makeBudgetGuard, worstCaseCalls } from "../../src/cost/budget";
import { realizedCostUSD } from "../../src/cost";

// P2·6 Module 3 — the budget guard. A cap that can be exceeded is not a cap, so the
// guard must be conservative: canAfford is checked BEFORE a query runs, and record only
// ever logs spend the sweep already cleared. These tests pin the inclusive-ceiling
// semantics, the multiplier wiring, and the worst-case reservation arithmetic.

describe("makeBudgetGuard", () => {
  it("starts empty: zero spent, full ceiling remaining", () => {
    const guard = makeBudgetGuard({ ceilingUSD: 1 });
    expect(guard.spentUSD()).toBe(0);
    expect(guard.remainingUSD()).toBeCloseTo(1, 10);
  });

  it("record accumulates realized spend across calls", () => {
    const guard = makeBudgetGuard({ ceilingUSD: 100 });
    // default multiplier 2 ⇒ 10 calls = $0.20, 5 calls = $0.10
    guard.record(10);
    expect(guard.spentUSD()).toBeCloseTo(realizedCostUSD(10), 10); // 0.20
    guard.record(5);
    expect(guard.spentUSD()).toBeCloseTo(realizedCostUSD(15), 10); // 0.30
  });

  it("remainingUSD = ceiling - spent", () => {
    const guard = makeBudgetGuard({ ceilingUSD: 1 });
    guard.record(10); // $0.20 at default multiplier
    expect(guard.remainingUSD()).toBeCloseTo(0.8, 10);
  });

  it("canAfford is true strictly below the ceiling", () => {
    const guard = makeBudgetGuard({ ceilingUSD: 1 });
    // 10 calls = $0.20 ⇒ well under $1
    expect(guard.canAfford(10)).toBe(true);
  });

  it("canAfford is true landing EXACTLY on the ceiling (inclusive)", () => {
    // ceiling $0.20, 10 calls = exactly $0.20 ⇒ affordable
    const guard = makeBudgetGuard({ ceilingUSD: realizedCostUSD(10) });
    expect(guard.canAfford(10)).toBe(true);
  });

  it("canAfford is false when the cost would exceed the ceiling", () => {
    // ceiling just under the cost of 10 calls ⇒ not affordable
    const guard = makeBudgetGuard({ ceilingUSD: realizedCostUSD(10) - 0.001 });
    expect(guard.canAfford(10)).toBe(false);
  });

  it("canAfford accounts for already-recorded spend", () => {
    const guard = makeBudgetGuard({ ceilingUSD: realizedCostUSD(10) }); // room for 10 calls
    guard.record(6); // spend $0.12
    expect(guard.canAfford(4)).toBe(true); // 6+4 = 10 calls = exactly ceiling
    expect(guard.canAfford(5)).toBe(false); // 6+5 = 11 calls > ceiling
  });

  it("applies a custom multiplier to both record and canAfford", () => {
    const guard = makeBudgetGuard({ ceilingUSD: 1, multiplier: 1 });
    // multiplier 1 ⇒ 10 calls = $0.10 (not $0.20)
    guard.record(10);
    expect(guard.spentUSD()).toBeCloseTo(realizedCostUSD(10, 1), 10); // 0.10
    expect(guard.remainingUSD()).toBeCloseTo(0.9, 10);
    // 90 more calls = $0.90 ⇒ lands exactly on ceiling, affordable
    expect(guard.canAfford(90)).toBe(true);
    expect(guard.canAfford(91)).toBe(false);
  });

  it("recording zero calls is a no-op", () => {
    const guard = makeBudgetGuard({ ceilingUSD: 1 });
    guard.record(0);
    expect(guard.spentUSD()).toBe(0);
    expect(guard.canAfford(0)).toBe(true);
  });
});

describe("worstCaseCalls", () => {
  it("is numEngines × kForBudget", () => {
    expect(worstCaseCalls(3, 8)).toBe(24);
  });

  it("is zero when there are no engines or k is zero", () => {
    expect(worstCaseCalls(0, 8)).toBe(0);
    expect(worstCaseCalls(3, 0)).toBe(0);
  });
});
