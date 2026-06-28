import { describe, it, expect } from "vitest";
import { aggregateRuns } from "../../src/stats/aggregate";
import { wilsonInterval } from "../../src/stats/wilson";
import type { Engine, MeasurementRow } from "../../src/types";

// P2·3 stats core: per-engine run aggregation.
// Group MeasurementRow[] by (query_id, page_url, engine) — the FULL key. `engine` is part
// of the key on purpose (cross-engine overlap ~11%; merging is a correctness bug). Per group
// we compute k, cited_count, p_cited, the Wilson CI, and position_weight (mean reciprocal rank
// over the CITED runs only — orthogonal to p_cited). Numbers below are the spec's exact contract.

/** Minimal MeasurementRow factory — defaults the fields the aggregate ignores. */
function row(over: Partial<MeasurementRow>): MeasurementRow {
  return {
    query_id: "q1",
    page_url: "https://acme.com/pricing",
    engine: "openai",
    model_version: "gpt-5-2026",
    run_idx: 0,
    appeared: over.cited ?? false,
    cited: false,
    position: null,
    source_urls: [],
    ts: 1_700_000_000_000,
    window_tag: "adhoc",
    ...over,
  };
}

/** A cited run at a given 1-based position. */
function citedAt(position: number, over: Partial<MeasurementRow> = {}): MeasurementRow {
  return row({ cited: true, position, appeared: true, ...over });
}

/** An uncited run. */
function uncited(over: Partial<MeasurementRow> = {}): MeasurementRow {
  return row({ cited: false, position: null, ...over });
}

describe("aggregateRuns", () => {
  it("empty input → []", () => {
    expect(aggregateRuns([])).toEqual([]);
  });

  it("groups K rows of one (query, page, engine) into ONE aggregate with correct k/cited_count/p_cited", () => {
    const rows: MeasurementRow[] = [
      citedAt(1, { run_idx: 0 }),
      uncited({ run_idx: 1 }),
      citedAt(2, { run_idx: 2 }),
    ];
    const aggs = aggregateRuns(rows);
    expect(aggs).toHaveLength(1);
    const a = aggs[0]!;
    expect(a.query_id).toBe("q1");
    expect(a.page_url).toBe("https://acme.com/pricing");
    expect(a.engine).toBe("openai");
    expect(a.k).toBe(3);
    expect(a.cited_count).toBe(2);
    expect(a.p_cited).toBeCloseTo(2 / 3, 12);
  });

  it("CI matches wilsonInterval(cited_count, k) exactly", () => {
    const rows: MeasurementRow[] = [
      citedAt(1, { run_idx: 0 }),
      uncited({ run_idx: 1 }),
      citedAt(2, { run_idx: 2 }),
    ];
    const a = aggregateRuns(rows)[0]!;
    const ref = wilsonInterval(2, 3);
    expect(a.ci_low).toBeCloseTo(ref.low, 12);
    expect(a.ci_high).toBeCloseTo(ref.high, 12);
  });

  it("position_weight: cited @#1 in 2 of 3 runs → 1.0 (mean reciprocal rank over CITED runs only)", () => {
    // Two cited runs at #1, one uncited run. Mean of (1/1, 1/1) over CITED only = 1.0.
    const rows: MeasurementRow[] = [
      citedAt(1, { run_idx: 0 }),
      citedAt(1, { run_idx: 1 }),
      uncited({ run_idx: 2 }),
    ];
    const a = aggregateRuns(rows)[0]!;
    expect(a.cited_count).toBe(2);
    expect(a.p_cited).toBeCloseTo(2 / 3, 12);
    expect(a.position_weight).toBeCloseTo(1.0, 12);
  });

  it("position_weight: cited @#1 once + @#3 once → 0.667 (mean of 1/1 and 1/3)", () => {
    const rows: MeasurementRow[] = [
      citedAt(1, { run_idx: 0 }),
      citedAt(3, { run_idx: 1 }),
    ];
    const a = aggregateRuns(rows)[0]!;
    // (1/1 + 1/3) / 2 = 0.6666...
    expect(a.position_weight).toBeCloseTo(2 / 3, 3);
    expect(Math.abs(a.position_weight - 0.667)).toBeLessThan(1e-3);
  });

  it("position_weight: never cited → 0 (and is orthogonal to p_cited, not averaged over all K)", () => {
    const rows: MeasurementRow[] = [
      uncited({ run_idx: 0 }),
      uncited({ run_idx: 1 }),
      uncited({ run_idx: 2 }),
    ];
    const a = aggregateRuns(rows)[0]!;
    expect(a.cited_count).toBe(0);
    expect(a.p_cited).toBe(0);
    expect(a.position_weight).toBe(0);
  });

  it("position_weight averages over cited runs ONLY, not over all K (orthogonal to p_cited)", () => {
    // Cited @#1 once out of FOUR runs. If it (wrongly) averaged over all 4, weight = 0.25.
    // Correct: average over the 1 cited run = 1.0. p_cited = 0.25, weight = 1.0 — independent.
    const rows: MeasurementRow[] = [
      citedAt(1, { run_idx: 0 }),
      uncited({ run_idx: 1 }),
      uncited({ run_idx: 2 }),
      uncited({ run_idx: 3 }),
    ];
    const a = aggregateRuns(rows)[0]!;
    expect(a.p_cited).toBeCloseTo(0.25, 12);
    expect(a.position_weight).toBeCloseTo(1.0, 12);
  });

  it("CRITICAL: same query_id + page_url on TWO different engines → TWO separate aggregates (never merge)", () => {
    const rows: MeasurementRow[] = [
      citedAt(1, { engine: "openai", run_idx: 0 }),
      uncited({ engine: "openai", run_idx: 1 }),
      citedAt(2, { engine: "perplexity", run_idx: 0 }),
    ];
    const aggs = aggregateRuns(rows);
    expect(aggs).toHaveLength(2);
    const engines = aggs.map((a) => a.engine);
    expect(engines).toContain("openai" as Engine);
    expect(engines).toContain("perplexity" as Engine);

    const openai = aggs.find((a) => a.engine === "openai")!;
    const perplexity = aggs.find((a) => a.engine === "perplexity")!;
    expect(openai.k).toBe(2);
    expect(openai.cited_count).toBe(1);
    expect(perplexity.k).toBe(1);
    expect(perplexity.cited_count).toBe(1);
    // Same query_id + page_url on both — only the engine differs.
    expect(openai.query_id).toBe(perplexity.query_id);
    expect(openai.page_url).toBe(perplexity.page_url);
  });

  it("separate aggregates also when query_id differs and when page_url differs", () => {
    const rows: MeasurementRow[] = [
      citedAt(1, { query_id: "q1", page_url: "https://a.com" }),
      citedAt(1, { query_id: "q2", page_url: "https://a.com" }),
      citedAt(1, { query_id: "q1", page_url: "https://b.com" }),
    ];
    const aggs = aggregateRuns(rows);
    expect(aggs).toHaveLength(3);
  });

  it("grouping is STABLE in first-seen order of (query_id, page_url, engine)", () => {
    const rows: MeasurementRow[] = [
      citedAt(1, { query_id: "qB", page_url: "https://z.com", engine: "gemini" }),
      uncited({ query_id: "qA", page_url: "https://y.com", engine: "openai" }),
      // second row for the first group — must NOT create a new group nor reorder.
      uncited({ query_id: "qB", page_url: "https://z.com", engine: "gemini" }),
      citedAt(1, { query_id: "qA", page_url: "https://y.com", engine: "openai" }),
    ];
    const aggs = aggregateRuns(rows);
    expect(aggs).toHaveLength(2);
    // First-seen group is (qB, z.com, gemini); second is (qA, y.com, openai).
    expect(aggs[0]!.query_id).toBe("qB");
    expect(aggs[0]!.engine).toBe("gemini");
    expect(aggs[0]!.k).toBe(2);
    expect(aggs[1]!.query_id).toBe("qA");
    expect(aggs[1]!.engine).toBe("openai");
    expect(aggs[1]!.k).toBe(2);
  });

  it("carries model_version from the rows (consistent across runs)", () => {
    const rows: MeasurementRow[] = [
      citedAt(1, { model_version: "gpt-5-2026-06" }),
      uncited({ model_version: "gpt-5-2026-06" }),
    ];
    const a = aggregateRuns(rows)[0]!;
    expect(a.model_version).toBe("gpt-5-2026-06");
  });

  it("defensive: a cited run with a null/invalid position does not corrupt position_weight", () => {
    // A row flagged cited but with position null (upstream inconsistency) must not yield NaN.
    const rows: MeasurementRow[] = [
      citedAt(1, { run_idx: 0 }),
      row({ cited: true, position: null, run_idx: 1, appeared: true }),
    ];
    const a = aggregateRuns(rows)[0]!;
    expect(Number.isNaN(a.position_weight)).toBe(false);
    // Only the run with a valid position contributes its reciprocal rank.
    expect(a.position_weight).toBeCloseTo(1.0, 12);
  });
});
