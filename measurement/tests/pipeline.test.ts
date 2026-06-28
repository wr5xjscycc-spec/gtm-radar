import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dispatchQuery } from "../src/dispatch";
import { buildLabeledRows } from "../src/pipeline";
import type { QueryRecord, CandidatePage } from "../src/contract-records";

// P2·2 DoD integration test: "queries dispatch and produce normalized, case-control-labeled
// rows on fixtures." Exercises the SEAM across every P2·2 + P0 module with NO network:
//   queries.json → dispatchQuery (real runOpenAIQuery via DEFAULT_REGISTRY, fetch mocked to
//   return the REAL captured response) → buildLabeledRows(query, engineResult, candidatePool)
//
// Committed fixture's cited domains (rank order): seraleads.com(1), pikaseo.com(2),
// techstackreviews.net(3), alexberman.com(4), guideflow.com(5), storylane.io(6).
// Candidate pool: syncgtm, seraleads, salesmotion, apollo, outreach.
// ⇒ exactly one winner (seraleads, position 1); the other four are case-control losers.

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/openai-responses-web_search.json", import.meta.url), "utf8"),
);
const queries = JSON.parse(
  readFileSync(new URL("./fixtures/queries.json", import.meta.url), "utf8"),
) as QueryRecord[];
const pool = JSON.parse(
  readFileSync(new URL("./fixtures/candidate-pool.json", import.meta.url), "utf8"),
) as CandidatePage[];

// fetch mocked to replay the committed real response — no network, deterministic.
const mockFetch = (async () => ({
  ok: true,
  status: 200,
  json: async () => fixture,
  text: async () => JSON.stringify(fixture),
})) as unknown as typeof fetch;

const TS = 1_700_000_000_000;

describe("P2·2 composed flow: query → dispatch → case-control-labeled rows", () => {
  it("dispatches the OpenAI-only query through the real adapter (mocked fetch)", async () => {
    const query = queries[0]!;
    const out = await dispatchQuery(query, { apiKeys: { openai: "test-key" }, fetchImpl: mockFetch });
    expect(out.skipped).toEqual([]);
    expect(out.failures).toEqual([]);
    expect(out.results).toHaveLength(1);
    expect(out.results[0]!.engine).toBe("openai");
    expect(out.results[0]!.model_version).toBe("gpt-4o-2024-08-06");
  });

  it("produces exactly one labeled row per candidate-pool page (and none for out-of-pool pages)", async () => {
    const query = queries[0]!;
    const { results } = await dispatchQuery(query, {
      apiKeys: { openai: "test-key" },
      fetchImpl: mockFetch,
    });
    const rows = buildLabeledRows({ query, engineResult: results[0]!, candidatePool: pool, ts: TS });

    expect(rows).toHaveLength(pool.length);
    // Case-control invariant: every row corresponds to a candidate-pool page — nothing else.
    const poolUrls = new Set(pool.map((p) => p.url));
    expect(rows.every((r) => poolUrls.has(r.page_url))).toBe(true);
  });

  it("labels seraleads as the winner at position 1 and the rest as losers", async () => {
    const query = queries[0]!;
    const { results } = await dispatchQuery(query, {
      apiKeys: { openai: "test-key" },
      fetchImpl: mockFetch,
    });
    const rows = buildLabeledRows({ query, engineResult: results[0]!, candidatePool: pool, ts: TS });

    const bySite = (needle: string) => rows.find((r) => r.page_url.includes(needle))!;

    const winner = bySite("seraleads.com");
    expect(winner.cited).toBe(true);
    expect(winner.appeared).toBe(true);
    expect(winner.position).toBe(1);
    // Common contract fields stamped correctly.
    expect(winner.engine).toBe("openai");
    expect(winner.model_version).toBe("gpt-4o-2024-08-06");
    expect(winner.query_id).toBe("q-ai-sdr-2026");
    expect(winner.run_idx).toBe(0);
    expect(winner.window_tag).toBe("adhoc");
    expect(winner.ts).toBe(TS);
    expect(winner.source_urls).toHaveLength(6); // the fixture's 6 unique cited sources

    for (const site of ["syncgtm.com", "salesmotion.io", "apollo.io", "outreach.io"]) {
      const loser = bySite(site);
      expect(loser.cited).toBe(false);
      expect(loser.position).toBeNull();
    }

    const winners = rows.filter((r) => r.cited);
    const losers = rows.filter((r) => !r.cited);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(4);
  });
});
