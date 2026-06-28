// P2·4 Module 3 — pool-composition sanity (case-control gotcha).
//
// The card's statistical landmine: if ONE company supplies most of a category's candidate
// pool, the case-control model learns "is this company X" instead of "what makes a page win".
// A loser pool dominated by a single domain biases the model. This analysis quantifies that
// concentration so the caller can refuse / reweight a degenerate pool rather than train on it.
//
// Operates on ONE category's pool (the caller groups by vertical before calling — we do not
// know about verticals here). Grouping is on the NORMALIZED company_domain (normalizeDomain —
// the contract's #1 join key); we never invent a key format. Pure, defensive: a page whose
// domain is garbage ("" after normalization) is EXCLUDED from counts entirely, same posture as
// labeling.ts — we do not classify garbage, but we never crash on it either.

import type { CandidatePage } from "../contract-records";
import { normalizeDomain } from "../normalize";

/** One company's footprint in the pool. `company_domain` is the NORMALIZED key. */
export interface DomainShare {
  company_domain: string;
  n_pages: number;
  /** n_pages / n_pages_total (total = KEPT pages only; garbage is excluded from the denominator). */
  share: number;
}

export interface CompositionReport {
  /** Count of KEPT pages (pages whose domain normalized to "" are not counted). */
  n_pages: number;
  /** Distinct normalized company_domain values among kept pages. */
  n_companies: number;
  /** Desc by n_pages, then company_domain asc. share = n_pages / n_pages_total. */
  shares: DomainShare[];
  /** True iff any share is STRICTLY above dominanceThreshold (so exactly-threshold is fine). */
  dominated: boolean;
  /** The shares strictly above the threshold — the companies that bias the pool. */
  offenders: DomainShare[];
}

/**
 * Assess how concentrated a single category's candidate pool is across companies.
 *
 * @param pool One vertical's candidate pages (caller pre-groups by vertical).
 * @param opts.dominanceThreshold Share above which a single company is considered to dominate.
 *   Default 0.5. Comparison is STRICT (`>`): a company holding exactly the threshold share is NOT
 *   an offender, so a perfectly even 2-way split at the 0.5 default is reported as not dominated.
 * @returns A CompositionReport. An empty (or all-garbage) pool yields all zeros / empties / false
 *   — never NaN (we never divide by a zero total).
 */
export function assessPoolComposition(
  pool: CandidatePage[],
  opts?: { dominanceThreshold?: number },
): CompositionReport {
  const dominanceThreshold = opts?.dominanceThreshold ?? 0.5;

  // Count pages per normalized domain. Garbage domains ("" after normalization) are dropped here
  // so they affect neither the counts nor the denominator — the same "do not classify garbage"
  // stance as labeling.ts. Map preserves no ordering we rely on; we sort explicitly below.
  const counts = new Map<string, number>();
  for (const page of pool) {
    const domain = normalizeDomain(page.company_domain);
    if (domain === "") continue; // garbage → excluded from counts, never crashes
    counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }

  // Denominator is the count of KEPT pages only. When every page was garbage (or the pool was
  // empty) this is 0, and we must NOT compute any share (0/0 = NaN). The map is empty in that
  // case, so the shares loop below simply produces [], and we return zeros.
  const n_pages_total = Array.from(counts.values()).reduce((sum, n) => sum + n, 0);

  // Build the shares, then sort: primary desc by n_pages (the most-concentrated company first),
  // tiebreak by company_domain ascending for a deterministic, reproducible order.
  const shares: DomainShare[] = Array.from(counts.entries())
    .map(([company_domain, n_pages]) => ({
      company_domain,
      n_pages,
      share: n_pages / n_pages_total,
    }))
    .sort((a, b) =>
      b.n_pages - a.n_pages || a.company_domain.localeCompare(b.company_domain),
    );

  // Offenders are the companies STRICTLY above the threshold. Strict `>` is the whole point of the
  // boundary rule: a company sitting exactly at the threshold is acceptable, not an offender.
  const offenders = shares.filter((s) => s.share > dominanceThreshold);

  return {
    n_pages: n_pages_total,
    n_companies: counts.size,
    shares,
    dominated: offenders.length > 0,
    offenders,
  };
}
