// P2 (Measurement) — citation→page mapping and CASE-CONTROL labeling.
//
// The case-control rule (ORCHESTRATION.md §6, P2 brief Phase 2) is a statistical-correctness
// requirement, not a detail: a "loser" is a page that was retrieved/considered — i.e. it is IN
// the candidate pool — but was NOT cited. A loser is NEVER an arbitrary uncited page from
// OUTSIDE the pool; building it any other way reintroduces selection bias. So labeling only ever
// draws winners/losers FROM the candidate pool passed in. The pool is an explicit parameter — we
// do not derive or assemble it here (that is P3's job; the query→pool mapping is not yet pinned).
//
// Domains are compared on the normalized key (normalize.ts) — the contract's join key.

import type { Citation } from "./types";
import type { CandidatePage } from "./contract-records";
import { normalizeDomain } from "./normalize";

/**
 * Partition a candidate pool into citation winners and losers (case-control).
 *
 * @param citedDomains Domains the engine cited. Callers may pass raw URLs or mixed case, so each
 *   entry is normalized defensively via `normalizeDomain`; entries that normalize to "" are dropped.
 * @param candidatePool The retrieved/considered pages. The ONLY source of winners and losers —
 *   nothing outside this pool can ever be labeled.
 * @returns `winners` (in-pool pages whose normalized domain was cited) and `losers` (in-pool pages
 *   that were not). Pages whose `company_domain` normalizes to "" are skipped entirely (defensive —
 *   we do not classify garbage). Returned pages are the original pool objects, by reference.
 */
export function labelCaseControl(
  citedDomains: Iterable<string>,
  candidatePool: CandidatePage[],
): { winners: CandidatePage[]; losers: CandidatePage[] } {
  // Normalized cited-domain set. `citedDomains` is an Iterable (not necessarily an Array), so
  // consume it with for...of. Drop anything that normalizes to "" so it can never match.
  const cited = new Set<string>();
  for (const d of citedDomains) {
    const norm = normalizeDomain(d);
    if (norm !== "") cited.add(norm);
  }

  const winners: CandidatePage[] = [];
  const losers: CandidatePage[] = [];

  // Iterate ONLY the pool — this is what keeps the case-control invariant intact.
  for (const page of candidatePool) {
    const pageDomain = normalizeDomain(page.company_domain);
    if (pageDomain === "") continue; // garbage domain → classify nothing
    if (cited.has(pageDomain)) {
      winners.push(page); // original reference, not a clone
    } else {
      losers.push(page);
    }
  }

  return { winners, losers };
}

/**
 * Map each page to whether (and where) its domain was cited.
 *
 * For each page, in input order, find the FIRST citation whose `domain` equals the page's
 * normalized `company_domain`. `Citation.domain` is already normalized (see types.ts), so it is
 * compared as-is. `position` is that citation's 1-based `rank` (NOT its array index), or `null`
 * when the page was not cited. Pages whose domain normalizes to "" are reported as uncited.
 *
 * @returns One entry per input page, in order, each carrying the original page reference.
 */
export function mapCitationsToPages(
  citations: Citation[],
  pages: CandidatePage[],
): Array<{ page: CandidatePage; cited: boolean; position: number | null }> {
  return pages.map((page) => {
    const pageDomain = normalizeDomain(page.company_domain);
    // Short-circuit BEFORE the search: a "" page domain must never match a citation whose own
    // domain normalized to "".
    if (pageDomain === "") return { page, cited: false, position: null };

    const match = citations.find((c) => c.domain === pageDomain);
    return match
      ? { page, cited: true, position: match.rank }
      : { page, cited: false, position: null };
  });
}
