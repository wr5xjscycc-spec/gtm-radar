/**
 * Enrichment & query-review helpers (owner: P1, Phase 2).
 *
 * P3 produces a lot (content features, off-page signals, a query set). P1's job
 * is to make it AUDITABLE so the team catches garbage before expensive
 * measurement — specifically the two red-team holes:
 *   - low off-page coverage hidden instead of surfaced
 *   - an LLM-invented query set masquerading as grounded
 * So these helpers SURFACE coverage gaps and the llm_expand ratio — never hide them.
 *
 * Pure + unit-tested; the React panels render over these.
 */

export type SeedSource = "paa" | "keyword" | "reddit" | "analytics" | "llm_expand";

/** Grounded = seeded from a real source (anything but pure LLM expansion). */
export function llmExpandRatio(
  queries: { seed_source: SeedSource }[],
): { total: number; llm_expand: number; ratio: number; tooHigh: boolean } {
  const total = queries.length;
  const llm = queries.filter((q) => q.seed_source === "llm_expand").length;
  const ratio = total === 0 ? 0 : llm / total;
  // Red-team threshold: if most queries are pure LLM expansion, the set isn't grounded.
  return { total, llm_expand: llm, ratio, tooHigh: total > 0 && ratio > 0.5 };
}

/** Breakdown of queries by seed_source (for the review view). */
export function seedSourceBreakdown(
  queries: { seed_source: SeedSource }[],
): Record<SeedSource, number> {
  const out: Record<SeedSource, number> = {
    paa: 0, keyword: 0, reddit: 0, analytics: 0, llm_expand: 0,
  };
  for (const q of queries) out[q.seed_source] = (out[q.seed_source] ?? 0) + 1;
  return out;
}

const OFFPAGE_FIELDS = [
  "thirdparty_mentions", "reddit_presence", "g2_presence", "wikipedia_presence",
  "review_site_presence", "brand_search_volume", "backlink_density",
  "entity_cooccurrence",
] as const;

/**
 * Off-page coverage for a company: which signals landed vs are missing. Missing
 * signals are surfaced (not hidden) so the team sees thin coverage before
 * trusting the model. coverage_flags from P3 are passed through.
 */
export function coverageSummary(company: {
  offpage?: Record<string, number | undefined> | null;
  coverage_flags?: string[] | null;
}): { present: string[]; missing: string[]; coverage: number; flags: string[] } {
  const off = company.offpage ?? {};
  const present = OFFPAGE_FIELDS.filter((f) => typeof off[f] === "number");
  const missing = OFFPAGE_FIELDS.filter((f) => typeof off[f] !== "number");
  return {
    present: [...present],
    missing: [...missing],
    coverage: present.length / OFFPAGE_FIELDS.length,
    flags: company.coverage_flags ?? [],
  };
}

/** Feature-vector inspector view for one page: every field + whether it landed. */
export function featureVectorView(page: {
  content_features?: Record<string, unknown> | null;
  extractor_version?: string;
}): { extractor_version: string; fields: { key: string; value: unknown; present: boolean }[] } {
  const cf = page.content_features ?? {};
  const fields = Object.entries(cf).map(([key, value]) => ({
    key,
    value,
    present: value !== undefined && value !== null,
  }));
  return { extractor_version: page.extractor_version ?? "(unstamped)", fields };
}
