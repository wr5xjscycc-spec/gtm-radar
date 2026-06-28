// Candidate-pool sourcing (P3 · Phase 3, task #1) — the classic-search RANKED set.
//
// For each `query` (CONTRACT.md #4) we fetch the pages that rank in CLASSIC search
// (a SERP organic lookup) and record them as candidate-pool rows (CONTRACT.md #3
// adjacent — types.ts `CandidatePoolEntry`). This is the "could-have-been-cited"
// set that P2 labels against: a page CITED by an answer engine is a winner; a page
// that was RETRIEVED/CONSIDERED here but NOT cited is a loser.
//
// WHY THIS POOL AND NOT "ALL UNCITED PAGES" (the load-bearing design choice):
// This is a CASE-CONTROL design (ORCHESTRATION.md §6). A "loser" must be a page the
// search system actually surfaced for the query — a control that was eligible to be
// cited — NOT an arbitrary uncited page from the open web. If losers were "everything
// not cited", the model would mostly learn "is this page even relevant/retrievable?"
// (a trivial, confounded signal) instead of "given two retrievable pages, why was one
// cited?". Restricting the pool to the classic-search ranked set holds relevance/
// retrievability roughly fixed across winners and losers, which is what makes the
// resulting model a defensible explanation of citation rather than a selection-biased
// artifact. The phase card is explicit: a principled candidate pool is the difference
// between a defensible model and a biased one — don't shortcut it to "all uncited pages".
//
// Lane discipline (mirrors fiber.ts / queries.ts): the SERP ranking source is reached
// through a PORT (`SerpRankingClient`). Real impls call DataForSEO / SerpAPI; unit tests
// inject a mock. This module imports no SDK and touches no network.

import { normalizeUrl } from "./content";
import type { CandidatePoolEntry, CandidateSource, Query } from "./types";

/** Stable version tag for the candidate-pool construction (provenance / versioning). */
export const CANDIDATE_POOL_VERSION = "candidate-pool/serp-organic@v1";

/** The candidate source these entries carry. */
const SOURCE: CandidateSource = "serp_organic";

/**
 * Default per-query cap on the pool — the classic-search "considered" set is the
 * TOP-N organic results, not the long tail. 10 mirrors a standard first-page SERP.
 * Beyond the cap, results are dropped DELIBERATELY as the documented top-N, never
 * silently lost mid-pipeline.
 */
export const DEFAULT_PER_QUERY_LIMIT = 10;

// ─────────────────────────────────────────────────────────────────────────────
// SERP classic-search port — mirrors FiberClient. Real impl calls DataForSEO /
// SerpAPI for organic rankings; tests pass a mock. Keeping it an interface is what
// keeps CI deterministic and free (no live vendor calls).
// ─────────────────────────────────────────────────────────────────────────────

/** One organic result from a classic-search SERP (the fields we consume). */
export interface SerpOrganicResult {
  /** Result URL — raw is fine; normalized into the join key on write. */
  url: string;
  /** 1-based organic rank, when the SERP provides it. */
  rank?: number;
}

/**
 * The SERP ranking port. The real implementation calls a classic-search SERP API
 * (DataForSEO / SerpAPI); tests pass a mock. `limit` is a soft cap forwarded to the
 * vendor; `vertical` lets the lookup be scoped (e.g. localization / category).
 */
export interface SerpRankingClient {
  classicSearch(args: {
    query: string;
    vertical?: string;
    limit?: number;
  }): Promise<SerpOrganicResult[]>;
}

export interface BuildCandidatePoolOptions {
  /** Per-query cap on pool size (top-N classic-search results). Defaults to DEFAULT_PER_QUERY_LIMIT. */
  perQueryLimit?: number;
}

/**
 * Build the candidate pool across a set of queries.
 *
 * For each query we ask the SERP port for the classic-search organic results and map
 * each one to a `CandidatePoolEntry`:
 *   - query_id  = q.id (FK to the `query` record),
 *   - page_url  = normalizeUrl(result.url) — the NORMALIZED join key to `page`,
 *   - rank      = result.rank when present, else the 1-based POSITION in the returned
 *                 list (the SERP order is itself the ranking when no rank is given),
 *   - source    = "serp_organic".
 *
 * Conventions (documented so downstream lanes can rely on them):
 *   - NORMALIZE: every page_url goes through normalizeUrl. A url that won't normalize
 *     is SKIPPED (never emitted with a raw url) so it can't poison the join surface.
 *   - WITHIN-QUERY DEDUPE: a url that appears more than once for the SAME query is
 *     collapsed to ONE entry keeping the BEST (lowest) rank — the strongest evidence
 *     of how the search system surfaced it.
 *   - NO CROSS-QUERY DEDUPE: the same page may legitimately be in MULTIPLE queries'
 *     pools (it was independently considered for each query); those are distinct rows.
 *   - CAP: each query's pool is capped at `perQueryLimit` (default DEFAULT_PER_QUERY_LIMIT)
 *     by rank — the documented top-N "considered" set, applied AFTER dedupe.
 *
 * Returns the flat CandidatePoolEntry[] across all queries.
 */
export async function buildCandidatePool(
  serp: SerpRankingClient,
  queries: Query[],
  opts: BuildCandidatePoolOptions = {},
): Promise<CandidatePoolEntry[]> {
  const perQueryLimit = opts.perQueryLimit ?? DEFAULT_PER_QUERY_LIMIT;
  const out: CandidatePoolEntry[] = [];

  for (const q of queries ?? []) {
    const results = (await serp.classicSearch({
      query: q.text,
      vertical: q.vertical,
      limit: perQueryLimit,
    })) ?? [];

    // Rank policy is ALL-OR-NOTHING per query: trust SERP-provided ranks only when
    // EVERY result carries one; otherwise fall back to 1-based position for all.
    // (Mixing provided + positional within one query would yield a non-ordinal rank
    // field — e.g. a provided 9 next to a positional 2 — that P2 can't reason about.)
    const useProvidedRank = results.every((r) => typeof r?.rank === "number");

    // Within-query dedupe by normalized url, keeping the best (lowest) rank.
    const byUrl = new Map<string, CandidatePoolEntry>();
    results.forEach((result, index) => {
      if (!result?.url) return; // skip malformed entries
      let pageUrl: string;
      try {
        pageUrl = normalizeUrl(result.url);
      } catch {
        return; // unparseable url → skip (don't poison the join surface)
      }
      const rank = useProvidedRank ? (result.rank as number) : index + 1;
      const existing = byUrl.get(pageUrl);
      if (existing && existing.rank <= rank) return; // keep the best (lowest) rank
      byUrl.set(pageUrl, { query_id: q.id, page_url: pageUrl, rank, source: SOURCE });
    });

    // Cap at the documented top-N by rank (ascending), then append.
    const entries = [...byUrl.values()]
      .sort((a, b) => a.rank - b.rank)
      .slice(0, Math.max(0, perQueryLimit));
    out.push(...entries);
  }

  return out;
}

/**
 * Filter helper — the candidate pool for a single query, sorted by rank ascending
 * (best classic-search position first). Returns a new array; does not mutate input.
 */
export function poolForQuery(pool: CandidatePoolEntry[], queryId: string): CandidatePoolEntry[] {
  return (pool ?? [])
    .filter((entry) => entry.query_id === queryId)
    .sort((a, b) => a.rank - b.rank);
}
