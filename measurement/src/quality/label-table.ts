// P2.4 (Measurement, label quality) — Module 2: the model-ready label table for P4.
//
// P4's hypothesis generator consumes ONE flat table: per-(query, page, engine) it wants the
// citation rate + CI it should reason over, plus the two keys it cannot derive itself — the
// NORMALIZED company_domain (the P1 join key) and the page `role`. Neither lives on the
// aggregate; both live on the candidate pool. So this module's whole job is the join: attach the
// pool's domain+role to each aggregate by matching `aggregate.page_url` to a pool `page.url`.
//
// Two deliberate, contract-driven choices, both load-bearing:
//
//   1. The URL join is EXACT. The contract carries already-normalized URLs (P3 produces them), so
//      the path is a verbatim key — we do NOT re-run normalizeDomain on it. Re-normalizing the URL
//      path would collapse genuinely different pages (e.g. /pricing vs /pricing?ref=x) and
//      manufacture false matches. ONLY `company_domain` is normalized, via normalizeDomain.
//
//   2. A join MISS is a BUG to surface, not noise to swallow. If an aggregate's page_url has no
//      pool entry, the keying upstream is broken — we return that aggregate in `unmatched` so the
//      caller (and the human reading the report) sees it, rather than silently shrinking the table
//      and hiding the defect. This is the lane's "surface, don't bury" non-negotiable.
//
// `label` is a convenience majority flag (p_cited >= 0.5 -> "winner"); the RATE + CI are the
// primary signal P4 should weigh, the label is secondary. The threshold is inclusive: a page cited
// in exactly half its runs is a "winner" (tie goes to "cited").
//
// Pure: no network, no clock. Output depends only on the two arrays passed in.

import type { MeasurementAggregate } from "../stats/aggregate";
import type { CandidatePage, PageRole } from "../contract-records";
import type { Engine } from "../types";
import { normalizeDomain } from "../normalize";

export type Label = "winner" | "loser";

/**
 * One model-ready row: a per-(query, page, engine) aggregate joined to its pool page, carrying the
 * normalized domain key + role P4 needs. Aggregate fields (`p_cited`, CI, `position_weight`, `k`,
 * `model_version`) pass through verbatim; `company_domain` is the NORMALIZED pool domain; `role`
 * comes from the pool; `label` is the majority convenience flag.
 */
export interface LabelTableRow {
  query_id: string;
  engine: Engine;
  page_url: string;
  /** NORMALIZED company_domain from the matched pool page (the P1 join key). */
  company_domain: string;
  role: PageRole;
  p_cited: number;
  ci_low: number;
  ci_high: number;
  position_weight: number;
  k: number;
  /** `p_cited >= 0.5 ? "winner" : "loser"` — secondary to the rate+CI; tie -> "winner". */
  label: Label;
  model_version: string;
}

export interface LabelTable {
  rows: LabelTableRow[];
  /**
   * Aggregates whose `page_url` matched no pool page. A keying miss is a BUG to surface — these are
   * returned (the ORIGINAL aggregate objects, by reference) so the defect is visible, never dropped.
   */
  unmatched: MeasurementAggregate[];
}

/**
 * Build the model-ready label table by joining `aggregates` to `pool` on EXACT `page_url`/`url`.
 *
 * Join mechanics:
 * - Build a lookup `Map` keyed on the pool page's raw `url` (verbatim — the contract already
 *   normalizes URLs; re-normalizing the path here would forge false matches). On duplicate urls in
 *   the pool, last-write-wins; the contract doesn't promise unique urls and the choice is harmless
 *   to the join either way — we just make it deliberate.
 * - For each aggregate, in INPUT ORDER (downstream iterates positionally and expects determinism),
 *   look up `aggregate.page_url`. A hit emits a `LabelTableRow`; a miss appends the original
 *   aggregate to `unmatched`.
 *
 * The matched page's `company_domain` is normalized via `normalizeDomain` (the ONLY field we
 * normalize). We do NOT drop a row whose domain normalizes to "" — surfacing a degenerate domain is
 * better than hiding it, and dropping is Module 3's concern, not this join's.
 *
 * Empty inputs -> `{ rows: [], unmatched: [] }`.
 */
export function buildLabelTable(
  aggregates: MeasurementAggregate[],
  pool: CandidatePage[],
): LabelTable {
  // Pool lookup keyed on the RAW url — an exact string join, never re-normalized.
  const byUrl = new Map<string, CandidatePage>();
  for (const page of pool) {
    byUrl.set(page.url, page);
  }

  const rows: LabelTableRow[] = [];
  const unmatched: MeasurementAggregate[] = [];

  // Input order preserved: stable, deterministic output for positional downstream iteration.
  for (const aggregate of aggregates) {
    const page = byUrl.get(aggregate.page_url);
    if (page === undefined) {
      // Keying miss — surface the original aggregate, do not drop it.
      unmatched.push(aggregate);
      continue;
    }

    rows.push({
      query_id: aggregate.query_id,
      engine: aggregate.engine,
      page_url: aggregate.page_url,
      // ONLY field normalized — the P1 join key. May be "" for a garbage domain; we surface, not drop.
      company_domain: normalizeDomain(page.company_domain),
      role: page.role,
      p_cited: aggregate.p_cited,
      ci_low: aggregate.ci_low,
      ci_high: aggregate.ci_high,
      position_weight: aggregate.position_weight,
      k: aggregate.k,
      // Inclusive threshold: exactly-half -> "winner" (tie goes to cited).
      label: aggregate.p_cited >= 0.5 ? "winner" : "loser",
      model_version: aggregate.model_version,
    });
  }

  return { rows, unmatched };
}
