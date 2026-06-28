// P3 · Phase 3: subjective-feature agreement-check + extractor-versioning tests.
//
// These prove the HONESTY story: subjective (gpt-4o-mini-extracted) features carry a
// MEASURED agreement number (measurement-error disclosure), reported even when
// mediocre, and the extractor that produced them is versioned/stamped. All vendor
// calls are mocked; no network in CI.

import { describe, it, expect } from "vitest";

import {
  computeAgreement,
  evaluateExtractor,
  DEFAULT_TOLERANCE,
  type LabeledItem,
} from "../src/agreement";
import { CONTENT_EXTRACTOR_VERSION } from "../src/features";
import type { ChatModel } from "../src/understanding";
import type { SubjectiveContentFeatures } from "../src/types";

const ALL_FEATURES = [
  "direct_answer_first",
  "stats_density",
  "citation_density",
  "quote_density",
  "listicle_vs_prose",
] as const;

function feat(over: Partial<SubjectiveContentFeatures> = {}): SubjectiveContentFeatures {
  return {
    direct_answer_first: true,
    stats_density: 3,
    citation_density: 1,
    quote_density: 0,
    listicle_vs_prose: "prose",
    ...over,
  };
}

/** A mock ChatModel that returns the given replies in order (last reply repeats). */
function mockModel(replies: string[]): { model: ChatModel } {
  let i = 0;
  const model: ChatModel = {
    async complete() {
      const r = replies[Math.min(i, replies.length - 1)];
      i++;
      return r;
    },
  };
  return { model };
}

describe("computeAgreement — perfect agreement", () => {
  it("every feature scores 1 when predicted == gold across items", () => {
    const items: LabeledItem[] = [
      { predicted: feat(), gold: feat() },
      { predicted: feat({ direct_answer_first: false, listicle_vs_prose: "listicle" }), gold: feat({ direct_answer_first: false, listicle_vs_prose: "listicle" }) },
      { predicted: feat({ stats_density: 9, listicle_vs_prose: "mixed" }), gold: feat({ stats_density: 9, listicle_vs_prose: "mixed" }) },
    ];
    const report = computeAgreement(items);
    expect(report.n).toBe(3);
    expect(report.features.map((f) => f.feature).sort()).toEqual([...ALL_FEATURES].sort());
    for (const f of report.features) {
      expect(f.agreement).toBe(1);
      expect(f.n).toBe(3);
    }
    // Categoricals use κ; numerics use within_tolerance.
    expect(report.features.find((f) => f.feature === "direct_answer_first")!.method).toBe("cohens_kappa");
    expect(report.features.find((f) => f.feature === "listicle_vs_prose")!.method).toBe("cohens_kappa");
    expect(report.features.find((f) => f.feature === "stats_density")!.method).toBe("within_tolerance");
  });
});

describe("computeAgreement — partial/zero agreement is REPORTED, not hidden", () => {
  it("returns all 5 features even when some score below 1", () => {
    // Disagree on a numeric feature (quote_density off by 5 > tolerance) and a
    // categorical (listicle flipped on some items) — but keep others perfect.
    const items: LabeledItem[] = [
      { predicted: feat({ quote_density: 0, listicle_vs_prose: "prose" }), gold: feat({ quote_density: 5, listicle_vs_prose: "listicle" }) },
      { predicted: feat({ quote_density: 0, listicle_vs_prose: "listicle" }), gold: feat({ quote_density: 6, listicle_vs_prose: "prose" }) },
      { predicted: feat({ quote_density: 0 }), gold: feat({ quote_density: 7 }) },
    ];
    const report = computeAgreement(items);
    // Never drops a feature for scoring low.
    expect(report.features).toHaveLength(5);
    expect(report.features.map((f) => f.feature).sort()).toEqual([...ALL_FEATURES].sort());

    const quote = report.features.find((f) => f.feature === "quote_density")!;
    expect(quote.method).toBe("within_tolerance");
    expect(quote.agreement).toBe(0); // all 3 items exceed tolerance

    const listicle = report.features.find((f) => f.feature === "listicle_vs_prose")!;
    // A mediocre/low κ comes back as a number, not hidden.
    expect(typeof listicle.agreement).toBe("number");
    expect(listicle.agreement).toBeLessThan(1);
  });
});

describe("computeAgreement — Cohen's κ correctness", () => {
  it("recovers the classic κ = 0.4 from a known 2x2 confusion", () => {
    // Confusion: predYes/goldYes=20, predYes/goldNo=5, predNo/goldYes=10, predNo/goldNo=15
    // po=0.7, pe=0.5 ⇒ κ=(0.7-0.5)/(1-0.5)=0.4
    const items: LabeledItem[] = [];
    const push = (p: boolean, g: boolean, k: number) => {
      for (let i = 0; i < k; i++) {
        items.push({ predicted: feat({ direct_answer_first: p }), gold: feat({ direct_answer_first: g }) });
      }
    };
    push(true, true, 20);
    push(true, false, 5);
    push(false, true, 10);
    push(false, false, 15);

    const report = computeAgreement(items);
    const daf = report.features.find((f) => f.feature === "direct_answer_first")!;
    expect(daf.method).toBe("cohens_kappa");
    expect(daf.agreement).toBeCloseTo(0.4, 10);
    expect(daf.n).toBe(50);
  });

  it("κ can be negative (below-chance) and is reported as-is, clamped to [-1,1]", () => {
    // Systematic flip: every prediction is the opposite of gold, with a balanced
    // gold split ⇒ κ < 0.
    const items: LabeledItem[] = [];
    for (let i = 0; i < 10; i++) items.push({ predicted: feat({ direct_answer_first: false }), gold: feat({ direct_answer_first: true }) });
    for (let i = 0; i < 10; i++) items.push({ predicted: feat({ direct_answer_first: true }), gold: feat({ direct_answer_first: false }) });
    const report = computeAgreement(items);
    const daf = report.features.find((f) => f.feature === "direct_answer_first")!;
    expect(daf.agreement).toBeLessThan(0);
    expect(daf.agreement).toBeGreaterThanOrEqual(-1);
  });

  it("constant-rater fallback: pe==1 returns raw agreement, no divide-by-zero", () => {
    // Both raters assign every item to the SAME single category (all true) ⇒ pe=1 ⇒
    // κ undefined ⇒ fall back to exact raw agreement (1.0 here), method "exact".
    const items: LabeledItem[] = [];
    for (let i = 0; i < 5; i++) items.push({ predicted: feat({ direct_answer_first: true }), gold: feat({ direct_answer_first: true }) });
    const report = computeAgreement(items);
    const daf = report.features.find((f) => f.feature === "direct_answer_first")!;
    expect(daf.method).toBe("exact");
    expect(daf.agreement).toBe(1);
    expect(Number.isNaN(daf.agreement)).toBe(false);
  });
});

describe("computeAgreement — within_tolerance boundary", () => {
  it("passes EXACTLY at the tolerance boundary (inclusive) and fails just past it", () => {
    // Default tolerance is 1.0. Diff exactly 1.0 → agree; diff 1.0001 → disagree.
    const atBoundary: LabeledItem[] = [
      { predicted: feat({ stats_density: 3 }), gold: feat({ stats_density: 4 }) }, // diff = 1.0
    ];
    expect(computeAgreement(atBoundary).features.find((f) => f.feature === "stats_density")!.agreement).toBe(1);

    const pastBoundary: LabeledItem[] = [
      { predicted: feat({ stats_density: 3 }), gold: feat({ stats_density: 4.0001 }) }, // diff > 1.0
    ];
    expect(computeAgreement(pastBoundary).features.find((f) => f.feature === "stats_density")!.agreement).toBe(0);

    // Honors a custom tolerance.
    const custom = computeAgreement(pastBoundary, { tolerance: 2 });
    expect(custom.features.find((f) => f.feature === "stats_density")!.agreement).toBe(1);
    expect(DEFAULT_TOLERANCE).toBe(1.0);
  });
});

describe("extractor-versioning", () => {
  it("stamps the default CONTENT_EXTRACTOR_VERSION", () => {
    const report = computeAgreement([{ predicted: feat(), gold: feat() }]);
    expect(report.extractor_version).toBe(CONTENT_EXTRACTOR_VERSION);
  });

  it("honors an override so a mid-run extractor change is detectable", () => {
    const report = computeAgreement([{ predicted: feat(), gold: feat() }], { extractorVersion: "content-features@v2" });
    expect(report.extractor_version).toBe("content-features@v2");
    expect(report.extractor_version).not.toBe(CONTENT_EXTRACTOR_VERSION);
  });
});

describe("computeAgreement — n=0 graceful", () => {
  it("does not crash; reports every feature with agreement 0 and n 0", () => {
    const report = computeAgreement([]);
    expect(report.n).toBe(0);
    expect(report.features).toHaveLength(5);
    for (const f of report.features) {
      expect(f.agreement).toBe(0);
      expect(f.n).toBe(0);
      expect(Number.isNaN(f.agreement)).toBe(false);
    }
  });
});

describe("evaluateExtractor — runs the real extractor over a labeled subset", () => {
  it("perfect predictions → agreement 1 across features", async () => {
    const gold = feat({ direct_answer_first: true, stats_density: 2, citation_density: 1, quote_density: 0, listicle_vs_prose: "prose" });
    const reply = JSON.stringify(gold);
    const { model } = mockModel([reply, reply]);
    const report = await evaluateExtractor(model, [
      { url: "https://a.com", text: "page a", gold },
      { url: "https://b.com", text: "page b", gold },
    ]);
    expect(report.n).toBe(2);
    for (const f of report.features) expect(f.agreement).toBe(1);
    expect(report.extractor_version).toBe(CONTENT_EXTRACTOR_VERSION);
  });

  it("excludes an item whose extraction THROWS and drops n accordingly", async () => {
    const gold = feat();
    const good = JSON.stringify(gold);
    const bad = "I'm sorry, I can't help with that."; // extractSubjectiveFeatures fails loud
    const { model } = mockModel([good, bad, good]);
    const report = await evaluateExtractor(model, [
      { url: "https://a.com", text: "a", gold },
      { url: "https://b.com", text: "b", gold }, // this one throws → excluded
      { url: "https://c.com", text: "c", gold },
    ]);
    // 3 labeled, 1 failed → n = 2 (honest denominator, not padded).
    expect(report.n).toBe(2);
    for (const f of report.features) {
      expect(f.n).toBe(2);
      expect(f.agreement).toBe(1);
    }
    // attrition is surfaced explicitly, not just inferable from a low n.
    expect(report.attempted).toBe(3);
    expect(report.skipped).toBe(1);
  });
});
