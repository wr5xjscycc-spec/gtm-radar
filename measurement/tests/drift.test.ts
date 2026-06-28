import { describe, it, expect } from "vitest";
import { detectDrift, segmentByVersion } from "../src/drift";
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
  ts: 1000,
  window_tag: "adhoc",
  ...overrides,
});

describe("detectDrift", () => {
  it("returns no drift for single version", () => {
    const runs = [
      makeRun({ run_idx: 0, model_version: "v1" }),
      makeRun({ run_idx: 1, model_version: "v1" }),
      makeRun({ run_idx: 2, model_version: "v1" }),
    ];
    const result = detectDrift(runs);
    expect(result.drift_detected).toBe(false);
    expect(result.versions_seen).toEqual(["v1"]);
    expect(result.version_changed_mid_sweep).toBe(false);
  });

  it("detects drift when model version changes", () => {
    const runs = [
      makeRun({ run_idx: 0, model_version: "gpt-4o-2024-08-06", ts: 1000 }),
      makeRun({ run_idx: 1, model_version: "gpt-4o-2024-08-06", ts: 2000 }),
      makeRun({ run_idx: 2, model_version: "gpt-4o-2024-10-01", ts: 3000 }),
    ];
    const result = detectDrift(runs);
    expect(result.drift_detected).toBe(true);
    expect(result.versions_seen).toContain("gpt-4o-2024-08-06");
    expect(result.versions_seen).toContain("gpt-4o-2024-10-01");
    expect(result.version_changed_mid_sweep).toBe(true);
    expect(result.sweep_start_version).toBe("gpt-4o-2024-08-06");
    expect(result.sweep_end_version).toBe("gpt-4o-2024-10-01");
  });

  it("detects drift across multiple version transitions", () => {
    const runs = [
      makeRun({ run_idx: 0, model_version: "v1", ts: 100 }),
      makeRun({ run_idx: 1, model_version: "v2", ts: 200 }),
      makeRun({ run_idx: 2, model_version: "v3", ts: 300 }),
    ];
    const result = detectDrift(runs);
    expect(result.drift_detected).toBe(true);
    expect(result.versions_seen).toHaveLength(3);
    expect(result.sweep_start_version).toBe("v1");
    expect(result.sweep_end_version).toBe("v3");
  });

  it("handles empty runs", () => {
    const result = detectDrift([]);
    expect(result.drift_detected).toBe(false);
    expect(result.versions_seen).toHaveLength(0);
    expect(result.sweep_start_version).toBeNull();
    expect(result.sweep_end_version).toBeNull();
  });

  it("handles single run", () => {
    const result = detectDrift([makeRun({ model_version: "v1" })]);
    expect(result.drift_detected).toBe(false);
    expect(result.versions_seen).toEqual(["v1"]);
  });
});

describe("segmentByVersion", () => {
  it("returns single segment for uniform version", () => {
    const runs = [
      makeRun({ run_idx: 0, model_version: "v1", ts: 100 }),
      makeRun({ run_idx: 1, model_version: "v1", ts: 200 }),
    ];
    const segments = segmentByVersion(runs);
    expect(segments).toHaveLength(1);
    expect(segments[0].version).toBe("v1");
    expect(segments[0].runs).toHaveLength(2);
  });

  it("splits segments at version boundaries", () => {
    const runs = [
      makeRun({ run_idx: 0, model_version: "v1", ts: 100 }),
      makeRun({ run_idx: 1, model_version: "v1", ts: 200 }),
      makeRun({ run_idx: 2, model_version: "v2", ts: 300 }),
      makeRun({ run_idx: 3, model_version: "v2", ts: 400 }),
    ];
    const segments = segmentByVersion(runs);
    expect(segments).toHaveLength(2);
    expect(segments[0].version).toBe("v1");
    expect(segments[0].runs).toHaveLength(2);
    expect(segments[1].version).toBe("v2");
    expect(segments[1].runs).toHaveLength(2);
  });

  it("handles empty input", () => {
    expect(segmentByVersion([])).toHaveLength(0);
  });
});
