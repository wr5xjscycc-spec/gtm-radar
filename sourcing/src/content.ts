// Content enrichment (P3 · Phase 2, task #1) — Orange Slice scrape → `page` records.
//
// Orange Slice is reached via MCP and is PAGE/CONTENT ONLY: it never touches
// `company.offpage` (Fiber/SERP/Reddit own that — lane discipline, red-team
// Patch E). Per docs/TESTING.md the network call is NEVER made in tests: this
// module depends on a PORT (`OrangeSliceClient`) so unit tests inject a mock and
// the real MCP-backed client is a thin wrapper supplied at the app edge.
//
// For each scraped page we build a contract-shaped `page` row (types.ts → Page):
// run the DETERMINISTIC parsers (always present), optionally merge the SUBJECTIVE
// gpt-4o-mini vector when a ChatModel is supplied, stamp `extractor_version`, set
// `scraped_at` from the INJECTED `now`, and compute a `cache_key` from the
// normalized domain + a deterministic content hash + the extractor version.

import { normalizeDomain, normalizeUrl } from "./domain";
import { extractDeterministicFeatures, htmlToText } from "./parsers";
import { CONTENT_EXTRACTOR_VERSION, extractSubjectiveFeatures } from "./features";
import type { ChatModel } from "./understanding";
import type { ContentFeatures, Page, PageRole } from "./types";

// Re-export so content.test.ts can import normalizeUrl from this module.
export { normalizeUrl } from "./domain";

/** One scraped page as returned by Orange Slice (the fields we consume). */
export interface OrangeSlicePage {
  /** Page URL — raw is fine; normalized on write. */
  url: string;
  /** Raw page HTML (drives every deterministic parser). */
  html: string;
  /** Pre-extracted visible text; derived from `html` when omitted. */
  text?: string;
  /** Published/modified timestamp Orange Slice surfaced, if any. */
  lastModified?: string;
  /** Optional role hint; defaults to "candidate" when absent. */
  role?: PageRole;
}

/**
 * The Orange Slice port. The real implementation calls the Orange Slice MCP tool
 * to scrape a company's candidate pages; tests pass a mock. Keeping this an
 * interface is what lets CI stay deterministic and free (no live vendor calls).
 */
export interface OrangeSliceClient {
  scrapeCandidatePages(args: { domain: string; limit?: number }): Promise<OrangeSlicePage[]>;
}

export interface EnrichPagesArgs {
  /** Company domain (raw OK — normalized internally; the page FK). */
  companyDomain: string;
  /** Query terms for `query_term_coverage` (optional). */
  queryTerms?: string[];
  /** ISO-8601 timestamp, INJECTED so runs stay reproducible (no Date.now). */
  now: string;
  /** Optional gpt-4o-mini port; when present the subjective vector is merged in. */
  model?: ChatModel;
  /** Soft cap forwarded to Orange Slice. */
  limit?: number;
}

/**
 * Deterministic 32-bit FNV-1a hash of a string → 8-char hex. Tiny, dependency-free,
 * and stable across runs/processes (unlike object identity) so it can key the
 * Phase-5 content cache. Not cryptographic — collision risk is irrelevant here
 * because it's scoped under the company domain + extractor version.
 */
export function contentHash(input: string): string {
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts (keeps it in 32-bit range).
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Which subjective-extraction state a page landed in. Stamped into the effective
 * `extractor_version` so the three states are DISTINGUISHABLE downstream and in
 * the cache — "absent by design" (no model) must not look identical to "attempted
 * and failed" (coverage honesty; otherwise a flaky LLM masquerades as a deliberate
 * deterministic-only pass).
 */
type SubjectiveState = "none" | "ok" | "failed";

/** Marker appended to the base extractor version per subjective state. */
function subjectiveMarker(state: SubjectiveState): string {
  return state === "ok" ? "+subj" : state === "failed" ? "+subj-err" : "";
}

/**
 * Build the deterministic vector for a page, then (when a model is supplied)
 * merge the subjective vector. Deterministic ALWAYS wins presence: if the LLM
 * pass fails, the subjective fields are simply omitted — the page still carries a
 * full deterministic `content_features`. Returns the state so the caller can stamp
 * an honest, cache-safe `extractor_version`.
 */
async function buildContentFeatures(
  page: OrangeSlicePage,
  text: string,
  args: EnrichPagesArgs,
  normalizedUrl: string,
): Promise<{ features: ContentFeatures; state: SubjectiveState }> {
  const deterministic = extractDeterministicFeatures(
    { html: page.html, text, lastModified: page.lastModified, queryTerms: args.queryTerms },
    args.now,
  );
  if (!args.model) return { features: deterministic, state: "none" };
  try {
    const subjective = await extractSubjectiveFeatures(args.model, { url: normalizedUrl, text });
    return { features: { ...deterministic, ...subjective }, state: "ok" };
  } catch {
    // Prefer deterministic parses: a flaky/invalid LLM reply must not drop the
    // page or its objective vector — we omit the subjective fields and move on,
    // but record the FAILED state so it's not confused with a no-model pass.
    return { features: deterministic, state: "failed" };
  }
}

/**
 * Hash the query-term set that fed `query_term_coverage`. Folding this into the
 * cache key is what keeps the Phase-5 category cache correct: identical HTML
 * scored against DIFFERENT query packs yields different coverage, so it must not
 * collide on one cache entry. Order-independent (terms sorted) and case-folded.
 */
export function queryTermsHash(terms: string[] | undefined): string {
  const norm = (terms ?? [])
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0)
    .sort();
  return norm.length === 0 ? "noqt" : contentHash(norm.join("\n"));
}

/**
 * Enrich a company's scraped candidate pages into contract-shaped `page` records.
 *
 *  - normalizes company_domain (FK) + url (key),
 *  - runs the deterministic parsers (always), merges subjective when `model` set,
 *  - stamps an effective `extractor_version` that encodes the subjective state
 *    (none / +subj / +subj-err) and the INJECTED `scraped_at` (= args.now),
 *  - computes `cache_key` = normalizedDomain | contentHash(html) | queryTermsHash |
 *    effective extractor_version — so query-pack- and subjective-state-dependent
 *    feature vectors never collide in the Phase-5 cache,
 *  - defaults role to "candidate" unless the scraped page specifies one,
 *  - dedupes by normalized url (first-seen wins).
 */
export async function enrichPages(orange: OrangeSliceClient, args: EnrichPagesArgs): Promise<Page[]> {
  const companyDomain = normalizeDomain(args.companyDomain);
  const scraped = await orange.scrapeCandidatePages({ domain: companyDomain, limit: args.limit });
  const qtHash = queryTermsHash(args.queryTerms);

  const byUrl = new Map<string, Page>();
  for (const page of scraped ?? []) {
    if (!page?.url || !page.html) continue; // skip malformed entries
    let url: string;
    try {
      url = normalizeUrl(page.url);
    } catch {
      continue; // unparseable url → skip (don't poison the join surface)
    }
    if (byUrl.has(url)) continue; // dedupe by normalized url (first-seen wins)

    const text = page.text ?? htmlToText(page.html);
    const { features, state } = await buildContentFeatures(page, text, args, url);
    const extractorVersion = `${CONTENT_EXTRACTOR_VERSION}${subjectiveMarker(state)}`;

    byUrl.set(url, {
      company_domain: companyDomain,
      url,
      role: page.role ?? "candidate",
      content_features: features,
      extractor_version: extractorVersion,
      scraped_at: Date.parse(args.now),
      cache_key: `${companyDomain}|${contentHash(page.html)}|${qtHash}|${extractorVersion}`,
    });
  }

  return [...byUrl.values()];
}
