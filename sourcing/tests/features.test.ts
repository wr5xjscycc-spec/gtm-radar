// P3 · Phase 2: subjective feature extraction validation (mocked LLM).
// The subjective vector is the GEO-paper lever — a partially-bad model reply must
// drop the WHOLE subjective vector (fail loud), never partial-merge a hollow one.
// All vendor calls are mocked; no network in CI.

import { describe, it, expect } from "vitest";

import { extractSubjectiveFeatures, CONTENT_EXTRACTOR_VERSION } from "../src/features";
import type { ChatModel } from "../src/understanding";

function mockModel(reply: string): { model: ChatModel; calls: { system: string; user: string }[] } {
  const calls: { system: string; user: string }[] = [];
  return {
    calls,
    model: {
      async complete(args) {
        calls.push(args);
        return reply;
      },
    },
  };
}

const GOOD = {
  direct_answer_first: true,
  stats_density: 3.2,
  citation_density: 1,
  quote_density: 0,
  listicle_vs_prose: "prose",
};

const input = { url: "https://linear.app/features", text: "Some page text about issue tracking." };

describe("extractSubjectiveFeatures — happy path", () => {
  it("parses a well-formed strict-JSON reply into the typed vector", async () => {
    const { model } = mockModel(JSON.stringify(GOOD));
    const out = await extractSubjectiveFeatures(model, input);
    expect(out).toEqual({
      direct_answer_first: true,
      stats_density: 3.2,
      citation_density: 1,
      quote_density: 0,
      listicle_vs_prose: "prose",
    });
  });

  it("tolerates code fences / leading prose and accepts numeric strings", async () => {
    const wrapped =
      "Here you go:\n```json\n" +
      JSON.stringify({ ...GOOD, stats_density: "4.5" }) +
      "\n```";
    const { model } = mockModel(wrapped);
    const out = await extractSubjectiveFeatures(model, input);
    expect(out.stats_density).toBe(4.5);
  });

  it("keeps the prompt cheap even for a huge page (text is capped)", async () => {
    const { model, calls } = mockModel(JSON.stringify(GOOD));
    await extractSubjectiveFeatures(model, { url: input.url, text: "word ".repeat(20000) });
    expect(calls).toHaveLength(1);
    // Text is capped (~4000 chars) + a small system/labels overhead — proves the
    // prompt stays bounded no matter how large the scraped page is.
    expect(calls[0].system.length + calls[0].user.length).toBeLessThan(5000);
  });
});

describe("extractSubjectiveFeatures — fail loud on bad output (one bad field drops the WHOLE vector)", () => {
  const cases: Array<[string, Record<string, unknown> | string]> = [
    ["non-JSON garbage", "I'm sorry, I can't help with that."],
    ["empty reply", ""],
    ["wrong-typed direct_answer_first", { ...GOOD, direct_answer_first: "yes" }],
    ["missing direct_answer_first", { stats_density: 1, citation_density: 1, quote_density: 1, listicle_vs_prose: "prose" }],
    ["non-finite stats_density", { ...GOOD, stats_density: "abc" }],
    ["invalid listicle_vs_prose enum", { ...GOOD, listicle_vs_prose: "essay" }],
    ["missing listicle_vs_prose", { direct_answer_first: true, stats_density: 1, citation_density: 1, quote_density: 1 }],
  ];

  for (const [name, payload] of cases) {
    it(`throws on ${name}`, async () => {
      const reply = typeof payload === "string" ? payload : JSON.stringify(payload);
      const { model } = mockModel(reply);
      await expect(extractSubjectiveFeatures(model, input)).rejects.toThrow();
    });
  }
});

describe("CONTENT_EXTRACTOR_VERSION", () => {
  it("is a stable, versioned tag", () => {
    expect(CONTENT_EXTRACTOR_VERSION).toBe("content-features@v1");
  });
});
