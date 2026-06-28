// P2·6 Module 4 — tests for the resumable, pausable sweep (the integration).
//
// Fully OFFLINE: a FAKE EngineRegistry whose adapters return scripted EngineQueryResults, an
// INSTANT injected `sleep` for the one retry-recovery case, and never a real clock or network.
// The sweep ties together budget (never overrun), retry (wrap adapters), drift (surface
// model-version change), adaptive measurement, and aggregation into a resumable unit.
//
// Budget arithmetic (default multiplier 2×, realizedCostUSD(n) = n * 0.01 * 2):
//   A single-engine, never-cited query resolves at K=4 (adaptive calibration), so it RECORDS
//   realizedCostUSD(4) = $0.08. Its worst-case RESERVE is worstCaseCalls(1, kMax=8) = 8 calls =
//   realizedCostUSD(8) = $0.16. The guard checks the $0.16 reserve BEFORE starting, but only
//   records the $0.08 actually spent — that gap is exactly why the ceiling never overruns.

import { describe, expect, it } from "vitest";
import { runSweep, type SweepCheckpoint } from "../src/sweep";
import type { EngineAdapter, EngineRegistry } from "../src/dispatch";
import type { QueryRecord, CandidatePage } from "../src/contract-records";
import type { Citation, Engine, EngineQueryResult } from "../src/types";

// --- helpers -----------------------------------------------------------------------------------

function citation(domain: string, rank: number): Citation {
  return { url: `https://${domain}/p`, domain, rank };
}

/** An EngineQueryResult that cites `acme.io` or not, stamped with a model_version. */
function result(engine: Engine, cited: boolean, modelVersion = "gpt-5"): EngineQueryResult {
  return {
    engine,
    model_version: modelVersion,
    answer_text: cited ? "see acme.io" : "nothing relevant",
    citations: cited ? [citation("acme.io", 1)] : [],
  };
}

/** A never-citing adapter (resolves at K=4) that counts its invocations. */
function neverCitedAdapter(engine: Engine): EngineAdapter & { calls: number } {
  const fn = (async (_p: Parameters<EngineAdapter>[0]) => {
    fn.calls += 1;
    return result(engine, false);
  }) as EngineAdapter & { calls: number };
  fn.calls = 0;
  return fn;
}

/** The single-page, never-cited candidate pool — drives the deterministic K=4 convergence. */
const POOL: CandidatePage[] = [
  { company_domain: "acme.io", url: "https://acme.io/x", role: "customer" },
];
const poolFor = (_q: QueryRecord) => POOL;

function query(id: string, engines: Engine[] = ["openai"]): QueryRecord {
  return {
    id,
    customer_id: "c1",
    vertical: "v",
    text: `q ${id}`,
    seed_source: "keyword",
    target_engines: engines,
  };
}

const KEYS: Partial<Record<Engine, string>> = { openai: "k" };

// --- budget: complete --------------------------------------------------------------------------

describe("runSweep — budget fits all queries", () => {
  it("runs every query → status complete, all completed, remaining empty", async () => {
    const openai = neverCitedAdapter("openai");
    const registry: EngineRegistry = { openai };
    const res = await runSweep({
      queries: [query("q1"), query("q2"), query("q3")],
      poolFor,
      registry,
      apiKeys: KEYS,
      ts: 0,
      // 3 queries × $0.16 reserve = $0.48; ceiling clears all three.
      budgetCeilingUSD: 0.48,
    });

    expect(res.status).toBe("complete");
    expect(res.coverage.completed).toEqual(["q1", "q2", "q3"]);
    expect(res.coverage.remaining).toEqual([]);
    expect(res.coverage.paused).toBe(false);
    // 3 queries × K=4 recorded = realizedCostUSD(12) = $0.24.
    expect(res.windowSpentUSD).toBeCloseTo(0.24, 10);
    expect(res.windowSpentUSD).toBeLessThanOrEqual(0.48);
    // 3 queries × 1 page × 4 runs = 12 rows.
    expect(res.rows).toHaveLength(12);
    expect(res.aggregates).toHaveLength(3); // one (query,page,engine) group per query
    expect(res.failures).toEqual([]);
    expect(res.checkpoint.completedQueryIds).toEqual(["q1", "q2", "q3"]);
    expect(res.checkpoint.totalSpentUSD).toBeCloseTo(0.24, 10);
  });
});

// --- budget: paused (no overrun) ---------------------------------------------------------------

describe("runSweep — budget fits exactly 2 of 3", () => {
  it("pauses before the 3rd query → status paused, never overruns the ceiling", async () => {
    const openai = neverCitedAdapter("openai");
    const registry: EngineRegistry = { openai };
    // Ceiling 0.30: q1 reserve check 0+0.16≤0.30 ✓; q2 0.08+0.16=0.24≤0.30 ✓;
    // q3 0.16+0.16=0.32≤0.30 ✗ → PAUSE before q3 ever starts.
    const res = await runSweep({
      queries: [query("q1"), query("q2"), query("q3")],
      poolFor,
      registry,
      apiKeys: KEYS,
      ts: 0,
      budgetCeilingUSD: 0.3,
    });

    expect(res.status).toBe("paused");
    expect(res.coverage.completed).toEqual(["q1", "q2"]);
    expect(res.coverage.remaining).toEqual(["q3"]);
    expect(res.coverage.paused).toBe(true);
    // NO OVERRUN: spend this window stays under the ceiling.
    expect(res.windowSpentUSD).toBeCloseTo(0.16, 10); // 2 queries × K=4 = realizedCostUSD(8)
    expect(res.windowSpentUSD).toBeLessThanOrEqual(0.3);
    // q3 never ran → no openai calls beyond the 8 (2×4) of q1+q2.
    expect(openai.calls).toBe(8);
    expect(res.checkpoint.completedQueryIds).toEqual(["q1", "q2"]);
    expect(res.checkpoint.totalSpentUSD).toBeCloseTo(0.16, 10);
  });
});

// --- resume ------------------------------------------------------------------------------------

describe("runSweep — resume from a paused checkpoint", () => {
  it("continues the remaining query with a fresh ceiling → complete, cumulative spend", async () => {
    // Window 1: pause after 2 queries (same setup as above).
    const openai1 = neverCitedAdapter("openai");
    const first = await runSweep({
      queries: [query("q1"), query("q2"), query("q3")],
      poolFor,
      registry: { openai: openai1 },
      apiKeys: KEYS,
      ts: 0,
      budgetCeilingUSD: 0.3,
    });
    expect(first.status).toBe("paused");

    // Window 2: feed the checkpoint back with a fresh ceiling → q3 runs.
    const openai2 = neverCitedAdapter("openai");
    const second = await runSweep({
      queries: [query("q1"), query("q2"), query("q3")],
      poolFor,
      registry: { openai: openai2 },
      apiKeys: KEYS,
      ts: 0,
      budgetCeilingUSD: 0.5,
      resumeFrom: first.checkpoint,
    });

    expect(second.status).toBe("complete");
    // Only q3 ran THIS window; coverage.completed is this-window only.
    expect(second.coverage.completed).toEqual(["q3"]);
    expect(second.coverage.remaining).toEqual([]);
    expect(openai2.calls).toBe(4); // only q3 measured this window
    expect(second.rows).toHaveLength(4);
    expect(second.windowSpentUSD).toBeCloseTo(0.08, 10); // 1 query × K=4

    // checkpoint.completedQueryIds is CUMULATIVE across both windows.
    expect(second.checkpoint.completedQueryIds).toEqual(["q1", "q2", "q3"]);
    // totalSpentUSD accumulates both windows: 0.16 (window 1) + 0.08 (window 2) = 0.24.
    expect(second.checkpoint.totalSpentUSD).toBeCloseTo(0.24, 10);
  });
});

// --- per-engine isolation: an adapter that always throws ---------------------------------------

describe("runSweep — a failing engine is isolated", () => {
  it("records the failure tagged with query_id, continues to the NEXT query, marks both completed", async () => {
    const good = neverCitedAdapter("openai");
    // Non-retryable error so withRetry rethrows immediately (no real clock reached).
    const bad: EngineAdapter = async () => {
      throw new Error("perplexity boom");
    };
    const registry: EngineRegistry = { openai: good, perplexity: bad };
    // Two queries: q1 has the failing engine; q2 follows. The sweep must continue past q1's
    // engine failure to q2 (per-engine isolation: an engine failing is not a query failing).
    const res = await runSweep({
      queries: [query("q1", ["openai", "perplexity"]), query("q2", ["openai"])],
      poolFor,
      registry,
      apiKeys: { openai: "k", perplexity: "k" },
      ts: 0,
      budgetCeilingUSD: 1, // ample
      retry: false, // also no retry — failure is permanent and immediate
    });

    // Both queries RAN (openai succeeded on each) → both marked completed despite q1's failure.
    expect(res.status).toBe("complete");
    expect(res.coverage.completed).toEqual(["q1", "q2"]);
    expect(res.coverage.remaining).toEqual([]);
    // The failure is surfaced, tagged with q1's query_id (per-engine isolation).
    expect(res.failures).toEqual([
      { engine: "perplexity", error: "perplexity boom", query_id: "q1" },
    ]);
    // openai's rows survive for both queries; perplexity contributed none.
    expect(res.rows.every((r) => r.engine === "openai")).toBe(true);
    expect(res.rows).toHaveLength(8); // q1 (K=4) + q2 (K=4)
  });
});

// --- retry recovery: 429 once, then succeeds ---------------------------------------------------

describe("runSweep — retry recovers a transient failure", () => {
  it("wraps adapters in withRetry; a one-shot 429 is absorbed via injected sleep", async () => {
    const slept: number[] = [];
    const sleep = async (ms: number) => {
      slept.push(ms);
    };

    // Fails 429 on the FIRST underlying invocation only, then never-cites forever.
    let underlyingCalls = 0;
    const flaky: EngineAdapter = async () => {
      underlyingCalls += 1;
      if (underlyingCalls === 1) throw new Error("OpenAI Responses API error 429: slow down");
      return result("openai", false);
    };
    const registry: EngineRegistry = { openai: flaky };

    const res = await runSweep({
      queries: [query("q1")],
      poolFor,
      registry,
      apiKeys: KEYS,
      ts: 0,
      budgetCeilingUSD: 1,
      retry: { sleep }, // inject instant sleep; defaults otherwise (baseDelayMs 500)
    });

    expect(res.status).toBe("complete");
    expect(res.coverage.completed).toEqual(["q1"]);
    expect(res.failures).toEqual([]);
    // 1 retried (recovered) + 4 successful runs = 5 underlying invocations.
    expect(underlyingCalls).toBe(5);
    // Exactly one backoff sleep, at the deterministic base delay.
    expect(slept).toEqual([500]);
    expect(res.rows).toHaveLength(4); // K=4 measured successfully
  });
});

// --- drift: cross-query (perEngine) ------------------------------------------------------------

describe("runSweep — model drift across queries surfaces in perEngine", () => {
  it("an engine emitting a different model_version per query shows both versions", async () => {
    // q1 → version A; q2 → version B. Each (query,engine) group is internally consistent (no
    // drifted group), but the engine moved across the sweep → perEngine lists both.
    const versionByQueryText: Record<string, string> = { "q q1": "gpt-5", "q q2": "gpt-5.1" };
    const openai: EngineAdapter = async ({ query: text }) =>
      result("openai", false, versionByQueryText[text]!);
    const registry: EngineRegistry = { openai };

    const res = await runSweep({
      queries: [query("q1"), query("q2")],
      poolFor,
      registry,
      apiKeys: KEYS,
      ts: 0,
      budgetCeilingUSD: 1,
    });

    expect(res.status).toBe("complete");
    expect(res.drift.hasDrift).toBe(false); // no within-group mixing
    const openaiVersions = res.drift.perEngine.find((e) => e.engine === "openai")!;
    expect(openaiVersions.versions).toEqual(["gpt-5", "gpt-5.1"]);
  });
});

// --- drift: within-(query,engine) (driftedGroups) ----------------------------------------------

describe("runSweep — mid-group model drift surfaces in driftedGroups", () => {
  it("an engine that changes model_version across the K runs of one query is a drifted group", async () => {
    // The dangerous case: a single (query,engine) group spans two model_versions, exactly what
    // aggregateRuns would collapse into one polluted P_cited.
    let n = 0;
    const drifting: EngineAdapter = async () => {
      // First two runs on gpt-5, the rest on gpt-5.1 — both within the SAME (q1, openai) group.
      const version = n < 2 ? "gpt-5" : "gpt-5.1";
      n += 1;
      return result("openai", false, version);
    };
    const registry: EngineRegistry = { openai: drifting };

    const res = await runSweep({
      queries: [query("q1")],
      poolFor,
      registry,
      apiKeys: KEYS,
      ts: 0,
      budgetCeilingUSD: 1,
    });

    expect(res.drift.hasDrift).toBe(true);
    expect(res.drift.driftedGroups).toEqual([
      { query_id: "q1", engine: "openai", versions: ["gpt-5", "gpt-5.1"] },
    ]);
  });
});

// --- per-engine separation preserved end-to-end ------------------------------------------------

describe("runSweep — per-engine separation preserved end-to-end", () => {
  it("two engines on one query keep separate rows, aggregates, and perEngineK", async () => {
    const openai = neverCitedAdapter("openai");
    const perplexity = neverCitedAdapter("perplexity");
    const registry: EngineRegistry = { openai, perplexity };
    const res = await runSweep({
      queries: [query("q1", ["openai", "perplexity"])],
      poolFor,
      registry,
      apiKeys: { openai: "k", perplexity: "k" },
      ts: 0,
      budgetCeilingUSD: 1,
    });

    expect(res.status).toBe("complete");
    // Both engines resolved at K=4 independently.
    expect(openai.calls).toBe(4);
    expect(perplexity.calls).toBe(4);
    const openaiRows = res.rows.filter((r) => r.engine === "openai");
    const perpRows = res.rows.filter((r) => r.engine === "perplexity");
    expect(openaiRows).toHaveLength(4);
    expect(perpRows).toHaveLength(4);
    // One aggregate per engine (one page each) — never merged.
    expect(res.aggregates.filter((a) => a.engine === "openai")).toHaveLength(1);
    expect(res.aggregates.filter((a) => a.engine === "perplexity")).toHaveLength(1);
    expect(res.drift.perEngine.map((e) => e.engine).sort()).toEqual(["openai", "perplexity"]);
  });

  it("reserve counts only target engines that have BOTH an adapter and a key", async () => {
    // q1 targets openai + perplexity, but perplexity has NO key → only 1 runnable target engine.
    // Reserve must be worstCaseCalls(1, 8) = $0.16, NOT worstCaseCalls(2, 8) = $0.32. A ceiling
    // of 0.16 therefore clears the query (it would PAUSE under the over-count reading).
    const openai = neverCitedAdapter("openai");
    const perplexity = neverCitedAdapter("perplexity");
    const registry: EngineRegistry = { openai, perplexity };
    const res = await runSweep({
      queries: [query("q1", ["openai", "perplexity"])],
      poolFor,
      registry,
      apiKeys: { openai: "k" }, // perplexity: no key → not a runnable target
      ts: 0,
      budgetCeilingUSD: 0.16,
    });

    expect(res.status).toBe("complete");
    expect(res.coverage.completed).toEqual(["q1"]);
    expect(perplexity.calls).toBe(0); // never ran (no key)
  });
});
