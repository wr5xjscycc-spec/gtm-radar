// P2 (Measurement) — measurement-row builder.
// Turns parsed citations + a target page into the engine-agnostic per-(query, page)
// shape (docs/ARCHITECTURE.md §8) and the frozen `measurement` contract record
// (docs/CONTRACT.md §5). Pure functions: no network, no engine calls.
//
// Per-engine throughout (cross-engine citation overlap is ~11%) — never merge engines.

import type { Citation, Engine, EngineResult, MeasurementRow, WindowTag } from "./types";
import { normalizeDomain } from "./normalize";

/**
 * Compare a target page against ONE engine's parsed citations (+ optional answer text)
 * and derive the normalized {appeared, cited, position, sources[]} shape.
 *
 * - `cited`    — some citation's domain equals the target's normalized domain.
 * - `position` — the 1-based `rank` of the FIRST matching citation, else null.
 * - `appeared` — `cited`, OR (when `answerText` is given) the answer text mentions the
 *                target domain (case-insensitive substring). Omitting `answerText` ⇒
 *                `appeared === cited`.
 * - `sources`  — every citation's raw url, in citation order (no re-sort/de-dup here).
 *
 * If the target normalizes to "" (empty/garbage URL) we short-circuit to all
 * false/null and never match the empty string against anything — "".includes("") and
 * "" === "" are both true in JS, which would otherwise yield false positives.
 */
export function deriveEngineResult(
  citations: Citation[],
  targetPageUrl: string,
  answerText?: string,
): EngineResult {
  const sources = citations.map((c) => c.url);
  const targetDomain = normalizeDomain(targetPageUrl);

  if (targetDomain === "") {
    return { appeared: false, cited: false, position: null, sources };
  }

  const match = citations.find((c) => c.domain === targetDomain);
  const cited = match !== undefined;
  const position = match ? match.rank : null;

  const mentionedInAnswer =
    answerText !== undefined && answerText.toLowerCase().includes(targetDomain);
  const appeared = cited || mentionedInAnswer;

  return { appeared, cited, position, sources };
}

/**
 * Build a `measurement` contract record (docs/CONTRACT.md §5) from a derived
 * EngineResult plus run metadata. `id` is assigned by Convex (P1) on persist, so it is
 * never set here; aggregates (P_cited, CIs, position_weight) are computed later (P2·3).
 *
 * `window_tag` defaults to "adhoc" (Phase-0 baseline). `experiment_id` is included ONLY
 * when provided — the key is absent (not set to undefined) otherwise.
 */
export function buildMeasurementRow(params: {
  queryId: string;
  pageUrl: string;
  engine: Engine;
  modelVersion: string;
  runIdx: number;
  engineResult: EngineResult;
  ts: number;
  windowTag?: WindowTag;
  experimentId?: string;
}): MeasurementRow {
  return {
    query_id: params.queryId,
    page_url: params.pageUrl,
    engine: params.engine,
    model_version: params.modelVersion,
    run_idx: params.runIdx,
    appeared: params.engineResult.appeared,
    cited: params.engineResult.cited,
    position: params.engineResult.position,
    source_urls: params.engineResult.sources,
    ts: params.ts,
    window_tag: params.windowTag ?? "adhoc",
    ...(params.experimentId !== undefined ? { experiment_id: params.experimentId } : {}),
  };
}
