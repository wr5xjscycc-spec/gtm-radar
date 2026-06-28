/**
 * The claim ladder (owner: P1, Phase 4) — the product's honesty guard.
 *
 * Three epistemic layers, never blurred:
 *   Rung 0  measurement  → DESCRIPTIVE truth   ("is cited", "appeared", counts)
 *   Rung 1  model_fit    → HYPOTHESIS w/ uncertainty ("correlates with", "candidate — test it")
 *   Rung 2  lift_result  → CAUSAL claim        ("caused +X% vs matched controls")
 *
 * THE INVARIANT (a GEO-specialist judge attacks exactly here): a causal (Rung-2)
 * statement is **architecturally impossible** to render unless a `lift_result`
 * record exists for that experiment. This module is the single enforcement point;
 * the UI renders ONLY through `makeClaim` / `assertHypothesisCopy`, so a designer
 * cannot slip "add X and you'll win" past the gate.
 *
 * Pure + unit-tested. The mandatory honesty test (must never regress):
 * `makeClaim(CAUSAL, evidence-without-lift_result)` THROWS.
 */

export const RUNG = { DESCRIPTIVE: 0, HYPOTHESIS: 1, CAUSAL: 2 } as const;
export type Rung = (typeof RUNG)[keyof typeof RUNG];

export interface Evidence {
  hasMeasurement?: boolean;
  hasModelFit?: boolean;
  hasLiftResult?: boolean;
}

export const RUNG_BADGE: Record<Rung, string> = {
  0: "Measured",
  1: "Hypothesis",
  2: "Causal (experiment)",
};

/** The HIGHEST rung the available evidence licenses. Causal needs a lift_result. */
export function licensedRung(e: Evidence): Rung {
  if (e.hasLiftResult) return RUNG.CAUSAL;
  if (e.hasModelFit) return RUNG.HYPOTHESIS;
  return RUNG.DESCRIPTIVE;
}

/** Causal language may render ONLY when a lift_result exists. */
export function canRenderCausal(e: Evidence): boolean {
  return e.hasLiftResult === true;
}

export interface Claim {
  rung: Rung;
  badge: string;
}

/**
 * The ONLY way the UI constructs a claim. Requesting a causal claim without a
 * lift_result THROWS (the architectural guard). Any request above the licensed
 * rung is downgraded to what the evidence actually supports — overclaiming is
 * impossible by construction.
 */
export function makeClaim(requested: Rung, e: Evidence): Claim {
  if (requested === RUNG.CAUSAL && !canRenderCausal(e)) {
    throw new Error(
      "claim-ladder violation: a causal claim requires a lift_result record",
    );
  }
  const rung = Math.min(requested, licensedRung(e)) as Rung;
  return { rung, badge: RUNG_BADGE[rung] };
}

// Language that must never appear at the hypothesis rung (promise / causal / proof).
const BANNED_HYPOTHESIS_COPY: RegExp[] = [
  /\byou'?ll win\b/i,
  /\badd\b.+\band you'?ll\b/i,
  /\bproven\b/i,
  /\bproves\b/i,
  /\bguarantee/i,
  /\bwill (?:rank|cite|win|get you)\b/i,
  /\bcauses?\b/i,
];

/**
 * Copy lint for hypothesis-stage text. Throws on overclaiming language so a
 * causal/promise sentence cannot ship at Rung 1. Required copy pattern is
 * "X correlates with citation in this category; test it."
 */
export function assertHypothesisCopy(text: string): void {
  for (const re of BANNED_HYPOTHESIS_COPY) {
    if (re.test(text)) {
      throw new Error(`claim-ladder violation: overclaiming hypothesis copy — "${text}"`);
    }
  }
}

export interface Coefficient {
  feature: string;
  posterior_median: number;
  ci_low: number;
  ci_high: number;
  noise_flag: boolean;
}

/** A CI that crosses zero is "not distinguishable from noise". */
export function crossesZero(ciLow: number, ciHigh: number): boolean {
  return ciLow <= 0 && ciHigh >= 0;
}

/**
 * Ranked-gap view: surviving signals (not noise) sorted by |effect|, kept
 * visually separate from the noise-flagged majority. noise_flag is load-bearing,
 * not a footnote — a coefficient whose CI crosses zero is noise even if the model
 * forgot to flag it.
 */
export function rankedGaps(coefficients: Coefficient[]): {
  surviving: Coefficient[];
  noise: Coefficient[];
} {
  const isNoise = (c: Coefficient) => c.noise_flag || crossesZero(c.ci_low, c.ci_high);
  const surviving = coefficients
    .filter((c) => !isNoise(c))
    .sort((a, b) => Math.abs(b.posterior_median) - Math.abs(a.posterior_median));
  const noise = coefficients.filter(isNoise);
  return { surviving, noise };
}
