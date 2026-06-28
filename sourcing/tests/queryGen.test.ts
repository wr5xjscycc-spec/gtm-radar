// P2/P3 — LLM buyer-query generation (mocked LLM). Parse + clean + dedup + cap,
// defensive on bad output, with NO live vendor call (ChatModel port mocked).
import { describe, it, expect } from "vitest";
import { generateBuyerQueries, type QueryGenInput } from "../src/queryGen";
import type { ChatModel } from "../src/understanding";

function mockModel(reply: string): ChatModel {
  return {
    async complete() {
      return reply;
    },
  };
}

const INPUT: QueryGenInput = {
  ownName: "Apple",
  category: "consumer electronics & software",
  icp: "consumers worldwide",
  competitorName: "samsung.com",
  n: 4,
};

describe("generateBuyerQueries", () => {
  it("parses, lowercases, and de-dupes queries", async () => {
    const reply = JSON.stringify({
      queries: ["Best smartphone 2026", "best smartphone 2026", "iPhone vs Samsung Galaxy"],
    });
    const r = await generateBuyerQueries(mockModel(reply), INPUT);
    expect(r).toEqual(["best smartphone 2026", "iphone vs samsung galaxy"]);
  });

  it("strips leading numbering / quotes", async () => {
    const reply = JSON.stringify({
      queries: ['1. "best laptop for students"', "2) best wireless earbuds"],
    });
    const r = await generateBuyerQueries(mockModel(reply), INPUT);
    expect(r).toEqual(["best laptop for students", "best wireless earbuds"]);
  });

  it("caps at n", async () => {
    const many = Array.from({ length: 10 }, (_, i) => `question number ${i}`);
    const r = await generateBuyerQueries(mockModel(JSON.stringify({ queries: many })), INPUT);
    expect(r).toHaveLength(4);
  });

  it("drops too-short / non-string entries", async () => {
    const reply = JSON.stringify({ queries: ["ok query here", "no", 42, null, "another good one"] });
    const r = await generateBuyerQueries(mockModel(reply), INPUT);
    expect(r).toEqual(["ok query here", "another good one"]);
  });

  it("extracts from a chatty / fenced reply", async () => {
    const reply = "Sure:\n```json\n" + JSON.stringify({ queries: ["best ai data marketplace"] }) + "\n```";
    const r = await generateBuyerQueries(mockModel(reply), INPUT);
    expect(r).toEqual(["best ai data marketplace"]);
  });

  it("is defensive: empty / non-JSON / wrong shape -> []", async () => {
    for (const bad of ["", "no json", "{broken", JSON.stringify({ foo: 1 })]) {
      expect(await generateBuyerQueries(mockModel(bad), INPUT)).toEqual([]);
    }
  });
});
