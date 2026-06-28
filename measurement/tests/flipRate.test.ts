import { describe, it, expect } from "vitest";
import { computeFlipRate } from "../src/flipRate";
import type { RunRecord } from "../src/aggregate";

const makeRun = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  query_id: "qry_test",
  page_url: "https://acme.com/pricing",
  company_domain: "acme.com",
  engine: "openai",
  model_version: "gpt-4o-2024-08-06",
  run_idx: 0,
  appeared: true,
  cited: true,
  position: 0,
  source_urls: ["https://acme.com/pricing"],
  ts: Date.now(),
  ...overrides,
});

describe("computeFlipRate", () => {
  it("returns 0 flip rate for identical runs", () => {
    const runs = [
      makeRun({ run_idx: 0, cited: true }),
      makeRun({ run_idx: 1, cited: true }),
      makeRun({ run_idx: 2, cited: true }),
    ];
    const result = computeFlipRate(runs);
    expect(result.overall_flip_rate).toBe(0);
    expect(result.total_pairs).toBe(3);
    expect(result.flipped_pairs).toBe(0);
  });

  it("returns 0 flip rate when all uncited", () => {
    const runs = [
      makeRun({ run_idx: 0, cited: false, position: null, source_urls: [] }),
      makeRun({ run_idx: 1, cited: false, position: null, source_urls: [] }),
    ];
    const result = computeFlipRate(runs);
    expect(result.overall_flip_rate).toBe(0);
    expect(result.total_pairs).toBe(1);
    expect(result.flipped_pairs).toBe(0);
  });

  it("detects flips when labels differ", () => {
    // 3 runs: winner, loser, winner
    // Pairs: (0,1)=flip, (0,2)=same, (1,2)=flip → 2/3 flipped
    const runs = [
      makeRun({ run_idx: 0, cited: true }),
      makeRun({ run_idx: 1, cited: false, position: null, source_urls: [] }),
      makeRun({ run_idx: 2, cited: true }),
    ];
    const result = computeFlipRate(runs);
    expect(result.total_pairs).toBe(3);
    expect(result.flipped_pairs).toBe(2);
    expect(result.overall_flip_rate).toBeCloseTo(2 / 3, 5);
  });

  it("handles single run (no pairs)", () => {
    const runs = [makeRun({ run_idx: 0, cited: true })];
    const result = computeFlipRate(runs);
    expect(result.overall_flip_rate).toBe(0);
    expect(result.total_pairs).toBe(0);
    expect(result.flipped_pairs).toBe(0);
  });

  it("handles empty input", () => {
    const result = computeFlipRate([]);
    expect(result.overall_flip_rate).toBe(0);
    expect(result.total_pairs).toBe(0);
    expect(result.flipped_pairs).toBe(0);
  });

  it("groups runs by (query_id, page_url)", () => {
    const runs = [
      makeRun({ query_id: "qry_a", page_url: "https://acme.com/p1", run_idx: 0, cited: true }),
      makeRun({ query_id: "qry_a", page_url: "https://acme.com/p1", run_idx: 1, cited: false, position: null, source_urls: [] }),
      makeRun({ query_id: "qry_a", page_url: "https://acme.com/p2", run_idx: 0, cited: true }),
      makeRun({ query_id: "qry_a", page_url: "https://acme.com/p2", run_idx: 1, cited: true }),
    ];
    const result = computeFlipRate(runs);
    // qry_a::acme.com/p1: 1 pair, 1 flip → 1.0
    // qry_a::acme.com/p2: 1 pair, 0 flips → 0.0
    expect(result.total_pairs).toBe(2);
    expect(result.flipped_pairs).toBe(1);
    expect(result.overall_flip_rate).toBe(0.5);
  });

  it("reports per-page flip rates", () => {
    const runs = [
      makeRun({ run_idx: 0, cited: true }),
      makeRun({ run_idx: 1, cited: false, position: null, source_urls: [] }),
      makeRun({ run_idx: 2, cited: true }),
    ];
    const result = computeFlipRate(runs);
    const key = "qry_test::https://acme.com/pricing";
    expect(result.per_page[key]).toBeDefined();
    expect(result.per_page[key].flip_rate).toBeCloseTo(2 / 3, 5);
    expect(result.per_page[key].total_pairs).toBe(3);
    expect(result.per_page[key].flipped_pairs).toBe(2);
  });

  it("handles 5-run synthetic repeated runs with varied outcome", () => {
    // 5 runs: W, L, W, L, W
    // C(5,2)=10 pairs; flips when labels differ:
    // W-L: positions 0-1,0-3,2-1,2-3,4-1,4-3 = 6 flips
    // W-W: 0-2,0-4,2-4 = 3 same
    // L-L: 1-3 = 1 same
    const runs = [true, false, true, false, true].map((cited, i) =>
      makeRun({
        run_idx: i,
        cited,
        position: cited ? 0 : null,
        source_urls: cited ? ["https://acme.com/pricing"] : [],
      }),
    );
    const result = computeFlipRate(runs);
    expect(result.total_pairs).toBe(10);
    expect(result.flipped_pairs).toBe(6);
    expect(result.overall_flip_rate).toBeCloseTo(0.6, 5);
  });
});
