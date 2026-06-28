// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { describe, it, expect, vi, afterEach } from "vitest";
import schema from "../../convex/schema";
import { api } from "../../convex/_generated/api";
import {
  buildSeedQueries,
  buildCandidatePool,
  pagesToCandidatePool,
} from "../../convex/measure";
import openaiFixture from "../../measurement/tests/fixtures/openai-responses-web_search.json";

// In-process Convex (no network). The `fetch` the action makes to OpenAI is stubbed
// with the recorded `web_search` fixture, so this is deterministic + key-free. The
// fixture cites seraleads.com / pikaseo.com / alexberman.com / … (NOT acme.com), so
// a workspace whose own_domain is acme.com and whose competitor is seraleads.com must
// land as "you 0 · competitor cited".
const modules = import.meta.glob("../../convex/**/!(*.config|*.example).ts");

/** A fetch mock returning the recorded OpenAI Responses `web_search` payload. */
function okFixtureResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => openaiFixture,
    text: async () => JSON.stringify(openaiFixture),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("measureWorkspace — onboarding fires a real OpenAI measurement → gut-punch", () => {
  it("competitor is cited, you are not → you.cited===0, topCompetitor.cited>0", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okFixtureResponse()));

    const t = convexTest(schema, modules);
    const workspaceId = await t.mutation(api.customers.createWorkspace, {
      name: "Acme",
      vertical: "AI SDR",
      own_domain: "acme.com", // NOT cited in the fixture
      competitor_domains: ["seraleads.com"], // cited in the fixture
    });

    const summary = await t.action(api.measure.measureWorkspace, {
      workspaceId,
      nQueries: 2,
    });
    // 2 queries, both succeed (mock), each labels 2 candidate pages → 4 rows.
    expect(summary.queries).toBe(2);
    expect(summary.measured).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.rows).toBe(4);

    const board = await t.query(api.board.gutPunch, { workspaceId });
    const openai = board.perEngine.openai;
    expect(openai).toBeTruthy();
    // The gut-punch: you are invisible, the competitor owns the citations.
    expect(openai.you.cited).toBe(0);
    expect(openai.you.total).toBe(2);
    expect(openai.topCompetitor).toBeTruthy();
    expect(openai.topCompetitor.domain).toBe("seraleads.com");
    expect(openai.topCompetitor.cited).toBeGreaterThan(0);

    // Queries were persisted (query-review view) and tagged keyword-sourced.
    const queries = await t.query(api.board.queries, { workspaceId });
    expect(queries).toHaveLength(2);
    expect(queries.every((q: { seed_source: string }) => q.seed_source === "keyword")).toBe(true);

    // Measurements landed in the baseline window.
    const measurements = await t.query(api.board.measurements, { workspaceId });
    expect(measurements).toHaveLength(4);
    expect(measurements.every((m: { window_tag: string }) => m.window_tag === "baseline")).toBe(true);
  });

  it("one failed query does NOT blank the board (allSettled isolates)", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        if (call === 1) throw new Error("network blip / timeout");
        return okFixtureResponse();
      }),
    );

    const t = convexTest(schema, modules);
    const workspaceId = await t.mutation(api.customers.createWorkspace, {
      name: "Acme",
      vertical: "AI SDR",
      own_domain: "acme.com",
      competitor_domains: ["seraleads.com"],
    });

    const summary = await t.action(api.measure.measureWorkspace, {
      workspaceId,
      nQueries: 2,
    });
    expect(summary.failed).toBe(1);
    expect(summary.measured).toBe(1);

    // The surviving query still filled the board.
    const board = await t.query(api.board.gutPunch, { workspaceId });
    expect(board.perEngine.openai.topCompetitor.cited).toBeGreaterThan(0);
  });
});

describe("pure helpers — buildSeedQueries + candidate pool", () => {
  it("buildSeedQueries: defaults to 16, caps at 16, floors at 1, keyword-sourced, embeds vertical", () => {
    const def = buildSeedQueries("AI SDR");
    expect(def).toHaveLength(16);
    expect(def.every((q) => q.seed_source === "keyword")).toBe(true);
    expect(def.every((q) => q.text.includes("AI SDR"))).toBe(true);

    expect(buildSeedQueries("v", 2)).toHaveLength(2);
    expect(buildSeedQueries("v", 100)).toHaveLength(16); // cap
    expect(buildSeedQueries("v", 0)).toHaveLength(16); // 0 → default
    expect(buildSeedQueries("v", -5)).toHaveLength(1); // floor
    expect(buildSeedQueries("   ").every((q) => q.text.includes("software"))).toBe(true); // empty vertical fallback
  });

  it("buildCandidatePool: own first (customer), competitors after (competitor), skips empties", () => {
    const pool = buildCandidatePool("acme.com", ["seraleads.com", "rival.io"]);
    expect(pool).toHaveLength(3);
    expect(pool[0]).toEqual({ company_domain: "acme.com", url: "acme.com", role: "customer" });
    expect(pool[1].role).toBe("competitor");
    expect(buildCandidatePool("", []).length).toBe(0);
  });

  it("pagesToCandidatePool: de-dupes and keys company_domain on the registrable domain", () => {
    const pool = pagesToCandidatePool([
      "https://www.acme.com/pricing",
      "https://www.acme.com/pricing", // dup
      "https://blog.rival.io/post",
    ]);
    expect(pool).toHaveLength(2);
    expect(pool[0].company_domain).toBe("acme.com");
    expect(pool[1].company_domain).toBe("rival.io");
  });
});
