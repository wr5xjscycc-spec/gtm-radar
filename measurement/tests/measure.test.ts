import { describe, it, expect } from "vitest";
import { measureQuery } from "../src/measure";
import type { EngineAdapter, EngineResult } from "../src/engine";

const makeAdapter = (
  cited: boolean,
  position: number | null,
): EngineAdapter => ({
  async measure(): Promise<EngineResult> {
    return {
      engine: "openai",
      appeared: cited,
      cited,
      position,
      source_urls: cited ? ["https://acme.com/pricing"] : [],
      model_version: "gpt-4o-2024-08-06",
    };
  },
});

describe("measureQuery", () => {
  it("produces aggregate with P_cited, CI, position_weight, runs", async () => {
    const result = await measureQuery({
      queryId: "qry_test",
      queryText: "best CRM for startups",
      targetDomain: "acme.com",
      pageUrl: "https://acme.com/pricing",
      engine: "openai",
      adapter: makeAdapter(true, 0),
    });

    expect(result.aggregate.K).toBe(3);
    expect(result.aggregate.P_cited).toBe(1.0);
    expect(result.aggregate.engine).toBe("openai");
    expect(result.aggregate.ci_low).toBeDefined();
    expect(result.aggregate.ci_high).toBeDefined();
    expect(result.aggregate.position_weight).toBe(1.0);
    expect(result.runs).toHaveLength(3);
    expect(result.didExtend).toBe(false);
  });

  it("exposes K and extension info", async () => {
    let callCount = 0;
    const alternatingAdapter: EngineAdapter = {
      async measure(): Promise<EngineResult> {
        callCount++;
        const cited = callCount <= 2;
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

    const result = await measureQuery({
      queryId: "qry_test",
      queryText: "best CRM",
      targetDomain: "acme.com",
      pageUrl: "https://acme.com/pricing",
      engine: "openai",
      adapter: alternatingAdapter,
    });

    expect(result.K).toBeGreaterThan(3);
    expect(result.didExtend).toBe(true);
  });
});
