import { describe, it, expect, vi } from "vitest";
import {
  dispatchQuery,
  DEFAULT_REGISTRY,
  type EngineAdapter,
} from "../src/dispatch";
import type { Engine, EngineQueryResult } from "../src/types";
import type { QueryRecord } from "../src/contract-records";

// The dispatch harness must NEVER call a real engine adapter or hit the network — every test
// here wires FAKE adapters (vi.fn) into the registry. See the P2 Testing standard in
// example.test.ts: NEVER call live engine APIs in CI.

type AdapterParams = Parameters<EngineAdapter>[0];

/** A canned, engine-agnostic result — what a fake adapter resolves to. */
function makeResult(engine: Engine): EngineQueryResult {
  return { engine, model_version: "fake", answer_text: "a", citations: [] };
}

/** A minimal QueryRecord; callers override `target_engines` (and anything else) per case. */
function makeQuery(
  overrides: Partial<QueryRecord> & { target_engines: Engine[] },
): QueryRecord {
  return {
    id: "q-test",
    customer_id: "cust-test",
    vertical: "b2b-sales-tech",
    text: "best AI SDR tools for B2B outbound sales 2026",
    seed_source: "paa",
    ...overrides,
  };
}

describe("DEFAULT_REGISTRY", () => {
  it("maps openai to a function (the real adapter — NOT invoked here)", () => {
    expect(typeof DEFAULT_REGISTRY.openai).toBe("function");
  });
});

describe("dispatchQuery", () => {
  it("runs a single targeted engine and forwards the call params verbatim", async () => {
    const spy = vi.fn(
      async (_params: AdapterParams): Promise<EngineQueryResult> =>
        makeResult("openai"),
    );
    const fetchImpl = (() => {}) as unknown as typeof fetch;
    const query = makeQuery({ target_engines: ["openai"], text: "q-text" });

    const out = await dispatchQuery(query, {
      apiKeys: { openai: "k" },
      registry: { openai: spy },
      model: "gpt-test",
      fetchImpl,
    });

    expect(out.results).toHaveLength(1);
    expect(out.results[0]!.engine).toBe("openai");
    expect(out.skipped).toEqual([]);
    expect(out.failures).toEqual([]);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({
      query: "q-text",
      apiKey: "k",
      model: "gpt-test",
      fetchImpl,
    });
  });

  it("isolates a per-engine failure: other engines still resolve and nothing throws", async () => {
    const okSpy = vi.fn(
      async (_params: AdapterParams): Promise<EngineQueryResult> =>
        makeResult("openai"),
    );
    const failSpy = vi.fn(async (_params: AdapterParams): Promise<EngineQueryResult> => {
      throw new Error("perplexity boom");
    });
    const query = makeQuery({ target_engines: ["openai", "perplexity"] });

    const out = await dispatchQuery(query, {
      apiKeys: { openai: "k1", perplexity: "k2" },
      registry: { openai: okSpy, perplexity: failSpy },
    });

    expect(out.results).toHaveLength(1);
    expect(out.results[0]!.engine).toBe("openai");
    expect(out.failures).toEqual([{ engine: "perplexity", error: "perplexity boom" }]);
    expect(out.skipped).toEqual([]);
    expect(okSpy).toHaveBeenCalledTimes(1);
    expect(failSpy).toHaveBeenCalledTimes(1);
  });

  it("skips an engine with no registered adapter and calls nothing", async () => {
    const spy = vi.fn(
      async (_params: AdapterParams): Promise<EngineQueryResult> =>
        makeResult("openai"),
    );
    const query = makeQuery({ target_engines: ["gemini"] });

    const out = await dispatchQuery(query, {
      apiKeys: { gemini: "k" },
      registry: { openai: spy }, // no gemini adapter
    });

    expect(out.results).toEqual([]);
    expect(out.skipped).toEqual([{ engine: "gemini", reason: "no adapter registered" }]);
    expect(out.failures).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("skips an engine that has an adapter but no api key, without calling it", async () => {
    const spy = vi.fn(
      async (_params: AdapterParams): Promise<EngineQueryResult> =>
        makeResult("openai"),
    );
    const query = makeQuery({ target_engines: ["openai"] });

    const out = await dispatchQuery(query, {
      apiKeys: {}, // no key for openai
      registry: { openai: spy },
    });

    expect(out.results).toEqual([]);
    expect(out.skipped).toEqual([{ engine: "openai", reason: "no api key" }]);
    expect(out.failures).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("treats an empty-string api key as missing", async () => {
    const spy = vi.fn(
      async (_params: AdapterParams): Promise<EngineQueryResult> =>
        makeResult("openai"),
    );
    const query = makeQuery({ target_engines: ["openai"] });

    const out = await dispatchQuery(query, {
      apiKeys: { openai: "" }, // present but empty ⇒ unusable
      registry: { openai: spy },
    });

    expect(out.skipped).toEqual([{ engine: "openai", reason: "no api key" }]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("orders results by target_engines order regardless of resolution timing", async () => {
    // openai resolves AFTER perplexity, but must still appear first (target_engines order).
    const slowOpenAI = vi.fn(async (_params: AdapterParams): Promise<EngineQueryResult> => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return makeResult("openai");
    });
    const fastPerplexity = vi.fn(
      async (_params: AdapterParams): Promise<EngineQueryResult> =>
        makeResult("perplexity"),
    );
    const query = makeQuery({ target_engines: ["openai", "perplexity"] });

    const out = await dispatchQuery(query, {
      apiKeys: { openai: "k1", perplexity: "k2" },
      registry: { openai: slowOpenAI, perplexity: fastPerplexity },
    });

    expect(out.results.map((r) => r.engine)).toEqual(["openai", "perplexity"]);
  });

  it("defaults to DEFAULT_REGISTRY when no registry is supplied (no key ⇒ skipped, real adapter NOT called)", async () => {
    const query = makeQuery({ target_engines: ["openai"] });

    // No registry override and no api key: openai is skipped for "no api key",
    // so DEFAULT_REGISTRY.openai (the real network adapter) is never invoked.
    const out = await dispatchQuery(query, { apiKeys: {} });

    expect(out.results).toEqual([]);
    expect(out.skipped).toEqual([{ engine: "openai", reason: "no api key" }]);
    expect(out.failures).toEqual([]);
  });
});
