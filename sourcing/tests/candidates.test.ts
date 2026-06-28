// P3 · Phase 3 required test: candidate-pool construction tests (classic-search-ranked set).
//
// Proves the case-control loser pool is built end-to-end inside the lane with NO live
// vendor call — the SerpRankingClient port is mocked (docs/TESTING.md rule 1). Asserts
// the SERP→CandidatePoolEntry mapping, rank fallback, url normalization into the join
// key, within-query dedupe (best rank wins, no cross-query dedupe), the top-N cap, the
// empty-results case, and the poolForQuery filter/sort.

import { describe, it, expect } from "vitest";

import {
  buildCandidatePool,
  poolForQuery,
  CANDIDATE_POOL_VERSION,
  DEFAULT_PER_QUERY_LIMIT,
  type SerpRankingClient,
  type SerpOrganicResult,
} from "../src/candidates";
import { normalizeUrl } from "../src/content";
import type { Engine, Query } from "../src/types";

const ENGINES: Engine[] = ["openai", "perplexity", "gemini"];

/** Build a small inline Query record. */
function query(id: string, text: string, vertical = "project-management"): Query {
  return {
    id,
    customer_id: "cust-1",
    vertical,
    text,
    seed_source: "keyword",
    target_engines: ENGINES,
  };
}

/**
 * A SERP ranking mock. `byQuery` maps query TEXT → the organic results to return; it
 * also records the calls so we can assert query/vertical/limit forwarding. Never hits
 * the network.
 */
function mockSerp(byQuery: Record<string, SerpOrganicResult[]>): {
  client: SerpRankingClient;
  calls: { query: string; vertical?: string; limit?: number }[];
} {
  const calls: { query: string; vertical?: string; limit?: number }[] = [];
  const client: SerpRankingClient = {
    async classicSearch(args) {
      calls.push(args);
      return byQuery[args.query] ?? [];
    },
  };
  return { client, calls };
}

describe("candidate-pool construction (mocked SERP)", () => {
  it("maps SERP organic results to CandidatePoolEntry (query_id, normalized url, rank, source)", async () => {
    const { client, calls } = mockSerp({
      "best issue tracker": [
        { url: "https://www.Asana.com/issues/", rank: 1 },
        { url: "https://linear.app/features", rank: 2 },
      ],
    });
    const pool = await buildCandidatePool(client, [query("q1", "best issue tracker")]);

    expect(pool).toEqual([
      { query_id: "q1", page_url: "https://asana.com/issues", rank: 1, source: "serp_organic" },
      { query_id: "q1", page_url: "https://linear.app/features", rank: 2, source: "serp_organic" },
    ]);
    // forwards query text, vertical, and the per-query limit to the SERP port
    expect(calls[0]).toEqual({
      query: "best issue tracker",
      vertical: "project-management",
      limit: DEFAULT_PER_QUERY_LIMIT,
    });
  });

  it("uses SERP-provided rank when EVERY result carries one", async () => {
    const { client } = mockSerp({
      "agile tools": [
        { url: "https://a.com/x", rank: 3 },
        { url: "https://b.com/y", rank: 9 },
        { url: "https://c.com/z", rank: 5 },
      ],
    });
    const pool = await buildCandidatePool(client, [query("q1", "agile tools")]);
    expect(pool.map((e) => [e.page_url, e.rank])).toEqual([
      ["https://a.com/x", 3],
      ["https://c.com/z", 5],
      ["https://b.com/y", 9],
    ]);
  });

  it("falls back to 1-based position for ALL results when any rank is missing (all-or-nothing)", async () => {
    const { client } = mockSerp({
      "agile tools": [
        { url: "https://a.com/x" }, // no rank
        { url: "https://b.com/y", rank: 9 }, // a stray provided rank is IGNORED for consistency
        { url: "https://c.com/z" }, // no rank
      ],
    });
    const pool = await buildCandidatePool(client, [query("q1", "agile tools")]);
    expect(pool.map((e) => [e.page_url, e.rank])).toEqual([
      ["https://a.com/x", 1],
      ["https://b.com/y", 2],
      ["https://c.com/z", 3],
    ]);
  });

  it("normalizes messy SERP urls (www / uppercase / trailing slash / fragment) into join keys", async () => {
    const { client } = mockSerp({
      "crm comparison": [
        { url: "https://www.Example.com/Best-CRM/#reviews", rank: 1 },
        { url: "example.com/pricing", rank: 2 }, // missing scheme
      ],
    });
    const pool = await buildCandidatePool(client, [query("q1", "crm comparison")]);
    expect(pool[0].page_url).toBe(normalizeUrl("https://www.Example.com/Best-CRM/#reviews"));
    expect(pool[0].page_url).toBe("https://example.com/Best-CRM");
    expect(pool[1].page_url).toBe("https://example.com/pricing");
  });

  it("skips results whose url won't normalize (don't poison the join)", async () => {
    const { client } = mockSerp({
      "x": [
        { url: "", rank: 1 }, // empty → normalizeUrl throws → skipped
        { url: "https://good.com/page", rank: 2 },
      ],
    });
    const pool = await buildCandidatePool(client, [query("q1", "x")]);
    expect(pool).toHaveLength(1);
    expect(pool[0].page_url).toBe("https://good.com/page");
  });

  it("within-query dedupe keeps the BEST (lowest) rank for the same normalized url", async () => {
    const { client } = mockSerp({
      "dupe query": [
        { url: "https://www.Site.com/page/", rank: 5 },
        { url: "https://site.com/page", rank: 2 }, // same normalized url, better rank
        { url: "https://site.com/page#frag", rank: 8 }, // same again, worse rank
      ],
    });
    const pool = await buildCandidatePool(client, [query("q1", "dupe query")]);
    expect(pool).toHaveLength(1);
    expect(pool[0]).toEqual({
      query_id: "q1",
      page_url: "https://site.com/page",
      rank: 2,
      source: "serp_organic",
    });
  });

  it("does NOT dedupe across queries — the same page can appear in two queries' pools", async () => {
    const { client } = mockSerp({
      "query one": [{ url: "https://shared.com/p", rank: 1 }],
      "query two": [{ url: "https://shared.com/p", rank: 4 }],
    });
    const pool = await buildCandidatePool(client, [
      query("q1", "query one"),
      query("q2", "query two"),
    ]);
    expect(pool).toEqual([
      { query_id: "q1", page_url: "https://shared.com/p", rank: 1, source: "serp_organic" },
      { query_id: "q2", page_url: "https://shared.com/p", rank: 4, source: "serp_organic" },
    ]);
  });

  it("caps the pool to the DEFAULT top-N per query", async () => {
    const many: SerpOrganicResult[] = Array.from({ length: 25 }, (_, i) => ({
      url: `https://e.com/p${i}`,
      rank: i + 1,
    }));
    const { client } = mockSerp({ "flood": many });
    const pool = await buildCandidatePool(client, [query("q1", "flood")]);
    expect(pool).toHaveLength(DEFAULT_PER_QUERY_LIMIT);
    // kept the top-N by rank
    expect(pool[0].rank).toBe(1);
    expect(pool[pool.length - 1].rank).toBe(DEFAULT_PER_QUERY_LIMIT);
  });

  it("honors an explicit perQueryLimit override", async () => {
    const many: SerpOrganicResult[] = Array.from({ length: 25 }, (_, i) => ({
      url: `https://e.com/p${i}`,
      rank: i + 1,
    }));
    const { client } = mockSerp({ "flood": many });
    const pool = await buildCandidatePool(client, [query("q1", "flood")], { perQueryLimit: 3 });
    expect(pool).toHaveLength(3);
    expect(pool.map((e) => e.rank)).toEqual([1, 2, 3]);
  });

  it("a query with zero SERP results yields no entries (no crash)", async () => {
    const { client } = mockSerp({}); // every lookup returns []
    const pool = await buildCandidatePool(client, [query("q1", "empty query")]);
    expect(pool).toEqual([]);
  });

  it("exposes a stable pool version", () => {
    expect(CANDIDATE_POOL_VERSION).toBe("candidate-pool/serp-organic@v1");
  });
});

describe("poolForQuery", () => {
  it("returns only that query's entries, sorted by rank ascending", async () => {
    const { client } = mockSerp({
      "query one": [
        { url: "https://a.com/3", rank: 3 },
        { url: "https://a.com/1", rank: 1 },
        { url: "https://a.com/2", rank: 2 },
      ],
      "query two": [{ url: "https://b.com/1", rank: 1 }],
    });
    const pool = await buildCandidatePool(client, [
      query("q1", "query one"),
      query("q2", "query two"),
    ]);

    const forQ1 = poolForQuery(pool, "q1");
    expect(forQ1.every((e) => e.query_id === "q1")).toBe(true);
    expect(forQ1.map((e) => e.rank)).toEqual([1, 2, 3]);

    const forQ2 = poolForQuery(pool, "q2");
    expect(forQ2).toHaveLength(1);
    expect(forQ2[0].page_url).toBe("https://b.com/1");
  });

  it("returns an empty array for an unknown query id", () => {
    expect(poolForQuery([], "nope")).toEqual([]);
  });
});
