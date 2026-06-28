// P2 (Measurement) — Phase-2 composition: turn one engine's query result + the candidate pool
// into case-control-labeled `measurement` rows (the "labeled, pre-aggregation scaffolding").
//
// This is the seam P2·2 actually delivers: dispatch (dispatch.ts) gives per-engine
// EngineQueryResults; this threads ONE of them, plus the candidate pool, into one measurement
// row per candidate page — `cited` is the winner/loser label. Per-engine only (never merge
// engines). Rows are produced ONLY for candidate-pool pages, preserving the case-control
// invariant (a loser is a pool page that wasn't cited, never an arbitrary uncited page).

import type { EngineQueryResult, MeasurementRow, WindowTag } from "./types";
import type { QueryRecord, CandidatePage } from "./contract-records";
import { normalizeDomain } from "./normalize";
import { deriveEngineResult, buildMeasurementRow } from "./measurement";

/**
 * Build one case-control-labeled `measurement` row per candidate page for a single engine's result.
 *
 * For each candidate page (keyed on its normalized `company_domain`):
 *  - `cited`/`position`/`appeared` are derived against this engine's citations;
 *  - `source_urls` is the engine's full cited-source list;
 *  - the row is stamped with the query id, engine, model version, run index, ts, and window tag.
 *
 * Pages whose `company_domain` normalizes to "" are skipped (defensive — we never label garbage).
 * The candidate pool is an explicit input — this does NOT assemble it (that is P3·3's job).
 *
 * @param params.runIdx   Defaults to 0 (a single, unrepeated measurement — K-repeats are P2·3).
 * @param params.windowTag Defaults to "adhoc" (Phase-0/2 baseline, pre-experiment).
 */
export function buildLabeledRows(params: {
  query: QueryRecord;
  engineResult: EngineQueryResult;
  candidatePool: CandidatePage[];
  ts: number;
  runIdx?: number;
  windowTag?: WindowTag;
}): MeasurementRow[] {
  const { query, engineResult, candidatePool, ts, runIdx = 0, windowTag } = params;

  const rows: MeasurementRow[] = [];
  for (const page of candidatePool) {
    if (normalizeDomain(page.company_domain) === "") continue; // never label garbage

    // Match on the page's domain (the contract join key), consistent with labelCaseControl.
    const engineResultForPage = deriveEngineResult(
      engineResult.citations,
      page.company_domain,
      engineResult.answer_text,
    );

    rows.push(
      buildMeasurementRow({
        queryId: query.id,
        pageUrl: page.url,
        engine: engineResult.engine,
        modelVersion: engineResult.model_version,
        runIdx,
        engineResult: engineResultForPage,
        ts,
        windowTag,
      }),
    );
  }

  return rows;
}
