import type { AggregateResult } from "./aggregate";
import type { EngineName } from "./engine";
import { normalizeDomain, normalizeUrl } from "../../convex/lib/domain";

export type Label = "winner" | "loser";

export interface LabelTableRow {
  query_id: string;
  page_url: string;
  company_domain: string;
  engine: EngineName;
  P_cited: number;
  ci_low: number;
  ci_high: number;
  position_weight: number;
  K: number;
  label: Label;
}

export interface LabelTableResult {
  engines: EngineName[];
  rows: LabelTableRow[];
}

/**
 * Build per-engine aggregate tables from a list of AggregateResult records.
 *
 * Each row is keyed on normalized domain/URL for clean P4 joins.
 * Engines are NEVER pooled — output is per-engine.
 *
 * Winner/loser label is computed as P_cited > 0 (any citation across K runs).
 * This is the case-control group label; P4 uses the continuous P_cited rate for
 * model fitting and the binary for group assignment. Threshold MUST match P4's
 * winner_loser.py (P_cited > 0, not >= 0.5).
 */
export function buildLabelTables(
  aggregates: AggregateResult[],
): LabelTableResult {
  const engineMap = new Map<EngineName, LabelTableRow[]>();

  for (const agg of aggregates) {
    const rows = engineMap.get(agg.engine) ?? [];
    rows.push({
      query_id: agg.query_id,
      page_url: normalizeUrl(agg.page_url),
      company_domain: normalizeDomain(agg.company_domain),
      engine: agg.engine,
      P_cited: agg.P_cited,
      ci_low: agg.ci_low,
      ci_high: agg.ci_high,
      position_weight: agg.position_weight,
      K: agg.K,
      label: agg.P_cited > 0 ? "winner" : "loser",
    });
    engineMap.set(agg.engine, rows);
  }

  return {
    engines: [...engineMap.keys()],
    rows: Object.values(Object.fromEntries(engineMap)).flat(),
  };
}
