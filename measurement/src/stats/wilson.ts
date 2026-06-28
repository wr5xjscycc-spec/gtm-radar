// P2·3 (Measurement, statistics core) — Wilson score interval for a binomial proportion.
//
// We use the WILSON score interval, NOT the normal (Wald) approximation, on purpose: at the
// small sample sizes this layer runs at (K≈3, design spec §"Non-negotiables") and near the
// boundaries (0/n, n/n) the Wald interval collapses to zero width and slides outside [0,1] —
// it would claim certainty exactly where we have the least. Wilson stays correct in that regime:
// it never produces a degenerate or out-of-range interval, and its asymmetry near 0 and 1 is
// what lets the adaptive sampler tell a "confidently uncited" page (0/8) apart from a "we just
// don't know yet" page (0/3). Those exact endpoints feed the aggregate + adaptive layers, so
// this function is the numeric ground truth for everything downstream — keep it pure and exact.

/**
 * Wilson score interval for the true success probability of a binomial proportion.
 *
 * @param successes Observed successes (cited count). Clamped DEFENSIVELY to `[0, n]`: callers
 *   compute this from run rows, and an off-by-one or a stale count must degrade to the nearest
 *   valid extreme (all-fail / all-success) rather than yield an interval outside [0,1] or a NaN.
 * @param n Number of trials (runs in the group).
 * @param z Standard-normal quantile for the desired confidence; defaults to 1.96 (~95%). A
 *   larger `z` widens the interval (more confidence demanded ⇒ more admitted uncertainty).
 * @returns `{ low, high }`, both clamped to `[0, 1]` with `low <= high`.
 *
 * `n === 0` short-circuits to `{ low: 0, high: 1 }` — maximal uncertainty. With no observations
 * the only honest interval is the whole unit segment; this also avoids the `0/0` that the
 * formula would otherwise hit (never return NaN to the aggregate layer).
 */
export function wilsonInterval(
  successes: number,
  n: number,
  z = 1.96,
): { low: number; high: number } {
  // No trials ⇒ no information. Return the full [0,1] rather than dividing by zero.
  if (n <= 0) return { low: 0, high: 1 };

  // Defensive clamp: a count outside [0, n] is a caller bug, not a real observation. Snap it to
  // the nearest valid extreme so the interval stays well-defined instead of escaping [0,1].
  const s = Math.max(0, Math.min(n, successes));

  const pHat = s / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;

  // Wilson center is the observed rate shrunk toward 1/2 by a z-dependent pseudo-count; the
  // half-width is the score-test margin. This is the algebraic interval, not a search.
  const center = (pHat + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((pHat * (1 - pHat)) / n + z2 / (4 * n * n));

  // Clamp endpoints to [0,1]: at the boundaries the asymmetric interval can nudge a hair past
  // 0 or 1 due to floating-point, and a probability interval must never report < 0 or > 1.
  const low = Math.min(1, Math.max(0, center - half));
  const high = Math.min(1, Math.max(0, center + half));

  return { low, high };
}
