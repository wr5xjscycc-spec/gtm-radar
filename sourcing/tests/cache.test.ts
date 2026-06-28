// P3 · Phase 5 required test: cache hit/miss tests for the page-feature cache.
//
// Proves the unit-economics lever: a VALID cached competitor `page` lets the 2nd+
// customer in a vertical skip the expensive scrape + gpt-4o-mini extraction. The
// invalidation policy is NOT exercised here — we inject stub validators
// (() => true / () => false) so this file is fully self-contained (no network).

import { describe, it, expect, vi } from "vitest";

import { PageCache, InMemoryCacheStore } from "../src/cache";
import { normalizeUrl } from "../src/content";
import type { CacheValidityContext, ContentFeatures, Page } from "../src/types";

const CTX: CacheValidityContext = {
  now: "2026-06-27T00:00:00Z",
  freshnessDays: 30,
  expectedExtractorVersion: "content@v1+subj",
  expectedQueryTermsHash: "noqt", // matches the `noqt` segment in makePage's cache_key
};

const FEATURES: ContentFeatures = {
  schema_markup: true,
  comparison_table: true,
  word_count: 420,
  heading_structure: { h1: 1, h2: 2, h3: 0 },
  freshness_days: 7,
  query_term_coverage: 0.5,
};

/** Build a minimal contract-shaped Page; url + cache_key overridable. */
function makePage(overrides: Partial<Page> = {}): Page {
  const url = overrides.url ?? "https://competitor.com/best-crm";
  return {
    company_domain: "competitor.com",
    url,
    role: "competitor",
    content_features: FEATURES,
    extractor_version: "content@v1+subj",
    scraped_at: "2026-06-20T00:00:00Z",
    cache_key: "competitor.com|deadbeef|noqt|content@v1+subj",
    ...overrides,
  };
}

describe("PageCache hit/miss", () => {
  it("MISS on empty store, then HIT after put (by cache_key)", async () => {
    const cache = new PageCache();
    const page = makePage();

    const miss = await cache.getByKey(page.cache_key, CTX);
    expect(miss).toBeUndefined();
    expect(cache.stats().misses).toBe(1);
    expect(cache.stats().hits).toBe(0);

    await cache.put(page, CTX);
    const hit = await cache.getByKey(page.cache_key, CTX);
    expect(hit).toEqual(page);
    expect(cache.stats().hits).toBe(1);
    expect(cache.stats().stored).toBe(1);
  });

  it("invalid entry is a MISS, never a stale hit", async () => {
    // isValid always false: even though the entry EXISTS it must not be served.
    const cache = new PageCache({ isValid: () => false });
    const page = makePage();
    await cache.put(page, CTX);

    const result = await cache.getByKey(page.cache_key, CTX);
    expect(result).toBeUndefined();
    expect(cache.stats().misses).toBe(1);
    expect(cache.stats().hits).toBe(0);
  });

  it("getByUrl normalizes a messy-but-equivalent url and finds the entry", async () => {
    const cache = new PageCache();
    // stored under the clean normalized url...
    const page = makePage({ url: "https://competitor.com/best-crm" });
    await cache.put(page, CTX);

    // ...looked up with www / mixed case / trailing slash / fragment.
    const messy = "https://WWW.Competitor.com/best-crm/#pricing";
    expect(normalizeUrl(messy)).toBe(normalizeUrl(page.url)); // sanity
    const found = await cache.getByUrl(messy, CTX);
    expect(found).toEqual(page);
    expect(cache.stats().hits).toBe(1);
  });

  it("getByUrl on an unknown url is a miss", async () => {
    const cache = new PageCache();
    const found = await cache.getByUrl("https://nobody.com/x", CTX);
    expect(found).toBeUndefined();
    expect(cache.stats().misses).toBe(1);
  });
});

describe("cross-customer reuse (the cost lever)", () => {
  it("customer A enriches+stores; customer B reuses without re-enriching", async () => {
    // ONE shared cache serves every customer in the vertical — the reuse seam.
    const cache = new PageCache();
    const url = "https://competitor.com/best-crm";
    const competitorPage = makePage({ url });

    // Customer A: cold → miss → enrich runs ONCE → result stored + indexed.
    const enrichA = vi.fn(async () => competitorPage);
    const a = await cache.resolveOrEnrich(url, CTX, enrichA);
    expect(a.hit).toBe(false);
    expect(enrichA).toHaveBeenCalledTimes(1);
    expect(cache.stats().misses).toBe(1);
    expect(cache.stats().stored).toBe(1);

    // Customer B: same vertical, same competitor url (messy form) → warm cache.
    // The valid cached entry is reused, so B's enrich is NEVER called.
    const enrichB = vi.fn(async () => competitorPage);
    const b = await cache.resolveOrEnrich("https://WWW.Competitor.com/best-crm/", CTX, enrichB);
    expect(b.hit).toBe(true);
    expect(b.page).toEqual(competitorPage);
    expect(enrichB).not.toHaveBeenCalled(); // the expensive scrape+extract is SKIPPED
    expect(cache.stats().reuses).toBe(1);
  });

  it("a valid hit on getByUrl counts as a reuse", async () => {
    const cache = new PageCache();
    const url = "https://competitor.com/best-crm";
    await cache.put(makePage({ url }), CTX);

    expect(cache.stats().reuses).toBe(0);
    await cache.getByUrl(url, CTX);
    expect(cache.stats().reuses).toBe(1);
  });

  it("an invalid entry via getByUrl is NOT a reuse", async () => {
    const cache = new PageCache({ isValid: () => false });
    const url = "https://competitor.com/best-crm";
    await cache.put(makePage({ url }), CTX);

    const result = await cache.getByUrl(url, CTX);
    expect(result).toBeUndefined();
    expect(cache.stats().reuses).toBe(0);
    expect(cache.stats().misses).toBe(1);
  });
});

describe("InMemoryCacheStore (the PORT stub)", () => {
  it("is keyed by cache_key and is injectable into PageCache", async () => {
    const store = new InMemoryCacheStore();
    const page = makePage({ cache_key: "shared-key" });
    await store.set(page);
    expect(await store.get("shared-key")).toEqual(page);
    expect(await store.get("absent")).toBeUndefined();

    // Two PageCaches over ONE store share entries at the cache_key level.
    const c1 = new PageCache({ store });
    const c2 = new PageCache({ store });
    await c1.put(makePage({ cache_key: "k-shared" }), CTX);
    expect(await c2.getByKey("k-shared", CTX)).toBeDefined();
  });
});

describe("bookkeeping", () => {
  it("put increments stored", async () => {
    const cache = new PageCache();
    await cache.put(makePage({ url: "https://a.com/1", cache_key: "k1" }), CTX);
    await cache.put(makePage({ url: "https://a.com/2", cache_key: "k2" }), CTX);
    expect(cache.stats().stored).toBe(2);
  });

  it("stats() returns a copy — mutating it doesn't change internal state", async () => {
    const cache = new PageCache();
    const snap = cache.stats();
    snap.hits = 999;
    snap.misses = 999;
    expect(cache.stats().hits).toBe(0);
    expect(cache.stats().misses).toBe(0);
  });
});
