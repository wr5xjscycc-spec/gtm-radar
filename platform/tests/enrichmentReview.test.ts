import { describe, it, expect } from "vitest";
import {
  llmExpandRatio,
  seedSourceBreakdown,
  coverageSummary,
  featureVectorView,
} from "../src/enrichmentReview";

describe("llmExpandRatio — surface (not hide) ungrounded query sets", () => {
  it("flags when llm_expand dominates", () => {
    const r = llmExpandRatio([
      { seed_source: "llm_expand" },
      { seed_source: "llm_expand" },
      { seed_source: "paa" },
    ]);
    expect(r.llm_expand).toBe(2);
    expect(r.ratio).toBeCloseTo(0.667, 2);
    expect(r.tooHigh).toBe(true);
  });

  it("does not flag a well-grounded set", () => {
    const r = llmExpandRatio([
      { seed_source: "paa" },
      { seed_source: "reddit" },
      { seed_source: "llm_expand" },
    ]);
    expect(r.tooHigh).toBe(false);
  });

  it("handles empty", () => {
    expect(llmExpandRatio([]).tooHigh).toBe(false);
  });
});

describe("seedSourceBreakdown", () => {
  it("counts each source", () => {
    const b = seedSourceBreakdown([
      { seed_source: "paa" }, { seed_source: "paa" }, { seed_source: "llm_expand" },
    ]);
    expect(b.paa).toBe(2);
    expect(b.llm_expand).toBe(1);
    expect(b.reddit).toBe(0);
  });
});

describe("coverageSummary — surface thin off-page coverage", () => {
  it("reports present + missing + flags", () => {
    const s = coverageSummary({
      offpage: { thirdparty_mentions: 3, g2_presence: 1 },
      coverage_flags: ["low_offpage_coverage"],
    });
    expect(s.present).toContain("thirdparty_mentions");
    expect(s.missing).toContain("brand_search_volume");
    expect(s.coverage).toBeCloseTo(2 / 8, 5);
    expect(s.flags).toEqual(["low_offpage_coverage"]);
  });

  it("all missing when no offpage", () => {
    const s = coverageSummary({});
    expect(s.present).toEqual([]);
    expect(s.coverage).toBe(0);
  });
});

describe("featureVectorView", () => {
  it("lists each feature field with presence + extractor_version", () => {
    const v = featureVectorView({
      content_features: { word_count: 480, comparison_table: false, schema_markup: null as any },
      extractor_version: "orangeslice-2026.06",
    });
    expect(v.extractor_version).toBe("orangeslice-2026.06");
    const wc = v.fields.find((f) => f.key === "word_count");
    expect(wc?.present).toBe(true);
    const sm = v.fields.find((f) => f.key === "schema_markup");
    expect(sm?.present).toBe(false); // null -> not present
  });

  it("marks unstamped extractor_version", () => {
    expect(featureVectorView({}).extractor_version).toBe("(unstamped)");
  });
});
