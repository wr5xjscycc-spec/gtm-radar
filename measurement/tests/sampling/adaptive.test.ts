// P2·3 (Measurement, adaptive sampling) — tests for the −40–50% cost lever.
//
// Two concerns under test:
//  1. `anyAmbiguous` — the pure straddle decision. The calibration table in the design spec is
//     numeric ground truth; we assert the exact spec cases (0/3, 0/4-via-K, 0/8, 3/3, 4/4, 2/4,
//     empty) plus the `focusDomains` restriction. The straddle rule (ci_low < τ < ci_high), NOT a
//     CI-width rule, is the whole point — a width rule pins every never-cited page to kMax.
//  2. `measureAdaptive` — per-engine orchestration. Fully OFFLINE: a fake registry whose adapters
//     return scripted EngineQueryResults per call index. We assert convergence (call counts),
//     per-engine isolation (a throwing adapter lands in `failures` without stopping the other
//     engine), per-engine bookkeeping (perEngineK / rows / aggregates), and run_idx + engine labels.

import { describe, expect, it } from "vitest";
import { anyAmbiguous, measureAdaptive } from "../../src/sampling/adaptive";
import { aggregateRuns, type MeasurementAggregate } from "../../src/stats/aggregate";
import { buildLabeledRows } from "../../src/pipeline";
import type { EngineAdapter, EngineRegistry } from "../../src/dispatch";
import type { QueryRecord, CandidatePage } from "../../src/contract-records";
import type { Citation, Engine, EngineQueryResult } from "../../src/types";

// --- helpers -----------------------------------------------------------------------------------

/** Build a one-group set of K labeled rows for a single (query,page,engine), with `citedRuns`
 *  of them cited. We synthesize rows directly so we can hit exact (cited_count, k) targets,
 *  then aggregate them through the REAL aggregator so the CI we test is the production CI. */
function aggFor(citedCount: number, k: number, page = "https://acme.io/x"): MeasurementAggregate {
  const rows = [];
  for (let i = 0; i < k; i++) {
    rows.push({
      query_id: "q1",
      page_url: page,
      engine: "openai" as Engine,
      model_version: "gpt-5",
      run_idx: i,
      appeared: i < citedCount,
      cited: i < citedCount,
      position: i < citedCount ? 1 : null,
      source_urls: [] as string[],
      ts: 0,
      window_tag: "adhoc" as const,
    });
  }
  const aggs = aggregateRuns(rows);
  return aggs[0]!;
}

function citation(domain: string, rank: number): Citation {
  return { url: `https://${domain}/p`, domain, rank };
}

/** An EngineQueryResult that cites `acme.io` (so the acme candidate page is `cited`) or not. */
function result(engine: Engine, cited: boolean): EngineQueryResult {
  return {
    engine,
    model_version: "gpt-5",
    answer_text: cited ? "see acme.io" : "nothing relevant",
    citations: cited ? [citation("acme.io", 1)] : [],
  };
}

/** A scripted adapter: CYCLES through `script` by call index and counts its invocations. A
 *  single-element script means "always that state"; a two-element script alternates (coin-flip). */
function scriptedAdapter(engine: Engine, script: boolean[]): EngineAdapter & { calls: number } {
  const fn = (async (_params: Parameters<EngineAdapter>[0]) => {
    const cited = script[fn.calls % script.length]!;
    fn.calls += 1;
    return result(engine, cited);
  }) as EngineAdapter & { calls: number };
  fn.calls = 0;
  return fn;
}

const QUERY: QueryRecord = {
  id: "q1",
  customer_id: "c1",
  vertical: "v",
  text: "best widget",
  seed_source: "keyword",
  target_engines: ["openai", "perplexity"],
};

const POOL: CandidatePage[] = [{ company_domain: "acme.io", url: "https://acme.io/x", role: "customer" }];

// --- anyAmbiguous ------------------------------------------------------------------------------

describe("anyAmbiguous", () => {
  it("0/3 straddles 0.5 → true", () => {
    expect(anyAmbiguous([aggFor(0, 3)])).toBe(true);
  });

  it("0/8 resolved (confidently uncited) → false", () => {
    expect(anyAmbiguous([aggFor(0, 8)])).toBe(false);
  });

  it("3/3 straddles 0.5 → true", () => {
    expect(anyAmbiguous([aggFor(3, 3)])).toBe(true);
  });

  it("4/4 resolved at K=4 → false", () => {
    expect(anyAmbiguous([aggFor(4, 4)])).toBe(false);
  });

  it("2/4 coin-flip still straddles → true", () => {
    expect(anyAmbiguous([aggFor(2, 4)])).toBe(true);
  });

  it("0/4 resolved at K=4 (ci_high 0.490 < 0.5) → false", () => {
    expect(anyAmbiguous([aggFor(0, 4)])).toBe(false);
  });

  it("empty → false", () => {
    expect(anyAmbiguous([])).toBe(false);
  });

  it("ANY unresolved page forces extension (mix of resolved + unresolved)", () => {
    expect(anyAmbiguous([aggFor(0, 8), aggFor(0, 3)])).toBe(true);
  });

  it("focusDomains restricts which pages drive the decision", () => {
    // The ambiguous page (0/3) is OUT of focus; the only in-focus page (0/8) is resolved.
    const ambiguousOutOfFocus = aggFor(0, 3, "https://other.com/y");
    const resolvedInFocus = aggFor(0, 8, "https://acme.io/x");
    expect(
      anyAmbiguous([ambiguousOutOfFocus, resolvedInFocus], { focusDomains: ["acme.io"] }),
    ).toBe(false);
    // Without the focus filter, the ambiguous out-of-focus page DOES force extension.
    expect(anyAmbiguous([ambiguousOutOfFocus, resolvedInFocus])).toBe(true);
  });

  it("focusDomains matches via normalizeDomain (www / scheme tolerant)", () => {
    const inFocus = aggFor(0, 3, "https://acme.io/x");
    expect(anyAmbiguous([inFocus], { focusDomains: ["https://www.acme.io/"] })).toBe(true);
  });

  it("custom threshold shifts the boundary", () => {
    // 2/4 → {0.150, 0.850}. τ=0.9 lies outside the interval (0.850 < 0.9) → resolved.
    expect(anyAmbiguous([aggFor(2, 4)], { threshold: 0.9 })).toBe(false);
  });
});

// --- measureAdaptive ---------------------------------------------------------------------------

describe("measureAdaptive", () => {
  const baseKeys: Partial<Record<Engine, string>> = { openai: "k", perplexity: "k" };

  it("never-cited engine resolves at K=4 (adapter called exactly 4 times)", async () => {
    const openai = scriptedAdapter("openai", [false]); // always uncited
    const registry: EngineRegistry = { openai };
    const res = await measureAdaptive({
      query: { ...QUERY, target_engines: ["openai"] },
      candidatePool: POOL,
      registry,
      apiKeys: { openai: "k" },
      ts: 0,
    });
    expect(openai.calls).toBe(4);
    expect(res.perEngineK.openai).toBe(4);
    expect(res.failures).toEqual([]);
  });

  it("coin-flip engine runs to kMax (adapter called exactly 8 times)", async () => {
    const openai = scriptedAdapter("openai", [true, false]); // alternates → p̂≈0.5 → never resolves
    const registry: EngineRegistry = { openai };
    const res = await measureAdaptive({
      query: { ...QUERY, target_engines: ["openai"] },
      candidatePool: POOL,
      registry,
      apiKeys: { openai: "k" },
      ts: 0,
    });
    expect(openai.calls).toBe(8);
    expect(res.perEngineK.openai).toBe(8);
  });

  it("two engines converge differently → different perEngineK, per-engine rows/aggregates", async () => {
    const openai = scriptedAdapter("openai", [false]); // resolves at K=4
    const perplexity = scriptedAdapter("perplexity", [true, false]); // runs to kMax=8
    const registry: EngineRegistry = { openai, perplexity };
    const res = await measureAdaptive({
      query: QUERY,
      candidatePool: POOL,
      registry,
      apiKeys: baseKeys,
      ts: 0,
    });

    expect(openai.calls).toBe(4);
    expect(perplexity.calls).toBe(8);
    expect(res.perEngineK).toEqual({ openai: 4, perplexity: 8 });

    // Rows kept per-engine: one row per (page × run) per engine, since POOL has one page.
    const openaiRows = res.rows.filter((r) => r.engine === "openai");
    const perpRows = res.rows.filter((r) => r.engine === "perplexity");
    expect(openaiRows).toHaveLength(4);
    expect(perpRows).toHaveLength(8);

    // Aggregates kept per-engine: one aggregate per engine (one page each).
    const openaiAgg = res.aggregates.find((a) => a.engine === "openai")!;
    const perpAgg = res.aggregates.find((a) => a.engine === "perplexity")!;
    expect(openaiAgg.k).toBe(4);
    expect(openaiAgg.cited_count).toBe(0);
    expect(perpAgg.k).toBe(8);
    expect(perpAgg.cited_count).toBe(4); // alternating true/false over 8 runs
  });

  it("a throwing adapter lands in failures while the other engine completes", async () => {
    const good = scriptedAdapter("openai", [false]); // resolves at K=4
    const bad: EngineAdapter = async () => {
      throw new Error("perplexity blew up");
    };
    const registry: EngineRegistry = { openai: good, perplexity: bad };
    const res = await measureAdaptive({
      query: QUERY,
      candidatePool: POOL,
      registry,
      apiKeys: baseKeys,
      ts: 0,
    });

    expect(good.calls).toBe(4);
    expect(res.perEngineK.openai).toBe(4);
    // The failed engine reached no successful K and produced no rows/aggregates.
    expect(res.perEngineK.perplexity).toBeUndefined();
    expect(res.rows.every((r) => r.engine === "openai")).toBe(true);
    expect(res.failures).toEqual([{ engine: "perplexity", error: "perplexity blew up" }]);
  });

  it("skips engines with no adapter or no api key (no call, no failure)", async () => {
    const openai = scriptedAdapter("openai", [false]);
    const perplexity = scriptedAdapter("perplexity", [false]);
    const registry: EngineRegistry = { openai, perplexity };
    const res = await measureAdaptive({
      query: QUERY,
      candidatePool: POOL,
      registry,
      apiKeys: { openai: "k" }, // perplexity has an adapter but NO key
      ts: 0,
    });
    expect(openai.calls).toBe(4);
    expect(perplexity.calls).toBe(0);
    expect(res.perEngineK.perplexity).toBeUndefined();
    expect(res.failures).toEqual([]);
  });

  it("rows carry the correct run_idx sequence and the engine label from the adapter result", async () => {
    const openai = scriptedAdapter("openai", [false]);
    const registry: EngineRegistry = { openai };
    const res = await measureAdaptive({
      query: { ...QUERY, target_engines: ["openai"] },
      candidatePool: POOL,
      registry,
      apiKeys: { openai: "k" },
      ts: 0,
    });
    const idxs = res.rows.filter((r) => r.engine === "openai").map((r) => r.run_idx);
    expect(idxs).toEqual([0, 1, 2, 3]);
    expect(res.rows.every((r) => r.engine === "openai")).toBe(true);
  });

  it("kInitial/kMax overrides are honored", async () => {
    // kInitial=2: a never-cited engine resolves at K=2 (0/2 → {0,0.658}? still straddles) — use
    // a clearly-resolving case instead: cited-always resolves quickly. With kMax=5 a coin-flip
    // engine caps at 5.
    const openai = scriptedAdapter("openai", [true, false]);
    const registry: EngineRegistry = { openai };
    const res = await measureAdaptive({
      query: { ...QUERY, target_engines: ["openai"] },
      candidatePool: POOL,
      registry,
      apiKeys: { openai: "k" },
      ts: 0,
      kInitial: 3,
      kMax: 5,
    });
    expect(openai.calls).toBe(5);
    expect(res.perEngineK.openai).toBe(5);
  });

  it("focusDomains forwarded: out-of-focus ambiguity does not extend sampling", async () => {
    // Pool has two pages. The customer page never gets cited (resolves at K=4); a noise page is a
    // coin-flip (would run to kMax). With focusDomains pinned to the customer, sampling stops at 4.
    const twoPagePool: CandidatePage[] = [
      { company_domain: "acme.io", url: "https://acme.io/x", role: "customer" },
      { company_domain: "noise.com", url: "https://noise.com/y", role: "candidate" },
    ];
    // adapter cites noise.com on alternating calls, never cites acme.io.
    let calls = 0;
    const openai: EngineAdapter = async () => {
      const citeNoise = calls % 2 === 0;
      calls += 1;
      return {
        engine: "openai" as Engine,
        model_version: "gpt-5",
        answer_text: "x",
        citations: citeNoise ? [citation("noise.com", 1)] : [],
      };
    };
    const registry: EngineRegistry = { openai };
    const res = await measureAdaptive({
      query: { ...QUERY, target_engines: ["openai"] },
      candidatePool: twoPagePool,
      registry,
      apiKeys: { openai: "k" },
      ts: 0,
      focusDomains: ["acme.io"],
    });
    expect(calls).toBe(4); // acme resolves; noise's ambiguity ignored
    expect(res.perEngineK.openai).toBe(4);
  });
});
