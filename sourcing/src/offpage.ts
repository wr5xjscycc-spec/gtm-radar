// Off-page / entity enrichment (P3 · Phase 2 · task #2).
//
// Fills `company.offpage` (contract record #2) — the eight earned-media / entity
// signals that, per the SHARED-CONTEXT non-negotiable supply fact #1, DOMINATE AI
// citation. This is the strategic patch of the whole sourcing lane, so the three
// citation drivers are treated as first-class: each comes from the vendor best
// positioned to measure it.
//
// THREE vendor sources, mirroring the FiberClient PORT pattern (src/fiber.ts):
// the real implementations call MCP/HTTP APIs at the app edge; unit tests inject
// mocks. No network, no real SDK in this module.
//
// SOURCE-OF-TRUTH SPLIT (red-team gotcha "Don't double-source a field from both
// Fiber and Orange Slice"): every one of the eight contract fields is owned by
// EXACTLY ONE vendor. mergeOffpage reads each field only from its owning vendor's
// response and ignores the same key if it leaks in from another vendor.
//
//   OffpageFiberClient   (entity / backlink graph) ── source of truth for:
//       thirdparty_mentions, backlink_density, entity_cooccurrence, wikipedia_presence
//   OffpageSerpClient    (SERP / DataForSEO)       ── source of truth for:
//       brand_search_volume, g2_presence, review_site_presence
//   OffpageRedditClient  (community)               ── source of truth for:
//       reddit_presence
//
// All eight fields are numeric. A MISSING signal must stay `undefined` (distinct
// from a real measured 0): we never pollute with zeros/empties, because 0 mentions
// is a true datum while "we didn't get a reading" is not.

import type { Company, OffPage } from "./types";
import { toggleFlag } from "./battlefield";

// ─────────────────────────────────────────────────────────────────────────────
// Vendor PORTS — one per source. Real impls call MCP/APIs; tests pass mocks.
// Each response is modeled loosely (extra raw fields tolerated, then dropped) so
// a recorded fixture can be replayed.
// ─────────────────────────────────────────────────────────────────────────────

/** Entity/backlink signals from the Fiber-side entity graph. */
export interface OffpageFiberEntityResponse {
  thirdparty_mentions?: number;
  backlink_density?: number;
  entity_cooccurrence?: number;
  wikipedia_presence?: number;
  /** Extra raw fields are tolerated on the wire but DROPPED by mergeOffpage. */
  [extra: string]: unknown;
}

/** SERP / brand signals from DataForSEO-style search data. */
export interface OffpageSerpBrandResponse {
  brand_search_volume?: number;
  g2_presence?: number;
  review_site_presence?: number;
  /** Extra raw fields are tolerated on the wire but DROPPED by mergeOffpage. */
  [extra: string]: unknown;
}

/** Community signal from Reddit. */
export interface OffpageRedditResponse {
  reddit_presence?: number;
  /** Extra raw fields are tolerated on the wire but DROPPED by mergeOffpage. */
  [extra: string]: unknown;
}

/**
 * Fiber/entity PORT — third-party mentions, backlink density, entity
 * co-occurrence and Wikipedia presence (the entity-graph side of off-page).
 */
export interface OffpageFiberClient {
  getEntitySignals(args: { domain: string }): Promise<OffpageFiberEntityResponse>;
}

/**
 * SERP PORT — brand search volume plus G2 / review-site presence (the
 * search-results side of off-page).
 */
export interface OffpageSerpClient {
  getBrandSignals(args: { domain: string; brand?: string }): Promise<OffpageSerpBrandResponse>;
}

/** Reddit PORT — community presence (the dominant community citation driver). */
export interface OffpageRedditClient {
  getRedditPresence(args: { domain: string; brand?: string }): Promise<OffpageRedditResponse>;
}

/** Stable version tag stamped into `company.source_versions.offpage`. */
export const OFFPAGE_VERSION = "offpage/fiber+serp+reddit@v1";

/**
 * Accept a real, finite number (INCLUDING 0) and reject everything else.
 * `undefined`/`null`/`NaN`/non-numbers all collapse to `undefined`, so a missing
 * signal stays missing — but a genuine measured 0 is preserved as 0.
 */
function cleanNumber(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

/** The three vendor responses, each optional (a vendor may have failed). */
export interface OffpageParts {
  fiber?: OffpageFiberEntityResponse | null;
  serp?: OffpageSerpBrandResponse | null;
  reddit?: OffpageRedditResponse | null;
}

/**
 * Merge the three vendor responses into ONE contract `OffPage` object.
 *
 * Maps ONLY the eight contract fields, each pulled from its single owning vendor
 * (see SOURCE-OF-TRUTH SPLIT above) — a key that appears on the "wrong" vendor is
 * ignored, so no field is ever double-sourced. Every other field is dropped.
 * Missing/blank readings are left `undefined` (no zero/empty pollution); a real 0
 * survives as 0. The returned object only carries keys that have a value.
 */
export function mergeOffpage(parts: OffpageParts): OffPage {
  const fiber = parts.fiber ?? {};
  const serp = parts.serp ?? {};
  const reddit = parts.reddit ?? {};

  const out: OffPage = {};

  // ── Fiber / entity graph ──
  const thirdparty_mentions = cleanNumber(fiber.thirdparty_mentions);
  if (thirdparty_mentions !== undefined) out.thirdparty_mentions = thirdparty_mentions;

  const backlink_density = cleanNumber(fiber.backlink_density);
  if (backlink_density !== undefined) out.backlink_density = backlink_density;

  const entity_cooccurrence = cleanNumber(fiber.entity_cooccurrence);
  if (entity_cooccurrence !== undefined) out.entity_cooccurrence = entity_cooccurrence;

  const wikipedia_presence = cleanNumber(fiber.wikipedia_presence);
  if (wikipedia_presence !== undefined) out.wikipedia_presence = wikipedia_presence;

  // ── SERP / DataForSEO ──
  const brand_search_volume = cleanNumber(serp.brand_search_volume);
  if (brand_search_volume !== undefined) out.brand_search_volume = brand_search_volume;

  const g2_presence = cleanNumber(serp.g2_presence);
  if (g2_presence !== undefined) out.g2_presence = g2_presence;

  const review_site_presence = cleanNumber(serp.review_site_presence);
  if (review_site_presence !== undefined) out.review_site_presence = review_site_presence;

  // ── Reddit / community ──
  const reddit_presence = cleanNumber(reddit.reddit_presence);
  if (reddit_presence !== undefined) out.reddit_presence = reddit_presence;

  return out;
}

/**
 * Settle a vendor promise WITHOUT letting one vendor sink the whole enrichment.
 * Off-page is multi-source by design; a single transport/API failure should
 * degrade us to the signals we DID get, not abort. A rejected vendor yields
 * `undefined`, which mergeOffpage treats as "no reading from this source".
 */
async function tolerate<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch {
    return undefined;
  }
}

/**
 * Enrich one `company` with off-page signals from all three vendors.
 *
 * Calls Fiber, SERP and Reddit with the company's ALREADY-NORMALIZED domain (the
 * join key — never re-normalized or altered here), CONCURRENTLY, then merges. One
 * vendor failing does not throw: we degrade to the surviving signals.
 *
 * COVERAGE HONESTY (mirrors enrichFirmographics exactly): `offpage_missing` is
 * flipped to `false` and the source version stamped ONLY when at least one of the
 * eight fields was actually populated. If nothing usable came back from any vendor
 * the row stays flagged missing and unstamped — we never claim coverage we don't
 * have. The input company is never mutated; all other fields/flags are preserved.
 */
export async function enrichOffpage(
  clients: {
    fiber: OffpageFiberClient;
    serp: OffpageSerpClient;
    reddit: OffpageRedditClient;
  },
  company: Company,
): Promise<Company> {
  const domain = company.domain; // already-normalized join key — used as-is

  const [fiber, serp, reddit] = await Promise.all([
    tolerate(clients.fiber.getEntitySignals({ domain })),
    tolerate(clients.serp.getBrandSignals({ domain })),
    tolerate(clients.reddit.getRedditPresence({ domain })),
  ]);

  const offpage = mergeOffpage({ fiber, serp, reddit });
  const populated = Object.keys(offpage).length > 0;

  return {
    ...company,
    offpage,
    coverage_flags: toggleFlag(company.coverage_flags, "offpage_missing", !populated),
    source_versions: {
      ...company.source_versions,
      // Only assert off-page provenance when we actually have data.
      ...(populated ? { offpage: OFFPAGE_VERSION } : {}),
    },
  };
}
