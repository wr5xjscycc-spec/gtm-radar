import { describe, it, expect } from "vitest";
import { buildLabelTables, type LabelTableRow } from "../src/labelTable";
import type { AggregateResult } from "../src/aggregate";

const makeAgg = (
  overrides: Partial<AggregateResult> = {},
): AggregateResult => ({
  query_id: "qry_test",
  page_url: "https://acme.com/pricing",
  company_domain: "acme.com",
  engine: "openai",
  model_version: "gpt-4o-2024-08-06",
  K: 3,
  P_cited: 0.667,
  ci_low: 0.208,
  ci_high: 0.939,
  position_weight: 0.5,
  runs: [],
  ...overrides,
});

describe("buildLabelTables", () => {
  it("produces rows with normalized keys", () => {
    const result = buildLabelTables([makeAgg()]);
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.page_url).toBe("https://acme.com/pricing");
    expect(row.company_domain).toBe("acme.com");
    expect(row.engine).toBe("openai");
    expect(row.K).toBe(3);
    expect(row.P_cited).toBeCloseTo(0.667, 3);
    expect(row.ci_low).toBeDefined();
    expect(row.ci_high).toBeDefined();
  });

  it("labels P_cited > 0 as winner (was cited at least once)", () => {
    const result = buildLabelTables([makeAgg({ P_cited: 0.8 })]);
    expect(result.rows[0].label).toBe("winner");
  });

  it("labels P_cited > 0 even when below 0.5 (any citation = winner)", () => {
    const result = buildLabelTables([makeAgg({ P_cited: 0.2 })]);
    expect(result.rows[0].label).toBe("winner");
  });

  it("labels P_cited === 0 as loser (never cited)", () => {
    const result = buildLabelTables([makeAgg({ P_cited: 0.0 })]);
    expect(result.rows[0].label).toBe("loser");
  });

  it("never pools engines — each engine is separate", () => {
    const aggs = [
      makeAgg({ engine: "openai", P_cited: 0.9 }),
      makeAgg({ engine: "perplexity", P_cited: 0.0 }),
    ];
    const result = buildLabelTables(aggs);
    expect(result.rows).toHaveLength(2);
    const openaiRow = result.rows.find((r) => r.engine === "openai")!;
    const perplexityRow = result.rows.find((r) => r.engine === "perplexity")!;
    expect(openaiRow.label).toBe("winner");
    expect(perplexityRow.label).toBe("loser");
  });

  it("normalizes URL keys (strips www, tracks params)", () => {
    const agg = makeAgg({
      page_url: "https://www.Acme.com/pricing?utm_source=twitter&ref=x",
    });
    const result = buildLabelTables([agg]);
    expect(result.rows[0].page_url).toBe("https://acme.com/pricing?ref=x");
  });

  it("normalizes domain keys", () => {
    const agg = makeAgg({
      company_domain: "www.ACME.com",
      page_url: "https://www.ACME.com/pricing",
    });
    const result = buildLabelTables([agg]);
    expect(result.rows[0].company_domain).toBe("acme.com");
  });

  it("reports which engines are present", () => {
    const aggs = [
      makeAgg({ engine: "openai" }),
      makeAgg({ engine: "gemini" }),
    ];
    const result = buildLabelTables(aggs);
    expect(result.engines.sort()).toEqual(["gemini", "openai"]);
  });

  it("handles empty input", () => {
    const result = buildLabelTables([]);
    expect(result.rows).toHaveLength(0);
    expect(result.engines).toHaveLength(0);
  });

  it("handles three engines simultaneously", () => {
    const aggs = [
      makeAgg({ engine: "openai", P_cited: 1.0 }),
      makeAgg({ engine: "perplexity", P_cited: 0.0 }),
      makeAgg({ engine: "gemini", P_cited: 0.667 }),
    ];
    const result = buildLabelTables(aggs);
    expect(result.rows).toHaveLength(3);
    expect(result.engines.sort()).toEqual(["gemini", "openai", "perplexity"]);
  });
});
