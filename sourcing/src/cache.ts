// P3 · Phase 5 task #1 — the page-feature cache store + cross-customer reuse.
//
// THIS IS THE UNIT-ECONOMICS LEVER (the #1 surviving risk per the phase card).
// Battlefield competitors overlap heavily across customers in the SAME vertical:
// the 2nd, 3rd, … customer who scans a given competitor URL would otherwise pay
// the full expensive scrape + gpt-4o-mini extraction again. This cache lets a
// VALID prior entry be reused instead, so that re-enrich is skipped and the
// measured cost drops.
//
// Entries are keyed on `cache_key` (see content.ts) which already embeds the
// normalized domain + content hash + extractor_version. Because extractor_version
// is baked into the key, a change to the extractor yields a DIFFERENT key — an old
// extractor's features can never collide with a new one's. We ALSO guard reuse
// behind an injected `isValid` predicate (freshness + current extractor): a stale
// or wrong-extractor entry is treated as a MISS and is never served.
//
// The real store is Convex; tests inject an in-memory stub. No network lives here.
// The invalidation PREDICATE is built elsewhere and injected as a `CacheValidator`;
// this module defaults it to always-valid so it stays self-contained.

import { normalizeUrl } from "./content";
import type { CacheValidator, CacheValidityContext, Page } from "./types";

/**
 * The pre-scrape REUSE identity for the url index. A page's feature vector depends
 * on its url, the query-term set (`query_term_coverage` is customer-specific), and
 * the extractor version — all known to a caller BEFORE scraping (unlike the content
 * hash). Keying reuse on all three is what stops customer B (query pack QB) from
 * being served customer A's page (query pack QA) for the same competitor url.
 */
export function reuseKey(
  url: string,
  queryTermsHash: string,
  extractorVersion: string,
): string {
  return `${normalizeUrl(url)}|${queryTermsHash}|${extractorVersion}`;
}

/** Build the reuse key for a given lookup/store from its validity context. */
function reuseKeyFor(url: string, ctx: CacheValidityContext): string {
  return reuseKey(url, ctx.expectedQueryTermsHash, ctx.expectedExtractorVersion);
}

/**
 * The cache PORT — keyed by `cache_key`. The real implementation is Convex-backed;
 * unit tests pass an in-memory stub. Keeping it an interface is what keeps the
 * cache logic testable with NO network (docs/TESTING.md rule 1).
 */
export interface CacheStore {
  get(cacheKey: string): Promise<Page | undefined>;
  set(page: Page): Promise<void>;
}

/**
 * A simple Map-backed `CacheStore`. Used as the default store and in tests.
 * Keyed by `cache_key` (NOT url) so the same content hash + extractor reuses one
 * slot regardless of which customer first stored it.
 */
export class InMemoryCacheStore implements CacheStore {
  private readonly byKey = new Map<string, Page>();

  async get(cacheKey: string): Promise<Page | undefined> {
    return this.byKey.get(cacheKey);
  }

  async set(page: Page): Promise<void> {
    this.byKey.set(page.cache_key, page);
  }
}

/**
 * Counters backing the "measured cost drop" story.
 *  - hits    : getByKey/getByUrl found a VALID entry.
 *  - misses  : absent OR present-but-invalid (a stale entry never counts as a hit).
 *  - stored  : pages written via put().
 *  - reuses  : cross-customer hits resolved through the reuse index (getByUrl) that
 *              avoided a re-enrich — the direct dollar saving.
 */
export interface CacheStats {
  hits: number;
  misses: number;
  stored: number;
  reuses: number;
}

/**
 * Construction options. `isValid` defaults to always-valid so this module is
 * self-contained; the real freshness/extractor policy is injected at integration.
 */
export interface PageCacheOptions {
  store?: CacheStore;
  isValid?: CacheValidator;
}

/**
 * PageCache — the cross-customer reuse layer over a `CacheStore`.
 *
 * It maintains a reuse index (url + query-term set + extractor → cache_key) so a
 * SECOND customer scanning the same competitor URL can find the cached entry
 * WITHOUT knowing the content hash up front — while a customer with a DIFFERENT
 * query pack is correctly scoped out (their coverage differs). A lookup is only
 * served when the entry is still valid; an invalid (stale / old-extractor) entry
 * is a miss, never a stale hit.
 */
export class PageCache {
  private readonly store: CacheStore;
  private readonly isValid: CacheValidator;
  /** reuseKey(url, queryTermsHash, extractorVersion) → cache_key (query-term-scoped). */
  private readonly urlIndex = new Map<string, string>();
  private readonly counters: CacheStats = { hits: 0, misses: 0, stored: 0, reuses: 0 };

  constructor(opts: PageCacheOptions = {}) {
    this.store = opts.store ?? new InMemoryCacheStore();
    this.isValid = opts.isValid ?? (() => true);
  }

  /**
   * Look up by `cache_key`. Returns the page only when it is present AND still
   * valid for `ctx` (fresh + current extractor). A present-but-invalid entry is
   * a MISS — we never serve a stale or old-extractor feature vector.
   */
  async getByKey(cacheKey: string, ctx: CacheValidityContext): Promise<Page | undefined> {
    const page = await this.store.get(cacheKey);
    if (page && this.isValid(page, ctx)) {
      this.counters.hits++;
      return page;
    }
    // absent, or present-but-invalid → treat as a miss (don't serve stale data).
    this.counters.misses++;
    return undefined;
  }

  /**
   * Cross-customer reuse path: resolve a (possibly messy) url through the URL
   * index → cache_key → getByKey. A valid hit here also counts as a `reuse` (a
   * competitor scrape another customer already paid for). An unknown url is a miss.
   */
  async getByUrl(url: string, ctx: CacheValidityContext): Promise<Page | undefined> {
    const cacheKey = this.urlIndex.get(reuseKeyFor(url, ctx));
    if (cacheKey === undefined) {
      this.counters.misses++;
      return undefined;
    }
    const before = this.counters.hits;
    const page = await this.getByKey(cacheKey, ctx);
    if (page && this.counters.hits > before) this.counters.reuses++;
    return page;
  }

  /**
   * Store an enriched page: write it under its `cache_key` and index it for url-
   * based reuse under (url + query-term set + extractor), all taken from `ctx` —
   * the page was enriched FOR this context, so this is the identity under which it
   * may be safely reused. A different query pack builds a different reuse key and
   * therefore can NEVER resolve to this entry. Increments `stored`.
   */
  async put(page: Page, ctx: CacheValidityContext): Promise<void> {
    await this.store.set(page);
    this.urlIndex.set(reuseKeyFor(page.url, ctx), page.cache_key);
    this.counters.stored++;
  }

  /**
   * The cost-saving entry point. Resolve the url through the cache; on a VALID hit
   * return it WITHOUT calling `enrich` (the scrape + extraction is skipped). On a
   * miss, run `enrich` (the expensive path), store the result, and return it.
   */
  async resolveOrEnrich(
    url: string,
    ctx: CacheValidityContext,
    enrich: () => Promise<Page>,
  ): Promise<{ page: Page; hit: boolean }> {
    const cached = await this.getByUrl(url, ctx);
    if (cached) return { page: cached, hit: true };
    const page = await enrich();
    await this.put(page, ctx);
    return { page, hit: false };
  }

  /** Return a COPY of the counters (mutating it must not touch internal state). */
  stats(): CacheStats {
    return { ...this.counters };
  }
}
