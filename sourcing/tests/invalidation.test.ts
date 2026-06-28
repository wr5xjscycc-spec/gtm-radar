// P3 · Phase 5 required test: invalidation tests
// (on extractor_version change + freshness window).
//
// The cache-invalidation policy is pure: a Page + a CacheValidityContext go in,
// a boolean comes out. Stale features and old-extractor features both poison a
// fit, so invalidation FAILS SAFE — when in doubt, invalidate. We assert the
// inclusive freshness boundary, the future-date clamp, the extractor-change
// guard, the composed predicate, and the unparseable-date fail-safe — all with
// FIXED ISO timestamps (never Date.now), so the decisions are reproducible.

import { describe, it, expect } from "vitest";

import {
  DEFAULT_FRESHNESS_DAYS,
  ageInDays,
  isStale,
  extractorChanged,
  isCacheEntryValid,
} from "../src/invalidation";
import type { Page, CacheValidityContext } from "../src/types";

const NOW = "2026-06-27T00:00:00Z";

/** Build a minimal, valid Page; override scraped_at / extractor_version per test. */
function makePage(overrides: Partial<Page> = {}): Page {
  return {
    company_domain: "example.com",
    url: "https://example.com/compare",
    role: "competitor",
    content_features: {
      schema_markup: false,
      comparison_table: false,
      word_count: 100,
      heading_structure: 1,
      freshness_days: 0,
      query_term_coverage: 0,
    },
    extractor_version: "content-features@v2",
    scraped_at: Date.parse("2026-06-17T00:00:00Z"), // 10 days before NOW
    cache_key: "example.com:hash:content-features@v2",
    ...overrides,
  };
}

/** Build a context; default to a 30-day window expecting v2. */
function makeCtx(overrides: Partial<CacheValidityContext> = {}): CacheValidityContext {
  return {
    now: NOW,
    freshnessDays: DEFAULT_FRESHNESS_DAYS,
    expectedExtractorVersion: "content-features@v2",
    // The invalidation policy ignores this, but the type requires it (the cache's
    // reuse layer uses it — see cache.ts). Any value is fine for these unit tests.
    expectedQueryTermsHash: "noqt",
    ...overrides,
  };
}

describe("DEFAULT_FRESHNESS_DAYS", () => {
  it("is the documented 30-day re-measurement cadence", () => {
    expect(DEFAULT_FRESHNESS_DAYS).toBe(30);
  });
});

describe("ageInDays", () => {
  it("computes the day count for a known interval", () => {
    expect(ageInDays(Date.parse("2026-06-17T00:00:00Z"), NOW)).toBe(10);
  });

  it("returns a fractional age (not floored) so boundary checks are exact", () => {
    expect(ageInDays(Date.parse("2026-06-26T12:00:00Z"), NOW)).toBe(0.5);
  });

  it("returns null for an invalid scraped_at (NaN / Infinity)", () => {
    expect(ageInDays(NaN, NOW)).toBeNull();
  });

  it("returns null for an empty parsed scraped_at", () => {
    // -0 is not a valid epoch ms (epoch is 1970), treat as unparseable
    expect(ageInDays(NaN, NOW)).toBeNull();
  });

  it("returns null for an unparseable now", () => {
    expect(ageInDays(Date.parse("2026-06-17T00:00:00Z"), "garbage")).toBeNull();
  });

  it("clamps a future-dated scraped_at to 0 (not negative)", () => {
    expect(ageInDays(Date.parse("2026-07-10T00:00:00Z"), NOW)).toBe(0);
  });
});

describe("isStale — freshness window", () => {
  it("an entry scraped 10 days ago is fresh under a 30-day window", () => {
    const page = makePage({ scraped_at: Date.parse("2026-06-17T00:00:00Z") });
    expect(isStale(page, NOW, 30)).toBe(false);
  });

  it("an entry scraped 40 days ago is stale under a 30-day window", () => {
    const page = makePage({ scraped_at: Date.parse("2026-05-18T00:00:00Z") }); // 40 days
    expect(isStale(page, NOW, 30)).toBe(true);
  });

  it("an entry exactly AT the window (age === freshnessDays) is FRESH (inclusive boundary)", () => {
    const page = makePage({ scraped_at: Date.parse("2026-05-28T00:00:00Z") }); // exactly 30 days
    expect(ageInDays(page.scraped_at, NOW)).toBe(30);
    expect(isStale(page, NOW, 30)).toBe(false);
  });

  it("just past the window (30.5 days) is stale", () => {
    const page = makePage({ scraped_at: Date.parse("2026-05-27T12:00:00Z") }); // 30.5 days
    expect(isStale(page, NOW, 30)).toBe(true);
  });

  it("a future-dated scraped_at is fresh (clamped to age 0), not stale", () => {
    const page = makePage({ scraped_at: Date.parse("2026-07-10T00:00:00Z") });
    expect(isStale(page, NOW, 30)).toBe(false);
  });

  it("fails safe: an invalid scraped_at (NaN) is treated as stale", () => {
    const page = makePage({ scraped_at: NaN });
    expect(isStale(page, NOW, 30)).toBe(true);
  });
});

describe("extractorChanged — version guard", () => {
  it("is true when the page's extractor differs from the expected one", () => {
    const page = makePage({ extractor_version: "content-features@v1" });
    expect(extractorChanged(page, "content-features@v2")).toBe(true);
  });

  it("is false when the page's extractor matches the expected one", () => {
    const page = makePage({ extractor_version: "content-features@v2" });
    expect(extractorChanged(page, "content-features@v2")).toBe(false);
  });
});

describe("isCacheEntryValid — composed predicate", () => {
  it("is valid when fresh AND extractor matches", () => {
    const page = makePage({
      scraped_at: Date.parse("2026-06-17T00:00:00Z"), // 10 days → fresh
      extractor_version: "content-features@v2",
    });
    expect(isCacheEntryValid(page, makeCtx())).toBe(true);
  });

  it("INVALIDATES a fresh entry from an OLD extractor (the gotcha)", () => {
    // Fresh on age alone, but produced by v1 while the caller expects v2 — an
    // old-extractor feature must never be reused as current.
    const page = makePage({
      scraped_at: Date.parse("2026-06-17T00:00:00Z"), // fresh
      extractor_version: "content-features@v1",
    });
    expect(extractorChanged(page, "content-features@v2")).toBe(true);
    expect(isCacheEntryValid(page, makeCtx())).toBe(false);
  });

  it("invalid when stale even though the extractor matches", () => {
    const page = makePage({
      scraped_at: Date.parse("2026-05-18T00:00:00Z"), // 40 days → stale
      extractor_version: "content-features@v2",
    });
    expect(isCacheEntryValid(page, makeCtx())).toBe(false);
  });

  it("invalid when BOTH stale AND extractor changed", () => {
    const page = makePage({
      scraped_at: Date.parse("2026-05-18T00:00:00Z"), // stale
      extractor_version: "content-features@v1", // old extractor
    });
    expect(isCacheEntryValid(page, makeCtx())).toBe(false);
  });

  it("fails safe: an invalid scraped_at (NaN) makes a version-matching entry invalid", () => {
    const page = makePage({
      scraped_at: NaN,
      extractor_version: "content-features@v2",
    });
    expect(isCacheEntryValid(page, makeCtx())).toBe(false);
  });
});
