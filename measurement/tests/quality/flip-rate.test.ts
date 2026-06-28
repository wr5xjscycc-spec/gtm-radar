import { describe, it, expect } from "vitest";
import { computeFlipRates } from "../../src/quality/flip-rate";
import type { Engine, MeasurementRow } from "../../src/types";

// P2·4 Module 1 — measurement-noise QA (flip-rate).
// Group run-level MeasurementRow[] by the FULL (query_id, page_url, engine) triple (stable
// first-seen order, same discipline as aggregate.ts). Per group we integrate THREE instability
// lenses over the same K binary `cited` outcomes:
//   - minority_fraction = min(cited_count, k-cited_count)/k ∈ [0,0.5]  (PRIMARY; flipped = >0)
//   - transition_rate   = adjacent label changes / (k-1), rows ORDERED BY run_idx  (informational)
//   - entropy           = binary Shannon entropy of p=cited_count/k in BITS ∈ [0,1]  (0*log2(0)=0)
// Groups with k<2 are EXCLUDED from n_groups + all means (counted in n_insufficient). Engines
// are never merged. Numbers below are the spec's exact contract.

/** Minimal MeasurementRow factory — defaults the fields flip-rate ignores. */
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

/** A cited run at a given run_idx. */
function cited(run_idx: number, over: Partial<MeasurementRow> = {}): MeasurementRow {
  return row({ cited: true, appeared: true, position: 1, run_idx, ...over });
}

/** An uncited run at a given run_idx. */
function uncited(run_idx: number, over: Partial<MeasurementRow> = {}): MeasurementRow {
  return row({ cited: false, position: null, run_idx, ...over });
}

/** Build K rows for one (query,page,engine) group: first `nCited` cited, rest uncited, run_idx 0..K-1. */
function group(nCited: number, k: number, over: Partial<MeasurementRow> = {}): MeasurementRow[] {
  const rows: MeasurementRow[] = [];
  for (let i = 0; i < k; i++) {
    rows.push(i < nCited ? cited(i, over) : uncited(i, over));
  }
  return rows;
}

describe("computeFlipRates", () => {
  it("returns [] on empty input", () => {
    expect(computeFlipRates([])).toEqual([]);
  });

  it("one report per engine; one group per engine for same query+page (engines never merged)", () => {
    const rows = [
      ...group(2, 3, { engine: "openai" }),
      ...group(2, 3, { engine: "perplexity" }),
    ];
    const reports = computeFlipRates(rows);
    expect(reports).toHaveLength(2);
    const engines = reports.map((r) => r.engine).sort();
    expect(engines).toEqual(["openai", "perplexity"]);
    // each report has exactly one eligible group
    for (const r of reports) {
      expect(r.n_groups).toBe(1);
      expect(r.unstable).toHaveLength(1); // 2/3 is flipped
    }
  });

  it("reports follow first-seen engine order", () => {
    const rows = [
      ...group(1, 2, { engine: "perplexity" }),
      ...group(1, 2, { engine: "openai" }),
    ];
    const reports = computeFlipRates(rows);
    expect(reports.map((r) => r.engine)).toEqual(["perplexity", "openai"]);
  });

  describe("minority_fraction (PRIMARY) + flipped", () => {
    it("3/3 unanimous → minority 0, flipped false", () => {
      const r = computeFlipRates(group(3, 3))[0]!;
      const g = r.unstable; // none flipped
      expect(g).toHaveLength(0);
      expect(r.mean_minority_fraction).toBe(0);
      expect(r.n_flipped).toBe(0);
    });

    it("0/3 unanimous → minority 0, flipped false", () => {
      const r = computeFlipRates(group(0, 3))[0]!;
      expect(r.unstable).toHaveLength(0);
      expect(r.mean_minority_fraction).toBe(0);
      expect(r.n_flipped).toBe(0);
    });

    it("2/3 → minority 0.333, flipped true", () => {
      const r = computeFlipRates(group(2, 3))[0]!;
      expect(r.n_flipped).toBe(1);
      const g = r.unstable[0]!;
      expect(g.minority_fraction).toBeCloseTo(0.333, 3);
      expect(g.flipped).toBe(true);
      expect(g.cited_count).toBe(2);
      expect(g.k).toBe(3);
    });

    it("2/4 → minority 0.5 (max), flipped true", () => {
      const r = computeFlipRates(group(2, 4))[0]!;
      const g = r.unstable[0]!;
      expect(g.minority_fraction).toBe(0.5);
      expect(g.flipped).toBe(true);
    });
  });

  describe("transition_rate honors run_idx order (shuffled input)", () => {
    it("{0:cited,1:uncited,2:cited} shuffled → 2 transitions / 2 = 1.0", () => {
      // Deliberately shuffle the input order; run_idx is the source of truth.
      const rows = [cited(2), cited(0), uncited(1)];
      const r = computeFlipRates(rows)[0]!;
      const g = r.unstable[0]!;
      expect(g.transition_rate).toBe(1.0);
    });

    it("{0:cited,1:cited,2:uncited} shuffled → 1 transition / 2 = 0.5", () => {
      const rows = [uncited(2), cited(1), cited(0)];
      const r = computeFlipRates(rows)[0]!;
      const g = r.unstable[0]!;
      expect(g.transition_rate).toBe(0.5);
    });

    it("unanimous → 0 transitions", () => {
      const r = computeFlipRates(group(3, 3))[0]!;
      expect(r.mean_transition_rate).toBe(0);
    });
  });

  describe("entropy (binary Shannon, BITS)", () => {
    it("unanimous (3/3) → 0, no NaN at p=1", () => {
      const r = computeFlipRates(group(3, 3))[0]!;
      expect(r.mean_entropy).toBe(0);
      expect(Number.isNaN(r.mean_entropy)).toBe(false);
    });

    it("unanimous (0/3) → 0, no NaN at p=0", () => {
      const r = computeFlipRates(group(0, 3))[0]!;
      expect(r.mean_entropy).toBe(0);
      expect(Number.isNaN(r.mean_entropy)).toBe(false);
    });

    it("2/4 → 1.0 (max at p=0.5)", () => {
      const r = computeFlipRates(group(2, 4))[0]!;
      expect(r.unstable[0]!.entropy).toBeCloseTo(1.0, 3);
    });

    it("1/4 → 0.811 (tol 1e-3)", () => {
      const r = computeFlipRates(group(1, 4))[0]!;
      expect(r.unstable[0]!.entropy).toBeCloseTo(0.811, 3);
    });
  });

  describe("k<2 groups", () => {
    it("single-draw group → n_insufficient, excluded from n_groups and means", () => {
      const rows = group(1, 1); // k=1
      const r = computeFlipRates(rows)[0]!;
      expect(r.n_insufficient).toBe(1);
      expect(r.n_groups).toBe(0);
      expect(r.n_flipped).toBe(0);
      // no NaN despite zero eligible groups
      expect(r.flip_fraction).toBe(0);
      expect(r.mean_minority_fraction).toBe(0);
      expect(r.mean_transition_rate).toBe(0);
      expect(r.mean_entropy).toBe(0);
      expect(r.unstable).toHaveLength(0);
    });

    it("all-k<2 engine → flip_fraction 0, no NaN", () => {
      const rows = [
        ...group(1, 1, { page_url: "https://a.com/x" }),
        ...group(0, 1, { page_url: "https://b.com/y" }),
      ];
      const r = computeFlipRates(rows)[0]!;
      expect(r.n_groups).toBe(0);
      expect(r.n_insufficient).toBe(2);
      expect(r.flip_fraction).toBe(0);
      expect(Number.isNaN(r.flip_fraction)).toBe(false);
      expect(Number.isNaN(r.mean_minority_fraction)).toBe(false);
      expect(Number.isNaN(r.mean_entropy)).toBe(false);
      expect(Number.isNaN(r.mean_transition_rate)).toBe(false);
    });

    it("k<2 group does not contribute to means alongside an eligible group", () => {
      const rows = [
        ...group(2, 4, { page_url: "https://flip.com/x" }), // eligible: minority 0.5, entropy 1.0
        ...group(1, 1, { page_url: "https://single.com/y" }), // k<2: excluded
      ];
      const r = computeFlipRates(rows)[0]!;
      expect(r.n_groups).toBe(1);
      expect(r.n_insufficient).toBe(1);
      // mean is over the single eligible group only
      expect(r.mean_minority_fraction).toBe(0.5);
      expect(r.mean_entropy).toBeCloseTo(1.0, 3);
    });
  });

  describe("flip_fraction and means over eligible groups", () => {
    it("flip_fraction = n_flipped / n_groups", () => {
      const rows = [
        ...group(2, 4, { page_url: "https://flip.com/x" }), // flipped
        ...group(4, 4, { page_url: "https://stable.com/y" }), // unanimous, not flipped
      ];
      const r = computeFlipRates(rows)[0]!;
      expect(r.n_groups).toBe(2);
      expect(r.n_flipped).toBe(1);
      expect(r.flip_fraction).toBe(0.5);
    });
  });

  describe("unstable[] sorted worst-first", () => {
    it("by minority_fraction desc, tiebreak entropy desc", () => {
      const rows = [
        ...group(1, 4, { page_url: "https://low.com/x" }), // minority 0.25, entropy 0.811
        ...group(2, 4, { page_url: "https://high.com/y" }), // minority 0.5, entropy 1.0
        ...group(1, 3, { page_url: "https://mid.com/z" }), // minority 0.333, entropy ~0.918
      ];
      const r = computeFlipRates(rows)[0]!;
      expect(r.unstable.map((g) => g.page_url)).toEqual([
        "https://high.com/y", // 0.5
        "https://mid.com/z", // 0.333
        "https://low.com/x", // 0.25
      ]);
    });

    it("equal minority_fraction → tiebreak by entropy desc", () => {
      // Both have minority_fraction 0.4 (2/5), so entropy is identical too — use distinct
      // minority-equal groups: 2/5 (min 0.4, ent ~0.971) vs ... pick same minority but the
      // tiebreak is exercised when entropies differ. 2/4 (min 0.5) vs 3/6 (min 0.5): equal
      // minority, equal entropy (both p=0.5) → stable first-seen order preserved.
      const rows = [
        ...group(3, 6, { page_url: "https://first.com/a" }), // min 0.5, ent 1.0
        ...group(2, 4, { page_url: "https://second.com/b" }), // min 0.5, ent 1.0
      ];
      const r = computeFlipRates(rows)[0]!;
      // full tie → stable first-seen order
      expect(r.unstable.map((g) => g.page_url)).toEqual([
        "https://first.com/a",
        "https://second.com/b",
      ]);
    });

    it("only flipped groups appear in unstable; unanimous excluded", () => {
      const rows = [
        ...group(2, 4, { page_url: "https://flip.com/x" }),
        ...group(4, 4, { page_url: "https://stable.com/y" }),
      ];
      const r = computeFlipRates(rows)[0]!;
      expect(r.unstable.map((g) => g.page_url)).toEqual(["https://flip.com/x"]);
    });
  });
});
