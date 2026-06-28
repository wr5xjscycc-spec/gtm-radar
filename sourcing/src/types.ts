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
  headcount_growth?: number | null;
  hiring_velocity?: number | null;
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
 * Each present string names a family that still needs enrichment.
 * e.g. ["firmographics_missing","offpage_missing"]
 */

/** Internal type: heading counts used by parsers.ts headingStructure extractor. */
export interface HeadingStructure {
  h1: number;
  h2: number;
  h3: number;
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
  coverage_flags: string[];
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

/** Objective content features — deterministic parses (prefer these; low noise). */
export interface DeterministicContentFeatures {
  /** JSON-LD / schema.org markup present. */
  schema_markup: boolean;
  /** A comparison/feature table present. */
  comparison_table: boolean;
  word_count: number;
  /** Total heading count (h1+h2+h3) — scalar for schema conformance. */
  heading_structure: number;
  /** Days since last update; 0 when undeterminable. */
  freshness_days: number;
  /** Fraction (0..1) of query terms that appear on the page. */
  query_term_coverage: number;
}

/** Subjective content features — gpt-4o-mini-extracted, measurement-error-laden. */
export interface SubjectiveContentFeatures {
  direct_answer_first: boolean;
  /** Density (per 1k words) of statistics/numbers. */
  stats_density: number;
  /** Density (per 1k words) of outbound citations. */
  citation_density: number;
  /** Density (per 1k words) of quotations. */
  quote_density: number;
  /** 0=prose, 0.5=mixed, 1=listicle */
  listicle_vs_prose: number;
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
  /** Epoch milliseconds; injected by the caller so runs stay reproducible. */
  scraped_at: number;
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

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 — P3-produced artifacts BEYOND the 9-record contract.
//
// CONTRACT.md does not (yet) specify these, but the P3 phase card sanctions them:
//  - the CANDIDATE POOL P2 labels against (case-control losers), and
//  - the subjective-feature AGREEMENT metrics that back the honesty story.
// They are cross-lane interfaces (P2 reads the pool; P4/P1 surface agreement), so
// treat these shapes as a contract-extension PROPOSAL — freeze with P2/P4 sign-off
// (ORCHESTRATION §4) before those lanes build against them.
// ─────────────────────────────────────────────────────────────────────────────

/** Provenance of a candidate page (classic-search source). Extensible. */
export type CandidateSource = "serp_organic";

/**
 * One row of the candidate-pool table: a page that ranks in CLASSIC search for a
 * query = the "could-have-been-cited" set. P2 labels these — cited → winner,
 * in-pool-but-not-cited → loser. This case-control pool is what keeps the "loser"
 * label from being an arbitrary uncited page (red-team / ORCHESTRATION §6).
 */
export interface CandidatePoolEntry {
  /** FK to `query`. */
  query_id: string;
  /** Normalized page URL (join key to `page`). */
  page_url: string;
  /** 1-based classic-search rank. */
  rank: number;
  source: CandidateSource;
}

/** How agreement was measured for a given subjective feature. */
export type AgreementMethod = "exact" | "cohens_kappa" | "within_tolerance";

/** Measured agreement for ONE subjective feature (honest measurement-error disclosure). */
export interface FeatureAgreement {
  feature: keyof SubjectiveContentFeatures;
  method: AgreementMethod;
  /**
   * Agreement score, RANGE DEPENDS ON `method`:
   *  - "cohens_kappa"     → κ ∈ [-1, 1]  (negative = below-chance; reported as-is,
   *                         NEVER floored — clamping a mediocre/negative κ would
   *                         violate the "disclose the number" honesty rule).
   *  - "within_tolerance" → rate ∈ [0, 1].
   *  - "exact"            → raw agreement rate ∈ [0, 1] (κ fallback when one rater
   *                         is constant, i.e. pe == 1).
   * Consumers (P2/P4) MUST NOT validate this to [0,1] — see the κ branch.
   */
  agreement: number;
  /** Number of items compared for this feature. */
  n: number;
}

/**
 * Extractor-hardening report: per-feature agreement + the versioned extractor that
 * produced the predictions. Reported even when agreement is mediocre (the card is
 * explicit: disclose the number, don't hide it).
 */
export interface AgreementReport {
  extractor_version: string;
  features: FeatureAgreement[];
  /** Size of the labeled subset actually compared (successful extractions only). */
  n: number;
  /** Items fed to the extractor (present for the run-the-extractor path). */
  attempted?: number;
  /** Items excluded because extraction failed loud (attrition visibility, not inferred from a low `n`). */
  skipped?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4 — Join integrity & coverage (P3-produced, P4-facing).
//
// The model (P4) fits on PAGE rows that must each inherit their COMPANY's
// company-level context (offpage/firmographics/understanding) — joined on the
// normalized domain. A single www/subdomain mismatch silently strips the dominant
// off-page signals from all of a company's pages, so the join is AUDITED and
// every miss is SURFACED (never a silent drop). Coverage is made visible, not
// hidden (red-team transparency). These shapes are a contract-extension proposal.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A `page` joined with its company's INHERITED company-level context — the clean
 * row P4 fits on. When the page's company can't be found (orphan), `company_found`
 * is false and the context fields are absent: the row is still EMITTED (coverage
 * honesty), never dropped.
 */
export interface JoinedPage {
  page: Page;
  /** Normalized domain — the join key (page.company_domain ↔ company.domain). */
  company_domain: string;
  company_found: boolean;
  /**
   * Inherited company-level context (absent when company_found is false).
   * READ-ONLY: these are per-row copies of the company's families — consumers
   * (P4) must treat them as immutable; the join does not deep-copy nested arrays.
   */
  firmographics?: Firmographics;
  offpage?: OffPage;
  understanding?: Understanding;
  /** The company's coverage flags, inherited so the row carries honest coverage. */
  company_coverage_flags?: string[];
}

/** Join-integrity findings — surfaced for P1, never silently dropped. */
export interface JoinReport {
  /** Pages successfully joined to a company. */
  joined: number;
  /** Pages whose company_domain matched NO company (the dangerous www/subdomain miss). Raw declared value. */
  orphan_pages: Array<{ url: string; company_domain: string }>;
  /** Companies with no pages (nothing inherits their context yet). */
  childless_companies: string[];
  /**
   * Two companies whose domains collided on the same normalized key — the loser is
   * surfaced here (first-wins) instead of silently overwriting the index, which
   * would mis-attribute the dominant off-page signal to the wrong company's pages.
   */
  duplicate_domains: string[];
  /** Companies whose domain couldn't be normalized at all (most coverage-broken — surfaced, not dropped). */
  unjoinable_companies: string[];
}

/** Per-entity coverage assessment — low coverage is FLAGGED, not dropped. */
export interface CoverageAssessment {
  kind: "company" | "page";
  /** Domain (company) or normalized url (page). */
  key: string;
  /** Which expected feature families are missing. */
  missing: string[];
  /** Fraction (0..1) of expected families present. */
  coverage_score: number;
  /** Below the threshold → surfaced to P1 for transparency, NOT excluded from fits. */
  low_coverage: boolean;
}

/** Coverage roll-up across companies + pages. */
export interface CoverageReport {
  companies: CoverageAssessment[];
  pages: CoverageAssessment[];
  /** Threshold used to mark `low_coverage` (so the number is reproducible). */
  threshold: number;
  /** Count of low-coverage entities (surfaced, never dropped). */
  low_coverage_count: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5 — category-level caching (P3-INTERNAL cost lever, NOT a contract record).
//
// Battlefield competitors overlap heavily across customers in the same vertical,
// so caching their scraped+extracted `page` features is the #1 unit-economics
// lever. Entries are keyed on `cache_key` (normalized domain + content hash +
// extractor_version — see content.ts). A cached entry is reused ONLY when it is
// still VALID: within the freshness window AND from the current extractor
// (a feature from an old extractor must never silently mix with new ones — the
// extractor_version is already baked into cache_key, so a version change yields a
// different key, but we also guard explicitly). The validity contract below is
// the shared seam between the cache store and the invalidation policy.
// ─────────────────────────────────────────────────────────────────────────────

/** Inputs that decide whether a cached `page` entry may still be reused. */
export interface CacheValidityContext {
  /** Current time as ISO-8601 (INJECTED — keeps decisions reproducible, no Date.now). */
  now: string;
  /** Max age in days before a cached entry is considered stale. */
  freshnessDays: number;
  /** The extractor version the caller expects; a mismatch invalidates the entry. */
  expectedExtractorVersion: string;
  /**
   * Hash of the caller's query-term set (same hash baked into `cache_key`).
   * `query_term_coverage` is CUSTOMER/query-pack-specific, so url-based reuse MUST
   * be scoped by this — otherwise customer B would inherit customer A's coverage
   * number for the same competitor page. See cache.ts `reuseKey`.
   */
  expectedQueryTermsHash: string;
}

/** Predicate deciding if a cached `page` is still valid (fresh + current extractor). */
export type CacheValidator = (page: Page, ctx: CacheValidityContext) => boolean;

// ─────────────────────────────────────────────────────────────────────────────
// Phase 6 — launch vertical pack & coverage QA (P3-produced; P4/P1-facing).
//
// The wedge is VERTICAL-FIRST: one curated, validated query pack + the CMS targets
// for that single vertical beat shallow coverage everywhere (red-team positioning
// trap — resist going horizontal). And coverage must be honest: the QA sweep
// SURFACES low-coverage for P1's UI, it never drops rows to look complete.
// ─────────────────────────────────────────────────────────────────────────────

export type CmsKind = "webflow" | "wordpress" | "contentful" | "sanity" | "hubspot" | "other";

/** A CMS publish target for the launch vertical, handed to P4 for one-click publish. */
export interface CmsTarget {
  vertical: string;
  cms: CmsKind;
  /** The collection / path / template the vertical's content publishes into. */
  destination: string;
  notes?: string;
}

/** Real-vs-llm_expand breakdown of a query set (grounding transparency). */
export interface SeedSourceRatio {
  total: number;
  /** Non-llm_expand (paa/keyword/reddit/analytics) — the grounded queries. */
  real: number;
  llm_expand: number;
  /** real / total. */
  realRatio: number;
}

/**
 * The finalized, validated launch vertical pack — the production wedge. Built by
 * curating the grounded query set down to ONE vertical and attaching that
 * vertical's CMS targets. `validated` + `issues` make the gates transparent.
 */
export interface VerticalPack {
  vertical: string;
  version: string;
  queries: Query[];
  cms_targets: CmsTarget[];
  seed_source_ratio: SeedSourceRatio;
  /** Passed every gate: single-vertical, deduped, healthy real-seed ratio, min size. */
  validated: boolean;
  /** Validation issues (empty when validated) — surfaced, never silently swallowed. */
  issues: string[];
}

/**
 * Coverage-QA result for the launch vertical. Wraps the Phase-4 CoverageReport and
 * the reconciled company flags; low-coverage entities are SURFACED for P1, never
 * dropped. `passed` means the sweep ran and every entity is accounted for (a
 * transparency assertion, NOT a gate that excludes low-coverage rows).
 */
export interface VerticalCoverageQA {
  vertical: string;
  report: CoverageReport;
  /** Low-coverage entities surfaced for P1's coverage UI (companies + pages). */
  surfaced_low_coverage: CoverageAssessment[];
  /** Reconciled company coverage flags (corrected toward actual data). */
  reconciled_flags: Array<{ domain: string; coverage_flags: string[] }>;
  passed: boolean;
}
