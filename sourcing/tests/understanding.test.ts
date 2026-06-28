// P3 · Phase 1 required test: company-understanding output-shape test (mocked LLM).
//
// Proves the cheap gpt-4o-mini "what you are" pass end-to-end inside the lane with
// NO live vendor call — the ChatModel port is mocked (docs/TESTING.md rule 1).

import { describe, it, expect } from "vitest";

import {
  extractUnderstanding,
  applyUnderstanding,
  UNDERSTANDING_MODEL_VERSION,
  type ChatModel,
} from "../src/understanding";
import type { Company } from "../src/types";

/** A well-formed strict-JSON reply, as gpt-4o-mini is instructed to produce. */
const GOOD_JSON = JSON.stringify({
  category: "Project management software",
  icp: "Software teams at startups",
  positioning: "The issue tracker built for high-velocity product teams.",
  whatYouAre: "Issue tracking for engineers\nBuilt for speed\nKeyboard-first UX\nLoved by startups",
});

/** A ChatModel mock that captures the args it was called with and returns `reply`. */
function mockModel(reply: string): { model: ChatModel; calls: { system: string; user: string }[] } {
  const calls: { system: string; user: string }[] = [];
  const model: ChatModel = {
    async complete(args) {
      calls.push(args);
      return reply;
    },
  };
  return { model, calls };
}

const SITE_TEXT = "Linear is a better way to build products. Track issues, plan sprints, ship faster.";

function baseCompany(): Company {
  return {
    domain: "linear.app",
    name: "Linear",
    role: "battlefield",
    coverage_flags: [
      "firmographics_missing",
      "offpage_missing",
      "understanding_missing",
    ],
    source_versions: { battlefield: "fiber/find-similar-companies@v1" },
  };
}

describe("company-understanding output-shape (mocked LLM)", () => {
  it("returns understanding with category/icp/positioning + a 4-line card", async () => {
    const { model } = mockModel(GOOD_JSON);
    const result = await extractUnderstanding(model, {
      domain: "linear.app",
      name: "Linear",
      siteText: SITE_TEXT,
    });

    expect(typeof result.understanding.category).toBe("string");
    expect(typeof result.understanding.icp).toBe("string");
    expect(typeof result.understanding.positioning).toBe("string");
    expect(result.understanding.category!.length).toBeGreaterThan(0);
    expect(result.understanding.icp!.length).toBeGreaterThan(0);
    expect(result.understanding.positioning!.length).toBeGreaterThan(0);

    const lines = result.whatYouAre.split("\n");
    expect(lines).toHaveLength(4);
    for (const line of lines) expect(line.trim().length).toBeGreaterThan(0);
  });

  it("parses JSON wrapped in ```json code fences with leading prose", async () => {
    const wrapped = "Sure! Here is the analysis:\n```json\n" + GOOD_JSON + "\n```\nHope that helps.";
    const { model } = mockModel(wrapped);
    const result = await extractUnderstanding(model, { domain: "linear.app", siteText: SITE_TEXT });

    expect(result.understanding.category).toBe("Project management software");
    expect(result.whatYouAre.split("\n")).toHaveLength(4);
  });

  it("throws on non-JSON garbage (fails loud)", async () => {
    const { model } = mockModel("I'm sorry, I cannot help with that request.");
    await expect(
      extractUnderstanding(model, { domain: "linear.app", siteText: SITE_TEXT }),
    ).rejects.toThrow();
  });

  it("throws when required fields are missing", async () => {
    const { model } = mockModel(JSON.stringify({ category: "X", whatYouAre: "a\nb\nc\nd" }));
    await expect(
      extractUnderstanding(model, { domain: "linear.app", siteText: SITE_TEXT }),
    ).rejects.toThrow();
  });

  it("degrades the card to 4 lines (never discards valid understanding) when the model miscounts", async () => {
    // gpt-4o-mini routinely returns 3 or 5 lines; the cosmetic card must not gate
    // the contract-critical understanding{category,icp,positioning}.
    const { model } = mockModel(
      JSON.stringify({ category: "X", icp: "Y", positioning: "Z", whatYouAre: "one\ntwo" }),
    );
    const result = await extractUnderstanding(model, {
      domain: "linear.app",
      name: "Linear",
      siteText: SITE_TEXT,
    });
    // understanding is preserved...
    expect(result.understanding).toEqual({ category: "X", icp: "Y", positioning: "Z" });
    // ...and the card is topped up to exactly 4 non-empty lines from what we have.
    const lines = result.whatYouAre.split("\n");
    expect(lines).toHaveLength(4);
    for (const line of lines) expect(line.trim().length).toBeGreaterThan(0);
    expect(lines[0]).toBe("one");
    expect(lines[1]).toBe("two");
  });

  it("synthesizes a 4-line card even when whatYouAre is absent", async () => {
    const { model } = mockModel(JSON.stringify({ category: "X", icp: "Y", positioning: "Z" }));
    const result = await extractUnderstanding(model, {
      domain: "linear.app",
      name: "Linear",
      siteText: SITE_TEXT,
    });
    expect(result.understanding).toEqual({ category: "X", icp: "Y", positioning: "Z" });
    expect(result.whatYouAre.split("\n")).toHaveLength(4);
  });

  it("keeps the prompt cheap (small token budget)", async () => {
    const { model, calls } = mockModel(GOOD_JSON);
    // A large scraped site should still produce a tight prompt (we cap site text).
    const hugeSite = "blah ".repeat(5000);
    await extractUnderstanding(model, { domain: "linear.app", name: "Linear", siteText: hugeSite });

    expect(calls).toHaveLength(1);
    const { system, user } = calls[0];
    expect(system.length + user.length).toBeLessThan(2000);
  });
});

describe("applyUnderstanding", () => {
  const result = {
    understanding: {
      category: "Project management software",
      icp: "Software teams",
      positioning: "Issue tracking for high-velocity teams.",
    },
    whatYouAre: "a\nb\nc\nd",
  };

  it("sets understanding, flips the coverage flag, and stamps the version", () => {
    const company = baseCompany();
    const updated = applyUnderstanding(company, result);

    expect(updated.understanding).toEqual(result.understanding);
    expect(updated.coverage_flags).not.toContain("understanding_missing");
    expect(updated.source_versions.understanding).toBe(UNDERSTANDING_MODEL_VERSION);
  });

  it("leaves other coverage flags and source versions untouched", () => {
    const updated = applyUnderstanding(baseCompany(), result);
    expect(updated.coverage_flags).toContain("firmographics_missing");
    expect(updated.coverage_flags).toContain("offpage_missing");
    expect(updated.source_versions.battlefield).toBe("fiber/find-similar-companies@v1");
  });

  it("does NOT mutate the input company (immutability)", () => {
    const company = baseCompany();
    const snapshot = structuredClone(company);
    applyUnderstanding(company, result);
    expect(company).toEqual(snapshot);
  });
});
