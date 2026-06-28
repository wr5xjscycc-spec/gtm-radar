// P3 · Phase 5, task #2 — the pure cache-invalidation POLICY.
//
// A cached `page` (record #3) may be reused as a feature source ONLY when it is
// still VALID, which here means BOTH:
//   (a) within the freshness window  — it was scraped recently enough, AND
//   (b) from the expected extractor   — content_features came from the current
//       extractor_version, not an older one.
//
// WHY both guards (the red-team gotcha): stale features and old-extractor
// features both POISON a fit — a feature measured weeks ago, or by a previous
// extractor with different heuristics, must NEVER silently mix with fresh,
// current-extractor features. The extractor_version is already baked into the
// `cache_key` (so a version bump produces a different key), but we ALSO guard it
// explicitly here so the policy is self-contained and auditable. This is a
// DESCRIPTIVE cache-hygiene rule, not a causal claim about fits.
//
// FAIL-SAFE bias: when validity is in doubt — e.g. an unparseable/empty
// `scraped_at`, so the age is unknown — we INVALIDATE rather than serve an entry
// of unknown age. Serving a possibly-stale entry is the costly error; re-scraping
// a maybe-still-fresh one is merely a cache miss.
//
// PURITY: every function here is pure (Page + injected times in → boolean/number
// out). No Date.now, no network — `now` always arrives via arguments so cache
// decisions stay reproducible (mirrors the injected-`now` style in parsers.ts).

import type { Page, CacheValidityContext, CacheValidator } from "./types";

/**
 * Default freshness window in days. 30 days is a sensible re-measurement cadence
 * for battlefield/competitor pages: long enough to amortize the scrape+extract
 * cost across many customers in a vertical (the whole point of the cache), short
 * enough that we re-measure roughly monthly so genuinely changed pages don't sit
 * stale for a quarter. The cache store may override this via the context.
 */
export const DEFAULT_FRESHNESS_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Parse a timestamp to a Date, or null when missing/unparseable (number = epoch ms). */
function toDate(value: number | string | null | undefined): Date | null {
  if (value == null) return null;
  const d = typeof value === "number" && Number.isFinite(value)
    ? new Date(value)
    : new Date(String(value).trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Age of a cached entry in days, between `scrapedAt` (epoch ms) and `now` (ISO-8601).
 * Fractional — we do NOT floor, so a boundary comparison against the window is
 * exact (a 30.5-day-old entry against a 30-day window is correctly stale).
 *
 * Returns `null` when EITHER timestamp is missing/unparseable: an unknown age is
 * a reason to INVALIDATE, never to silently keep (callers treat null as stale).
 *
 * A negative raw age — `scrapedAt` in the future relative to `now` (clock skew /
 * a future-dated entry) — is CLAMPED to 0: a future-dated entry is treated as
 * "fresh" (age 0), not stale, mirroring freshnessDays() in parsers.ts.
 */
export function ageInDays(scrapedAt: number, now: string): number | null {
  const scraped = toDate(scrapedAt);
  const ref = toDate(now);
  if (scraped === null || ref === null) return null;
  const days = (ref.getTime() - scraped.getTime()) / MS_PER_DAY;
  return days < 0 ? 0 : days;
}

/**
 * Is the cached `page` STALE (outside the freshness window)?
 *
 * Boundary convention: the window is INCLUSIVE — an entry whose age is exactly
 * `freshnessDays` is still FRESH. Stale means strictly `age > freshnessDays`.
 *
 * Fail-safe: when the age can't be determined (unparseable/empty `scraped_at`,
 * so `ageInDays` returns null) we report STALE — we will not serve an entry of
 * unknown age.
 */
export function isStale(page: Page, now: string, freshnessDays: number): boolean {
  const age = ageInDays(page.scraped_at, now);
  if (age === null) return true; // unknown age → fail safe → stale
  return age > freshnessDays; // inclusive window: age === freshnessDays is fresh
}

/**
 * Has the extractor changed out from under this cached entry? True when the
 * page's `extractor_version` differs from the one the caller now expects. The
 * gotcha guard: a feature produced by an old extractor must never be reused as
 * if it were current.
 */
export function extractorChanged(page: Page, expectedExtractorVersion: string): boolean {
  return page.extractor_version !== expectedExtractorVersion;
}

/**
 * The composed default validator the cache store injects: a cached `page` is
 * valid ONLY when it is fresh AND from the expected extractor. Any doubt
 * (unknown age, version mismatch) makes it invalid — fail safe.
 */
export const isCacheEntryValid: CacheValidator = (page: Page, ctx: CacheValidityContext): boolean =>
  !isStale(page, ctx.now, ctx.freshnessDays) &&
  !extractorChanged(page, ctx.expectedExtractorVersion);
