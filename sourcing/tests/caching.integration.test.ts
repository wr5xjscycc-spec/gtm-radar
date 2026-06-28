// P3 · Phase 5 — integration: the cache STORE composed with the real invalidation
// POLICY (the DoD: a second customer in the same vertical reuses cached competitor
// data; stale / old-extractor entries are NOT reused). No vendors, no network.

import { describe, it, expect } from "vitest";

import { createPageCache, cacheContext } from "../src/caching";
import { InMemoryCacheStore } from "../src/cache";
import type { Page } from "../src/types";

const EXTRACTOR = "content-features@v1";

function makePage(overrides: Partial<Page> = {}): Page {
  const url = overrides.url ?? "https://competitor.com/pricing";
  return {
    company_domain: "competitor.com",
    url,
    role: "candidate",
    content_features: {
      schema_markup: true,
      comparison_table: true,
      word_count: 1200,
      heading_structure: 7, // h1=1 + h2=4 + h3=2
      freshness_days: 5,
      query_term_coverage: 0.6,
    },
    extractor_version: EXTRACTOR,
    scraped_at: Date.parse("2026-06-01T00:00:00.000Z"),
    cache_key: "competitor.com|abc123|noqt|content-features@v1",
    ...overrides,
  };
}

describe("Phase 5 caching integration (store + invalidation)", () => {
  it("DoD: a 2nd customer in the same vertical reuses a FRESH cached competitor page (no re-enrich)", async () => {
    // Shared category cache across customers in one vertical.
    const cache = createPageCache({ store: new InMemoryCacheStore() });
    const now = "2026-06-10T00:00:00.000Z"; // 9 days after scrape — within 30d window
    const ctx = cacheContext(now, { expectedExtractorVersion: EXTRACTOR });

    let enrichCalls = 0;
    const enrich = async () => {
      enrichCalls += 1;
      return makePage();
    };

    // Customer A: miss → enrich + store.
    const a = await cache.resolveOrEnrich("https://competitor.com/pricing", ctx, enrich);
    expect(a.hit).toBe(false);
    expect(enrichCalls).toBe(1);

    // Customer B: same competitor URL, SAME query pack → valid hit, no re-enrich.
    const b = await cache.resolveOrEnrich("https://WWW.Competitor.com/pricing/", ctx, enrich);
    expect(b.hit).toBe(true);
    expect(enrichCalls).toBe(1); // the cost saving
    expect(cache.stats().reuses).toBeGreaterThanOrEqual(1);
  });

  it("a different QUERY PACK does NOT reuse another customer's page (no wrong query_term_coverage)", async () => {
    // The subtle correctness guard: query_term_coverage is customer-specific, so B
    // with a different query pack must re-enrich its OWN page, not inherit A's.
    const cache = createPageCache({ store: new InMemoryCacheStore() });
    const now = "2026-06-10T00:00:00.000Z";
    const url = "https://competitor.com/pricing";

    const pageA = makePage({ cache_key: "competitor.com|abc|HASH_A|content-features@v1" });
    const pageB = makePage({ cache_key: "competitor.com|abc|HASH_B|content-features@v1" });

    let aCalls = 0;
    let bCalls = 0;
    const a = await cache.resolveOrEnrich(
      url,
      cacheContext(now, { expectedExtractorVersion: EXTRACTOR, queryTerms: ["crm"] }),
      async () => ((aCalls += 1), pageA),
    );
    const b = await cache.resolveOrEnrich(
      url,
      cacheContext(now, { expectedExtractorVersion: EXTRACTOR, queryTerms: ["pricing software"] }),
      async () => ((bCalls += 1), pageB),
    );

    expect(a.hit).toBe(false);
    expect(b.hit).toBe(false); // B did NOT reuse A's entry
    expect(bCalls).toBe(1); // B enriched its own page
    expect(b.page).toBe(pageB); // ...and got ITS page, never A's coverage vector
  });

  it("invalidation: a STALE entry (beyond the freshness window) is re-enriched, not reused", async () => {
    const cache = createPageCache({ store: new InMemoryCacheStore() });
    const ctx = cacheContext("2026-06-10T00:00:00.000Z", { expectedExtractorVersion: EXTRACTOR });
    await cache.put(makePage({ scraped_at: Date.parse("2026-01-01T00:00:00.000Z") }), ctx); // ~5 months old

    let enrichCalls = 0;
    const enrich = async () => {
      enrichCalls += 1;
      return makePage({ scraped_at: Date.parse("2026-06-10T00:00:00.000Z") });
    };
    const r = await cache.resolveOrEnrich("https://competitor.com/pricing", ctx, enrich);

    expect(r.hit).toBe(false); // stale → miss
    expect(enrichCalls).toBe(1); // forced a fresh enrich
  });

  it("invalidation: an OLD-extractor entry is not served when the current extractor differs", async () => {
    const cache = createPageCache({ store: new InMemoryCacheStore() });
    const v1Page = makePage({ extractor_version: "content-features@v1" });
    await cache.put(v1Page, cacheContext("2026-06-05T00:00:00.000Z", { expectedExtractorVersion: "content-features@v1" }));

    // Caller is now running v2 — getByKey finds the v1 entry but the validity
    // policy rejects it (extractor changed), so it is NEVER served.
    const ctxV2 = cacheContext("2026-06-05T00:00:00.000Z", { expectedExtractorVersion: "content-features@v2" });
    expect(await cache.getByKey(v1Page.cache_key, ctxV2)).toBeUndefined();
  });
});
