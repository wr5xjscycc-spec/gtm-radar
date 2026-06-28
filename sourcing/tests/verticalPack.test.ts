import { describe, it, expect } from "vitest";
import { buildVerticalPack } from "../src/verticalPack";
import type { QueryRecord } from "../src/query";

describe("buildVerticalPack", () => {
  const pack = buildVerticalPack();

  it("returns a non-empty query pack", () => {
    expect(pack.vertical).toBe("GTM analytics");
    expect(pack.total_queries).toBeGreaterThan(0);
    expect(pack.queries.length).toBe(pack.total_queries);
  });

  it("every query has a valid seed_source", () => {
    const validSources: QueryRecord["seed_source"][] = [
      "paa", "keyword", "reddit", "analytics", "llm_expand",
    ];
    for (const q of pack.queries) {
      expect(validSources).toContain(q.seed_source);
    }
  });

  it("computes seed_source_breakdown correctly", () => {
    const expected: Record<string, number> = {};
    for (const q of pack.queries) {
      expected[q.seed_source] = (expected[q.seed_source] || 0) + 1;
    }
    expect(pack.seed_source_breakdown).toEqual(expected);
  });

  it("reports grounded vs llm_expand counts", () => {
    const grounded = pack.queries.filter((q) => q.seed_source !== "llm_expand").length;
    const llmExpand = pack.queries.filter((q) => q.seed_source === "llm_expand").length;
    expect(pack.grounded_query_count).toBe(grounded);
    expect(pack.llm_expand_query_count).toBe(llmExpand);
  });

  it("llm_expand_ratio is < 0.5 (healthy — grounded dominates)", () => {
    expect(pack.llm_expand_ratio).toBeGreaterThan(0);
    expect(pack.llm_expand_ratio).toBeLessThan(0.5);
  });

  it("has at least 3 CMS targets", () => {
    expect(pack.cms_targets.length).toBeGreaterThanOrEqual(3);
    for (const target of pack.cms_targets) {
      expect(target.name).toBeTruthy();
      expect(target.url).toMatch(/^https?:\/\//);
      expect(target.relevance).toBeTruthy();
      expect(target.audience).toBeTruthy();
    }
  });

  it("every query targets openai", () => {
    for (const q of pack.queries) {
      expect(q.target_engines).toContain("openai");
    }
  });

  it("every query has a unique id", () => {
    const ids = pack.queries.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has a valid version string", () => {
    expect(pack.version).toContain("vertical-pack-");
  });

  it("seed_source_breakdown covers all 5 sources", () => {
    const sources = Object.keys(pack.seed_source_breakdown);
    expect(sources).toContain("paa");
    expect(sources).toContain("keyword");
    expect(sources).toContain("reddit");
    expect(sources).toContain("analytics");
    expect(sources).toContain("llm_expand");
  });

  it("reproduces deterministically (same content on every call)", () => {
    const pack2 = buildVerticalPack();
    expect(pack2.total_queries).toBe(pack.total_queries);
    expect(pack2.llm_expand_ratio).toBe(pack.llm_expand_ratio);
    expect(pack2.cms_targets.length).toBe(pack.cms_targets.length);
    for (let i = 0; i < pack.queries.length; i++) {
      expect(pack2.queries[i].text).toBe(pack.queries[i].text);
    }
  });
});
