// P3 · Phase 2 required test: query-gen seed-source tagging + healthy-ratio guard.
//
// Proves grounded query generation end-to-end inside the lane with NO live vendor
// call — the SerpSeedClient / RedditSeedClient / ChatModel ports are all mocked
// (docs/TESTING.md rule 1). Asserts: correct seed_source tagging per source, the
// real-seeds-win dedupe precedence, deterministic ids, and that llm_expand is capped
// so the real-seeded ratio holds its floor (red-team Theme E).

import { describe, it, expect } from "vitest";

import {
  generateQueries,
  seedSourceRatio,
  queryId,
  QUERY_PACK_VERSION,
  type GenerateQueriesArgs,
  type SerpSeedClient,
  type RedditSeedClient,
} from "../src/queries";
import type { ChatModel } from "../src/understanding";
import type { Engine, Query } from "../src/types";

const ENGINES: Engine[] = ["openai", "perplexity", "gemini"];

/** A SERP mock returning recorded paa + keyword query lists. */
function mockSerp(paa: string[], keyword: string[]): SerpSeedClient {
  return {
    async peopleAlsoAsk() {
      return paa;
    },
    async keywordQueries() {
      return keyword;
    },
  };
}

/** A Reddit mock returning recorded mined questions. */
function mockReddit(questions: string[]): RedditSeedClient {
  return {
    async mineQuestions() {
      return questions;
    },
  };
}

/** A ChatModel mock that returns a JSON array of expansion queries and counts calls. */
function mockModel(expanded: string[]): { model: ChatModel; state: { calls: number } } {
  const state = { calls: 0 };
  const model: ChatModel = {
    async complete() {
      state.calls += 1;
      return JSON.stringify(expanded);
    },
  };
  return { model, state };
}

function baseArgs(overrides: Partial<GenerateQueriesArgs> = {}): GenerateQueriesArgs {
  return {
    customerId: "cust-1",
    vertical: "project-management",
    seedTerms: ["issue tracking", "sprint planning"],
    targetEngines: ENGINES,
    serp: mockSerp([], []),
    reddit: mockReddit([]),
    model: mockModel([]).model,
    ...overrides,
  };
}

function bySource(queries: Query[], source: string): Query[] {
  return queries.filter((q) => q.seed_source === source);
}

describe("queryId — deterministic & variant-folding", () => {
  it("is reproducible across runs (no Date.now / Math.random)", () => {
    expect(queryId("best issue tracker")).toBe(queryId("best issue tracker"));
  });

  it("folds case + whitespace variants of the same text to one id", () => {
    const a = queryId("Best Issue Tracker");
    const b = queryId("  best   issue tracker  ");
    const c = queryId("best issue tracker");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("gives distinct ids to genuinely different text", () => {
    expect(queryId("best issue tracker")).not.toBe(queryId("best sprint tool"));
  });
});

describe("generateQueries — seed-source tagging", () => {
  it("tags each real source with the correct seed_source and llm_expand for expansion", async () => {
    const serp = mockSerp(["what is an issue tracker?"], ["best issue tracker"]);
    const reddit = mockReddit(["which issue tracker do you use?"]);
    const { model } = mockModel(["issue tracker for startups", "agile issue tracker"]);

    const queries = await generateQueries(
      baseArgs({
        serp,
        reddit,
        model,
        analyticsQueries: ["jira alternative"],
        minRealSeededRatio: 0, // disable cap so all sources are visible
      }),
    );

    expect(bySource(queries, "paa").map((q) => q.text)).toEqual(["what is an issue tracker?"]);
    expect(bySource(queries, "keyword").map((q) => q.text)).toEqual(["best issue tracker"]);
    expect(bySource(queries, "reddit").map((q) => q.text)).toEqual([
      "which issue tracker do you use?",
    ]);
    expect(bySource(queries, "analytics").map((q) => q.text)).toEqual(["jira alternative"]);
    expect(bySource(queries, "llm_expand").map((q) => q.text).sort()).toEqual(
      ["agile issue tracker", "issue tracker for startups"].sort(),
    );
  });

  it("stamps id, customer_id, vertical, and target_engines on every record", async () => {
    const serp = mockSerp(["what is an issue tracker?"], []);
    const queries = await generateQueries(baseArgs({ serp, minRealSeededRatio: 0 }));
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) {
      expect(q.id).toBe(queryId(q.text));
      expect(q.customer_id).toBe("cust-1");
      expect(q.vertical).toBe("project-management");
      expect(q.target_engines).toEqual(ENGINES);
    }
  });

  it("does not call the model when there are no real seeds (no invented queries)", async () => {
    const m = mockModel(["should not appear"]);
    const queries = await generateQueries(baseArgs({ model: m.model }));
    expect(queries).toEqual([]);
    expect(m.state.calls).toBe(0);
  });
});

describe("generateQueries — dedupe precedence (real seeds win)", () => {
  it("keeps the REAL seed_source when a text appears in both a real seed and llm_expand", async () => {
    // "best issue tracker" comes from keyword AND is echoed (case/space variant) by the model.
    const serp = mockSerp([], ["best issue tracker"]);
    const { model } = mockModel(["Best Issue Tracker", "new agile workflow tips"]);

    const queries = await generateQueries(
      baseArgs({ serp, model, minRealSeededRatio: 0 }),
    );

    const match = queries.filter((q) => queryId(q.text) === queryId("best issue tracker"));
    expect(match).toHaveLength(1); // deduped to a single record
    expect(match[0].seed_source).toBe("keyword");
    expect(match[0].seed_source).not.toBe("llm_expand");

    // the genuinely-new expansion still survives, tagged llm_expand
    expect(bySource(queries, "llm_expand").map((q) => q.text)).toEqual(["new agile workflow tips"]);
  });

  it("dedupes real-vs-real by source order (paa before keyword)", async () => {
    const serp = mockSerp(["shared query"], ["shared query"]);
    const queries = await generateQueries(baseArgs({ serp, minRealSeededRatio: 0 }));
    const match = queries.filter((q) => queryId(q.text) === queryId("shared query"));
    expect(match).toHaveLength(1);
    expect(match[0].seed_source).toBe("paa");
  });
});

describe("generateQueries — HEALTHY ratio guard", () => {
  it("caps llm_expand so realRatio holds the floor under an expansion flood", async () => {
    // 2 real seeds, a flood of 50 unique llm_expand candidates, floor 0.4.
    const serp = mockSerp(["paa one"], ["keyword one"]);
    const flood = Array.from({ length: 50 }, (_, i) => `expanded query number ${i}`);
    const { model } = mockModel(flood);

    const floor = 0.4;
    const queries = await generateQueries(
      baseArgs({ serp, model, minRealSeededRatio: floor }),
    );

    const ratio = seedSourceRatio(queries);
    expect(ratio.real).toBe(2);
    expect(ratio.realRatio).toBeGreaterThanOrEqual(floor);
    // floor 0.4 with 2 real => keptLlm <= 2*(0.6)/0.4 = 3
    expect(ratio.llm_expand).toBe(3);
    expect(ratio.total).toBe(5);
  });

  it("keeps all expansion when the floor is comfortably satisfied", async () => {
    const serp = mockSerp(["paa a", "paa b", "paa c"], ["kw a", "kw b", "kw c"]);
    const { model } = mockModel(["x1", "x2"]); // only 2 expansions, plenty of real seeds
    const queries = await generateQueries(baseArgs({ serp, model, minRealSeededRatio: 0.4 }));
    const ratio = seedSourceRatio(queries);
    expect(ratio.llm_expand).toBe(2);
    expect(ratio.real).toBe(6);
    expect(ratio.realRatio).toBeGreaterThanOrEqual(0.4);
  });

  it("drops all llm_expand when there are zero real seeds (never fabricates real)", async () => {
    const { model } = mockModel(["a", "b", "c"]);
    // analytics is the only real source and it's empty; floor > 0 forces 0 llm kept,
    // but model isn't even called with no seeds — either way no llm_expand survives.
    const queries = await generateQueries(baseArgs({ model, minRealSeededRatio: 0.5 }));
    expect(bySource(queries, "llm_expand")).toHaveLength(0);
  });
});

describe("seedSourceRatio", () => {
  it("counts every non-llm_expand source as real", () => {
    const queries: Query[] = [
      { id: "1", customer_id: "c", vertical: "v", text: "a", seed_source: "paa", target_engines: [] },
      { id: "2", customer_id: "c", vertical: "v", text: "b", seed_source: "keyword", target_engines: [] },
      { id: "3", customer_id: "c", vertical: "v", text: "c", seed_source: "reddit", target_engines: [] },
      { id: "4", customer_id: "c", vertical: "v", text: "d", seed_source: "analytics", target_engines: [] },
      { id: "5", customer_id: "c", vertical: "v", text: "e", seed_source: "llm_expand", target_engines: [] },
    ];
    const ratio = seedSourceRatio(queries);
    expect(ratio).toEqual({ total: 5, real: 4, llm_expand: 1, realRatio: 0.8 });
  });

  it("returns realRatio 0 for an empty set", () => {
    expect(seedSourceRatio([])).toEqual({ total: 0, real: 0, llm_expand: 0, realRatio: 0 });
  });
});

describe("query pack metadata", () => {
  it("exposes a stable pack version", () => {
    expect(QUERY_PACK_VERSION).toBe("query-pack@v1");
  });
});
