import { describe, it, expect } from "vitest";
import { detectModelDrift } from "../../src/quality/drift";
import type { Engine, MeasurementRow } from "../../src/types";

// P2·6 Module 2 — model-drift detection.
// Group RUN-LEVEL MeasurementRow[] by (query_id, engine); collect distinct model_version
// per group in stable FIRST-SEEN order. A group spanning >1 version is a DriftedGroup —
// the dangerous mid-group case where aggregating P_cited across a model change is polluted.
// perEngine lists distinct model_versions per engine across ALL rows (first-seen order).
// hasDrift = any drifted group. Per-engine, never merged.

/** Minimal MeasurementRow factory — defaults the fields drift detection ignores. */
function row(over: Partial<MeasurementRow>): MeasurementRow {
  return {
    query_id: "q1",
    page_url: "https://acme.com/pricing",
    engine: "openai",
    model_version: "gpt-5-2026",
    run_idx: 0,
    appeared: false,
    cited: false,
    position: null,
    source_urls: [],
    ts: 1_700_000_000_000,
    window_tag: "adhoc",
    ...over,
  };
}

describe("detectModelDrift", () => {
  it("empty rows → no drift, empty groups + perEngine", () => {
    const report = detectModelDrift([]);
    expect(report).toEqual({ hasDrift: false, driftedGroups: [], perEngine: [] });
  });

  it("single version everywhere → no drift", () => {
    const rows: MeasurementRow[] = [
      row({ query_id: "q1", engine: "openai", model_version: "v1", run_idx: 0 }),
      row({ query_id: "q1", engine: "openai", model_version: "v1", run_idx: 1 }),
      row({ query_id: "q2", engine: "openai", model_version: "v1", run_idx: 0 }),
    ];
    const report = detectModelDrift(rows);
    expect(report.hasDrift).toBe(false);
    expect(report.driftedGroups).toEqual([]);
    expect(report.perEngine).toEqual([{ engine: "openai", versions: ["v1"] }]);
  });

  it("one (query,engine) group spanning 2 versions → drifted + hasDrift true", () => {
    const rows: MeasurementRow[] = [
      row({ query_id: "q1", engine: "openai", model_version: "v1", run_idx: 0 }),
      row({ query_id: "q1", engine: "openai", model_version: "v2", run_idx: 1 }),
    ];
    const report = detectModelDrift(rows);
    expect(report.hasDrift).toBe(true);
    expect(report.driftedGroups).toEqual([
      { query_id: "q1", engine: "openai", versions: ["v1", "v2"] },
    ]);
    // Same versions surface at the engine level too.
    expect(report.perEngine).toEqual([{ engine: "openai", versions: ["v1", "v2"] }]);
  });

  it("two engines each with one version → no drift but both in perEngine", () => {
    const rows: MeasurementRow[] = [
      row({ query_id: "q1", engine: "openai", model_version: "gpt-5", run_idx: 0 }),
      row({ query_id: "q1", engine: "perplexity", model_version: "sonar-1", run_idx: 0 }),
    ];
    const report = detectModelDrift(rows);
    expect(report.hasDrift).toBe(false);
    expect(report.driftedGroups).toEqual([]);
    // Per-engine, never merged — each engine keeps its own single version.
    expect(report.perEngine).toEqual([
      { engine: "openai", versions: ["gpt-5"] },
      { engine: "perplexity", versions: ["sonar-1"] },
    ]);
  });

  it("version order is first-seen, not sorted", () => {
    // Within the group: v3 seen first, then v1, then v2. Output must preserve that order.
    const rows: MeasurementRow[] = [
      row({ query_id: "q1", engine: "openai", model_version: "v3", run_idx: 0 }),
      row({ query_id: "q1", engine: "openai", model_version: "v1", run_idx: 1 }),
      row({ query_id: "q1", engine: "openai", model_version: "v3", run_idx: 2 }),
      row({ query_id: "q1", engine: "openai", model_version: "v2", run_idx: 3 }),
    ];
    const report = detectModelDrift(rows);
    expect(report.driftedGroups[0]?.versions).toEqual(["v3", "v1", "v2"]);
    expect(report.perEngine[0]?.versions).toEqual(["v3", "v1", "v2"]);
  });

  it("group keys and engine keys are first-seen ordered across the sweep", () => {
    const rows: MeasurementRow[] = [
      row({ query_id: "q2", engine: "perplexity", model_version: "p1", run_idx: 0 }),
      row({ query_id: "q2", engine: "perplexity", model_version: "p2", run_idx: 1 }),
      row({ query_id: "q1", engine: "openai", model_version: "o1", run_idx: 0 }),
      row({ query_id: "q1", engine: "openai", model_version: "o2", run_idx: 1 }),
    ];
    const report = detectModelDrift(rows);
    expect(report.hasDrift).toBe(true);
    // First-seen group order: (q2,perplexity) before (q1,openai).
    expect(report.driftedGroups.map((g) => [g.query_id, g.engine])).toEqual([
      ["q2", "perplexity"],
      ["q1", "openai"],
    ]);
    // First-seen engine order: perplexity before openai.
    expect(report.perEngine.map((e) => e.engine)).toEqual(["perplexity", "openai"]);
  });

  it("same version reused across distinct (query,engine) groups → not drift", () => {
    // Two queries each measured once on the same version — no within-group change.
    const rows: MeasurementRow[] = [
      row({ query_id: "q1", engine: "openai", model_version: "v1", run_idx: 0 }),
      row({ query_id: "q2", engine: "openai", model_version: "v1", run_idx: 0 }),
    ];
    const report = detectModelDrift(rows);
    expect(report.hasDrift).toBe(false);
    expect(report.driftedGroups).toEqual([]);
    expect(report.perEngine).toEqual([{ engine: "openai", versions: ["v1"] }]);
  });

  it("perEngine aggregates distinct versions across queries even without mid-group drift", () => {
    // q1 on v1, q2 on v2 (same engine) — no single group drifts, but the engine spans both.
    const rows: MeasurementRow[] = [
      row({ query_id: "q1", engine: "openai", model_version: "v1", run_idx: 0 }),
      row({ query_id: "q2", engine: "openai", model_version: "v2", run_idx: 0 }),
    ];
    const report = detectModelDrift(rows);
    expect(report.hasDrift).toBe(false);
    expect(report.driftedGroups).toEqual([]);
    expect(report.perEngine).toEqual([{ engine: "openai", versions: ["v1", "v2"] }]);
  });
});
