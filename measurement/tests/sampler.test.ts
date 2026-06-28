import { describe, it, expect, vi, beforeEach } from "vitest";
import { adaptiveSample, type AdaptiveSampleConfig } from "../src/sampler";
import type { EngineAdapter, EngineResult } from "../src/engine";

const makeAdapter = (
  cited: boolean,
  position: number | null,
  modelVersion: string = "gpt-4o-2024-08-06",
): EngineAdapter => ({
  async measure(): Promise<EngineResult> {
    return {
      engine: "openai",
      appeared: cited,
      cited,
      position,
      source_urls: cited
        ? ["https://acme.com/pricing"]
        : [],
      model_version: modelVersion,
    };
  },
});

describe("adaptiveSample", () => {
  it("stops at baseK=3 when CI is tight (always cited)", async () => {
    const adapter = makeAdapter(true, 0);
    const result = await adaptiveSample(
      "qry_test",
      "best CRM",
      "acme.com",
      "https://acme.com/pricing",
      "openai",
      adapter,
    );

    expect(result.runs.length).toBe(3);
    expect(result.didExtend).toBe(false);
    expect(result.aggregate.P_cited).toBe(1.0);
    expect(result.aggregate.K).toBe(3);
  });

  it("stops at baseK=3 when CI is tight (never cited)", async () => {
    const adapter = makeAdapter(false, null);
    const result = await adaptiveSample(
      "qry_test",
      "best CRM",
      "acme.com",
      "https://acme.com/pricing",
      "openai",
      adapter,
    );

    expect(result.runs.length).toBe(3);
    expect(result.didExtend).toBe(false);
    expect(result.aggregate.P_cited).toBe(0.0);
  });

  it("extends beyond baseK when CI is wide (2/3 straddles midpoint)", async () => {
    // First 3 runs: 2 cited, 1 not → CI may straddle 0.5
    let callCount = 0;
    const alternatingAdapter: EngineAdapter = {
      async measure(): Promise<EngineResult> {
        callCount++;
        const cited = callCount <= 2; // first 2 cited, rest not
        return {
          engine: "openai",
          appeared: cited,
          cited,
          position: cited ? 0 : null,
          source_urls: cited ? ["https://acme.com/pricing"] : [],
          model_version: "gpt-4o-2024-08-06",
        };
      },
    };

    const result = await adaptiveSample(
      "qry_test",
      "best CRM",
      "acme.com",
      "https://acme.com/pricing",
      "openai",
      alternatingAdapter,
    );

    expect(result.didExtend).toBe(true);
    expect(result.runs.length).toBeGreaterThan(3);
    expect(result.runs.length).toBeLessThanOrEqual(8);
  });

  it("respects maxK limit", async () => {
    // Always 1/3 cited → CI stays wide
    let callCount = 0;
    const oneInThreeAdapter: EngineAdapter = {
      async measure(): Promise<EngineResult> {
        callCount++;
        const cited = callCount % 3 === 0; // every 3rd call is cited
        return {
          engine: "openai",
          appeared: cited,
          cited,
          position: cited ? 0 : null,
          source_urls: cited ? ["https://acme.com/pricing"] : [],
          model_version: "gpt-4o-2024-08-06",
        };
      },
    };

    const config: AdaptiveSampleConfig = {
      baseK: 3,
      maxK: 6,
      wideThreshold: 0.3,
    };

    const result = await adaptiveSample(
      "qry_test",
      "best CRM",
      "acme.com",
      "https://acme.com/pricing",
      "openai",
      oneInThreeAdapter,
      config,
    );

    expect(result.didExtend).toBe(true);
    expect(result.runs.length).toBeLessThanOrEqual(6);
  });

  it("assigns incrementing run_idx", async () => {
    const adapter = makeAdapter(true, 0);
    const result = await adaptiveSample(
      "qry_test",
      "best CRM",
      "acme.com",
      "https://acme.com/pricing",
      "openai",
      adapter,
    );

    const indices = result.runs.map((r) => r.run_idx);
    expect(indices).toEqual([0, 1, 2]);
  });

  it("stamps each run with engine and model_version", async () => {
    const adapter = makeAdapter(true, 0, "custom-model-v1");
    const result = await adaptiveSample(
      "qry_test",
      "best CRM",
      "acme.com",
      "https://acme.com/pricing",
      "openai",
      adapter,
    );

    for (const run of result.runs) {
      expect(run.engine).toBe("openai");
      expect(run.model_version).toBe("custom-model-v1");
      expect(typeof run.ts).toBe("number");
    }
  });
});
