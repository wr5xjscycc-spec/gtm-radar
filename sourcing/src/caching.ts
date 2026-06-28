// P3 · Phase 5 — caching integration.
//
// Composes the two halves of the cost lever: the cache STORE (cache.ts, keyed on
// cache_key with a URL index for cross-customer reuse) and the invalidation
// POLICY (invalidation.ts, freshness window + extractor_version). The cache class
// defaults its validator to always-valid so it stays self-contained and unit-
// testable; this factory injects the REAL policy so production caches actually
// expire stale / old-extractor entries.

import { PageCache, type CacheStore } from "./cache";
import { isCacheEntryValid, DEFAULT_FRESHNESS_DAYS } from "./invalidation";
import { queryTermsHash } from "./content";
import type { CacheValidityContext } from "./types";

export interface CreatePageCacheOptions {
  /** Backing store (defaults to the in-memory store inside PageCache). */
  store?: CacheStore;
}

/**
 * A PageCache wired with the real freshness + extractor-version invalidation
 * policy. Use this in production paths; the bare `PageCache` (always-valid) is for
 * isolated unit tests.
 */
export function createPageCache(opts: CreatePageCacheOptions = {}): PageCache {
  return new PageCache({ store: opts.store, isValid: isCacheEntryValid });
}

export interface CacheContextOptions {
  /**
   * The EFFECTIVE extractor version the caller is running — including the subjective
   * marker (`content-features@v1+subj` / `+subj-err` / base). It must match what
   * `enrichPages` stamps, or every lookup misses and the cost lever silently does
   * nothing (correctness is never at risk — a mismatch only forces a re-enrich).
   */
  expectedExtractorVersion: string;
  /** The caller's query-term set — hashed exactly as `cache_key` hashes it. */
  queryTerms?: string[];
  /** Max cached-entry age before stale (defaults to the standard re-measurement cadence). */
  freshnessDays?: number;
}

/**
 * Build a validity context for a given clock + the caller's extractor/query pack.
 * The query terms are hashed with the SAME function `cache_key` uses, so url-based
 * reuse is correctly scoped to this customer's query pack (no cross-pack mis-serve).
 */
export function cacheContext(now: string, opts: CacheContextOptions): CacheValidityContext {
  return {
    now,
    freshnessDays: opts.freshnessDays ?? DEFAULT_FRESHNESS_DAYS,
    expectedExtractorVersion: opts.expectedExtractorVersion,
    expectedQueryTermsHash: queryTermsHash(opts.queryTerms),
  };
}
