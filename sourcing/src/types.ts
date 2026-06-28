// P3 record shapes — the TypeScript form of the `company` record in
// docs/CONTRACT.md (record #2). P3 owns this record; P2/P4 read it.
// Keep field names byte-identical to the contract — these are the join surface.
//
// Phase 0 only populates the identity fields (domain, name, role) + source
// versions. The enrichment families (firmographics / offpage / understanding)
// are filled in Phase 1–2, so they are OPTIONAL here and their absence is made
// visible through `coverage_flags` rather than silently dropped.

export type CompanyRole = "customer" | "competitor" | "battlefield";

/** Context features — company-level, kept deliberately small (effective N = #companies). */
export interface Firmographics {
  size?: string;
  funding_stage?: string;
  headcount_growth?: string;
  hiring_velocity?: string;
  tech_stack?: string[];
}

/** Off-page / earned-media / entity signals — the DOMINANT citation drivers (red-team Patch E). */
export interface OffPage {
  thirdparty_mentions?: number;
  reddit_presence?: number;
  g2_presence?: number;
  wikipedia_presence?: number;
  review_site_presence?: number;
  brand_search_volume?: number;
  backlink_density?: number;
  entity_cooccurrence?: number;
}

/** Cheap "what you are" understanding (gpt-4o-mini in Phase 1). */
export interface Understanding {
  category?: string;
  icp?: string;
  positioning?: string;
}

/**
 * coverage_flags — honest record of which feature families are NOT yet populated.
 * Red-team transparency requirement: never drop low-coverage rows silently; flag them.
 * Each present key names a family that still needs enrichment.
 */
export interface CoverageFlags {
  firmographics_missing?: boolean;
  offpage_missing?: boolean;
  understanding_missing?: boolean;
}

/** Provenance/versioning so a mid-run source change is detectable (contract Global rule). */
export interface SourceVersions {
  /** e.g. "fiber/find-similar-companies@v1" */
  battlefield?: string;
  firmographics?: string;
  offpage?: string;
  understanding?: string;
}

/** Record #2 — `company`. PK = normalized domain. */
export interface Company {
  /** PK — MUST be a normalized domain (see src/domain.ts / P1 helper). */
  domain: string;
  name: string;
  role: CompanyRole;
  firmographics?: Firmographics;
  offpage?: OffPage;
  understanding?: Understanding;
  coverage_flags: CoverageFlags;
  source_versions: SourceVersions;
}

// ─────────────────────────────────────────────────────────────────────────────
// Record #3 — `page`  (owner: P3; key = company_domain + normalized url)
//
// content_features splits into two families that must NOT be blurred:
//  - DETERMINISTIC: parsed from HTML/text, low measurement error (preferred lever).
//  - SUBJECTIVE: gpt-4o-mini-extracted, measurement-error-laden (validated in P3·3).
// The GEO-paper tactics (stats/citations/quotes/direct-answer) live in the
// subjective family. Keeping them separate is a red-team requirement.
// ─────────────────────────────────────────────────────────────────────────────

export type PageRole = "candidate" | "customer" | "competitor";

/** Counts of heading levels — a deterministic proxy for document structure. */
export interface HeadingStructure {
  h1: number;
  h2: number;
  h3: number;
}

/** Objective content features — deterministic parses (prefer these; low noise). */
export interface DeterministicContentFeatures {
  /** JSON-LD / schema.org markup present. */
  schema_markup: boolean;
  /** A comparison/feature table present. */
  comparison_table: boolean;
  word_count: number;
  heading_structure: HeadingStructure;
  /** Days since last update; null when undeterminable. */
  freshness_days: number | null;
  /** Fraction (0..1) of query terms that appear on the page. */
  query_term_coverage: number;
}

export type ListicleVsProse = "listicle" | "prose" | "mixed";

/** Subjective content features — gpt-4o-mini-extracted, measurement-error-laden. */
export interface SubjectiveContentFeatures {
  direct_answer_first: boolean;
  /** Density (per 1k words) of statistics/numbers. */
  stats_density: number;
  /** Density (per 1k words) of outbound citations. */
  citation_density: number;
  /** Density (per 1k words) of quotations. */
  quote_density: number;
  listicle_vs_prose: ListicleVsProse;
}

/**
 * Full `content_features` vector: deterministic fields are always present;
 * subjective fields are optional (the LLM pass may be absent or may fail, in
 * which case the deterministic vector still stands).
 */
export type ContentFeatures = DeterministicContentFeatures & Partial<SubjectiveContentFeatures>;

/** Record #3 — `page`. Key = company_domain (FK) + normalized url. */
export interface Page {
  /** FK to company — a NORMALIZED domain. */
  company_domain: string;
  /** Normalized page URL. */
  url: string;
  role: PageRole;
  content_features: ContentFeatures;
  /** Stamps which extractor produced content_features (versioned — contract rule). */
  extractor_version: string;
  /** ISO-8601 timestamp; injected by the caller so runs stay reproducible. */
  scraped_at: string;
  /** normalized domain + content hash + extractor_version (Phase 5 cache key). */
  cache_key: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Record #4 — `query`  (owner: P3)
// Don't invent queries: seed from real data, then LLM-EXPAND. Tag every query's
// seed_source so P1 can surface the real-vs-llm_expand ratio (red-team Theme E).
// ─────────────────────────────────────────────────────────────────────────────

export type SeedSource = "paa" | "keyword" | "reddit" | "analytics" | "llm_expand";
export type Engine = "openai" | "perplexity" | "gemini";

/** Record #4 — `query`. */
export interface Query {
  id: string;
  customer_id: string;
  vertical: string;
  text: string;
  seed_source: SeedSource;
  target_engines: Engine[];
}
