// P2·6 Module 3 — the budget guard.
//
// A full sweep must stay in budget. The non-negotiable from the design spec: "a cap that
// can be exceeded is not a cap." So the guard is conservative by construction — the sweep
// asks `canAfford(worstCaseCalls)` BEFORE starting a query, and only `record`s spend it
// already cleared. That ordering, not any clamping here, is what holds the ceiling: this
// module never spends on its own, it only answers "would this fit?" and remembers what did.
//
// State lives in a closure over a private `spent` accumulator — NOT a class. Per the spec's
// style rule, a stateful guard is a closure-over-locals object literal; that keeps the
// surface area pure-ish (no `this`, no inheritance) while still carrying the one mutable
// number the sweep needs.

import { realizedCostUSD } from "../cost";

export interface BudgetGuard {
  /** Total USD recorded so far this window. */
  spentUSD(): number;
  /** ceilingUSD − spentUSD. Can be used for reporting headroom. */
  remainingUSD(): number;
  /** Add the realized cost of `numEngineCalls` to the running spend. */
  record(numEngineCalls: number): void;
  /** Would spending on `numEngineCalls` more keep total spend ≤ ceiling? */
  canAfford(numEngineCalls: number): boolean;
}

/**
 * Build a budget guard for a single budget window.
 *
 * @param opts.ceilingUSD  hard spend cap for this window — spend never exceeds it.
 * @param opts.multiplier  sub-search multiplier forwarded to `realizedCostUSD`
 *                         (default = the conservative 2× baked into cost.ts). Applied
 *                         identically to `record` and `canAfford` so the affordability
 *                         check prices exactly what `record` would later log.
 */
export function makeBudgetGuard(opts: { ceilingUSD: number; multiplier?: number }): BudgetGuard {
  const { ceilingUSD, multiplier } = opts;

  // The single mutable cell the guard closes over. Private — only the returned methods
  // can touch it, which is the whole point of using a closure instead of a bare object.
  let spent = 0;

  return {
    spentUSD: () => spent,
    remainingUSD: () => ceilingUSD - spent,
    record: (numEngineCalls: number) => {
      // No clamping: the sweep only ever records what `canAfford` already cleared, so
      // adding here can never push past the ceiling. Clamping would silently hide a
      // caller bug rather than letting the worst-case reservation do its job.
      spent += realizedCostUSD(numEngineCalls, multiplier);
    },
    // Inclusive: landing EXACTLY on the ceiling is allowed (≤, not <). A query whose
    // worst-case cost is precisely the remaining budget is still affordable.
    canAfford: (numEngineCalls: number) =>
      spent + realizedCostUSD(numEngineCalls, multiplier) <= ceilingUSD,
  };
}

/**
 * Worst-case engine calls for one query at the budget-reservation K.
 *
 * The sweep reserves budget per query at its worst case — every target engine running the
 * full reservation K — so a query starts only if even that ceiling fits. Adaptive sampling
 * almost always comes in under this, which is exactly why the guard never overruns: it
 * pre-charges the maximum and the actual `record` is ≤ what was reserved.
 *
 * @param numEngines  target engines (with a key + adapter) for the query
 * @param kForBudget  the K reserved per (query, engine); defaults to kMax at the call site
 * @returns           numEngines × kForBudget
 */
export function worstCaseCalls(numEngines: number, kForBudget: number): number {
  return numEngines * kForBudget;
}
