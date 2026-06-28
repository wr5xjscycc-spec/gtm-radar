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
