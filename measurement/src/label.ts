import type { EngineResult } from "./engine";
import { normalizeDomain } from "../../convex/lib/domain";

export interface CandidatePoolItem {
  company_domain: string;
  page_url: string;
}

export type Label = "winner" | "loser";

export interface LabeledRow {
  query_id: string;
  page_url: string;
  company_domain: string;
  engine: string;
  model_version: string;
  run_idx: number;
  appeared: boolean;
  cited: boolean;
  position: number | null;
  source_urls: string[];
  label: Label;
}

export interface LabelResult {
  rows: LabeledRow[];
}

/**
 * Case-control labeling:
 *  - winner = a candidate page whose domain was cited by the engine.
 *  - loser  = a page in the candidate pool that was NOT cited.
 *
 * CRITICAL: losers come ONLY from the candidate pool (candidatePages).
 * Arbitrary uncited pages are NEVER labeled as losers — that would
 * reintroduce the selection-bias hole.
 */
export function labelMeasurements(
  queryId: string,
  engineResult: EngineResult,
  candidatePages: CandidatePoolItem[],
): LabelResult {
  const rows: LabeledRow[] = [];
  const citedDomains = new Set(
    engineResult.source_urls.map((u) => normalizeDomain(u)),
  );

  // Published URL for the target page (the one the query was run for)
  const targetDomain = normalizeDomain(
    candidatePages.length > 0 ? candidatePages[0].company_domain : "",
  );

  for (const page of candidatePages) {
    const nd = normalizeDomain(page.company_domain);
    const wasCited = citedDomains.has(nd);

    const label: Label = wasCited ? "winner" : "loser";

    rows.push({
      query_id: queryId,
      page_url: page.page_url,
      company_domain: page.company_domain,
      engine: engineResult.engine,
      model_version: engineResult.model_version,
      run_idx: 0,
      appeared: engineResult.appeared,
      cited: wasCited,
      position: nd === normalizeDomain(engineResult.source_urls[0] ?? "") ? 0 : null,
      source_urls: engineResult.source_urls,
      label,
    });
  }

  return { rows };
}

export function labelFromTargetDomain(
  queryId: string,
  engineResult: EngineResult,
  targetDomain: string,
  pageUrl: string,
  candidatePages: CandidatePoolItem[],
): LabelResult {
  const base = labelMeasurements(queryId, engineResult, candidatePages);

  // Add the specific target page result
  const nd = normalizeDomain(targetDomain);
  const citedDomains = new Set(
    engineResult.source_urls.map((u) => normalizeDomain(u)),
  );
  const wasCited = citedDomains.has(nd);

  const targetIdx = engineResult.source_urls.findIndex(
    (u) => normalizeDomain(u) === nd,
  );

  base.rows.push({
    query_id: queryId,
    page_url: pageUrl,
    company_domain: targetDomain,
    engine: engineResult.engine,
    model_version: engineResult.model_version,
    run_idx: 0,
    appeared: engineResult.appeared,
    cited: wasCited,
    position: targetIdx >= 0 ? targetIdx : null,
    source_urls: engineResult.source_urls,
    label: wasCited ? "winner" : "loser",
  });

  return base;
}
