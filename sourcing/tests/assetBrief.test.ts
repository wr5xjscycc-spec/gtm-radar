// P3 — AI-generated comparison-page brief (mocked LLM). Proves parse + caps +
// defensive-null behavior with NO live vendor call (ChatModel port mocked).
import { describe, it, expect } from "vitest";
import {
  generateAssetBrief,
  buildMeasuredRecommendations,
  type AssetBriefInput,
  type ProvenLift,
} from "../src/assetBrief";
import type { ChatModel } from "../src/understanding";

function mockModel(reply: string): ChatModel {
  return {
    async complete() {
      return reply;
    },
  };
}

const INPUT: AssetBriefInput = {
  ownName: "Convex",
  ownDomain: "convex.dev",
  competitorName: "supabase.com",
  category: "serverless database",
  positioning: "A reactive backend that syncs state across clients.",
};

const GOOD = JSON.stringify({
  headline: "Convex vs Supabase: which serverless database is right for app developers?",
  subhead: "Convex is a reactive backend that syncs state across clients.",
  points: ["Reactive by default", "No backend code", "TypeScript-native"],
  recommendations: [
    { title: "Publish a comparison page", detail: "Create a Convex vs Supabase page." },
    { title: "Lead with a direct answer", detail: "Open the page with one sentence." },
  ],
});

describe("generateAssetBrief", () => {
  it("parses a well-formed brief; LLM recs are tagged as hypotheses", async () => {
    const b = await generateAssetBrief(mockModel(GOOD), INPUT);
    expect(b).not.toBeNull();
    expect(b!.headline).toContain("Convex vs Supabase");
    expect(b!.points).toHaveLength(3);
    expect(b!.recommendations).toEqual([
      { title: "Publish a comparison page", detail: "Create a Convex vs Supabase page.", kind: "hypothesis" },
      { title: "Lead with a direct answer", detail: "Open the page with one sentence.", kind: "hypothesis" },
    ]);
  });

  it("leads with MEASURED recommendations from provenLifts, then LLM hypotheses", async () => {
    const provenLifts: ProvenLift[] = [
      { feature: "comparison_table", engine: "openai", n: 3, mean_lift: 0.14, ci_low: 0.08, ci_high: 0.2 },
    ];
    const b = await generateAssetBrief(mockModel(GOOD), { ...INPUT, provenLifts });
    expect(b!.recommendations[0].kind).toBe("measured");
    expect(b!.recommendations[0].detail).toContain("+14%");
    expect(b!.recommendations[0].detail).toContain("n=3");
    // hypotheses follow, combined list capped at 4
    expect(b!.recommendations.some((r) => r.kind === "hypothesis")).toBe(true);
    expect(b!.recommendations.length).toBeLessThanOrEqual(4);
  });

  it("caps points at 3 and recommendations at 4", async () => {
    const reply = JSON.stringify({
      headline: "H",
      subhead: "S",
      points: ["1", "2", "3", "4", "5"],
      recommendations: Array.from({ length: 6 }, (_, i) => ({
        title: `t${i}`,
        detail: `d${i}`,
      })),
    });
    const b = await generateAssetBrief(mockModel(reply), INPUT);
    expect(b!.points).toHaveLength(3);
    expect(b!.recommendations).toHaveLength(4);
  });

  it("drops malformed recommendation entries", async () => {
    const reply = JSON.stringify({
      headline: "H",
      subhead: "S",
      points: [],
      recommendations: [
        { title: "ok", detail: "yes" },
        { title: "", detail: "missing title" },
        { title: "missing detail" },
        "a string",
        null,
      ],
    });
    const b = await generateAssetBrief(mockModel(reply), INPUT);
    expect(b!.recommendations).toEqual([
      { title: "ok", detail: "yes", kind: "hypothesis" },
    ]);
  });

  it("tolerates a missing recommendations field (-> [])", async () => {
    const reply = JSON.stringify({ headline: "H", subhead: "S", points: ["a"] });
    const b = await generateAssetBrief(mockModel(reply), INPUT);
    expect(b!.recommendations).toEqual([]);
  });

  it("returns null when headline or subhead is missing", async () => {
    expect(
      await generateAssetBrief(
        mockModel(JSON.stringify({ subhead: "s", points: [], recommendations: [] })),
        INPUT,
      ),
    ).toBeNull();
    expect(
      await generateAssetBrief(
        mockModel(JSON.stringify({ headline: "h", points: [], recommendations: [] })),
        INPUT,
      ),
    ).toBeNull();
  });

  it("is defensive: empty / non-JSON / broken all yield null", async () => {
    for (const bad of ["", "no json here", "{broken"]) {
      expect(await generateAssetBrief(mockModel(bad), INPUT)).toBeNull();
    }
  });
});

describe("buildMeasuredRecommendations", () => {
  it("builds measured recs only from DECISIVE positive lifts (CI above zero)", () => {
    const lifts: ProvenLift[] = [
      { feature: "comparison_table", engine: "openai", n: 2, mean_lift: 0.14, ci_low: 0.08, ci_high: 0.2 },
      { feature: "direct_answer_first", engine: "openai", n: 1, mean_lift: 0.05, ci_low: -0.02, ci_high: 0.12 }, // crosses zero -> dropped
    ];
    const recs = buildMeasuredRecommendations(lifts);
    expect(recs).toHaveLength(1);
    expect(recs[0].kind).toBe("measured");
    expect(recs[0].title.toLowerCase()).toContain("comparison page");
    expect(recs[0].detail).toContain("+14%");
    expect(recs[0].detail).toContain("90% CI +8%–+20%");
    expect(recs[0].detail).toContain("n=2 experiments");
    expect(recs[0].evidence).toContain("+14% measured lift");
  });

  it("returns [] when no lift is decisive, and caps at 3", () => {
    expect(buildMeasuredRecommendations([])).toEqual([]);
    const many: ProvenLift[] = Array.from({ length: 5 }, (_, i) => ({
      feature: `f${i}`,
      engine: "openai",
      n: 1,
      mean_lift: 0.1,
      ci_low: 0.05,
      ci_high: 0.15,
    }));
    expect(buildMeasuredRecommendations(many)).toHaveLength(3);
  });
});
