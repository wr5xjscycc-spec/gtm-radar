// P2 (Measurement) — shared types. The FROZEN interface every measurement module
// builds against. Mirrors the `measurement` record in docs/CONTRACT.md §5 and the
// common engine shape in docs/ARCHITECTURE.md §8.
//
// Per-engine throughout (cross-engine citation overlap is ~11%) — never merge engines.

export type Engine = "openai" | "perplexity" | "gemini";

export type WindowTag = "baseline" | "post" | "adhoc";

/** A single source the engine cited, parsed from a grounded response. */
export interface Citation {
  /** Raw source URL exactly as the engine returned it. */
  url: string;
  /** Normalized domain (via normalize helper) — the P1 join key. */
  domain: string;
  /** Citation title, if the engine provided one. */
  title?: string;
  /** 1-based order of first appearance in the answer (#1 ≫ #3 — clicks concentrate on the first). */
  rank: number;
}

/**
 * What an engine adapter returns from ONE grounded query call, after parsing into the
 * engine-agnostic shape. `model_version` is the version stamp (drift detection, reproducibility).
 */
export interface EngineQueryResult {
  engine: Engine;
  model_version: string;
  /** The engine's answer text — used for `appeared` detection. */
  answer_text: string;
  /** Ordered, de-duplicated list of cited sources. */
  citations: Citation[];
}

/**
 * The common normalized per-(query, page) shape (ARCHITECTURE.md §8): `{appeared, cited, position, sources[]}`.
 * Computed by comparing a target page's domain against an EngineQueryResult's citations.
 */
export interface EngineResult {
  /** Target page's domain mentioned in the answer (text or citations). */
  appeared: boolean;
  /** Target page's domain present in the citations. */
  cited: boolean;
  /** 1-based rank of the target's first citation, or null if not cited. */
  position: number | null;
  /** All cited source URLs for the query (raw), in citation order. */
  sources: string[];
}

/**
 * The `measurement` contract record (docs/CONTRACT.md §5).
 * `id` is assigned by Convex (P1) on persist, so it is absent on a freshly-built row.
 * Aggregates (P_cited, ci_low, ci_high, position_weight) are computed later (P2·3), not here.
 */
export interface MeasurementRow {
  id?: string;
  query_id: string;
  page_url: string;
  engine: Engine;
  model_version: string;
  run_idx: number;
  appeared: boolean;
  cited: boolean;
  position: number | null;
  source_urls: string[];
  /** Epoch milliseconds. */
  ts: number;
  /** Phase-0 baseline (pre-experiment) measurement ⇒ "adhoc". */
  window_tag: WindowTag;
  experiment_id?: string;
}
