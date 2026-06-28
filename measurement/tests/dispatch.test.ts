import { describe, it, expect, vi, beforeEach } from "vitest";
import { dispatch, availableEngines } from "../src/dispatch";
import type { QueryRecord, DispatchContext } from "../src/dispatch";
import type { EngineAdapter, EngineResult } from "../src/engine";
import candidatePagesFixture from "./fixtures/candidate-pages.json";

const query: QueryRecord = {
  _id: "qry_best_gtm",
  workspaceId: "ws_acme",
  customer_id: "ws_acme",
  vertical: "gtm-analytics",
  text: "best GTM analytics tool for PLG SaaS",
  seed_source: "paa",
  target_engines: ["openai"],
};

const context: DispatchContext = {
  knownPages: [
    { company_domain: "acme.com", url: "https://acme.com/pricing" },
    { company_domain: "competitor.com", url: "https://competitor.com/pricing" },
  ],
  knownCompanies: [
    { domain: "acme.com" },
    { domain: "competitor.com" },
    { domain: "rival.io" },
  ],
  candidatePool: candidatePagesFixture,
};

const makeAdapter = (result: EngineResult): EngineAdapter => ({
  async measure() {
    return result;
  },
});

const errorAdapter: EngineAdapter = {
  async measure() {
    throw new Error("API failure");
  },
};

describe("availableEngines", () => {
  const originalEnv = process.env;
  beforeEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...originalEnv };
  });

  it("includes engines whose key is set", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const adapters = {
      openai: makeAdapter({} as EngineResult),
      perplexity: makeAdapter({} as EngineResult),
    };
    const keyMap: Record<string, string> = {
      openai: "OPENAI_API_KEY",
      perplexity: "PERPLEXITY_API_KEY",
    };

    const available = availableEngines(adapters, keyMap);
    expect(available.map((e) => e.name)).toEqual(["openai"]);
  });

  it("includes engines with no key-requirement", () => {
    const adapters = {
      openai: makeAdapter({} as EngineResult),
    };
    const keyMap: Record<string, string> = {};

    const available = availableEngines(adapters, keyMap);
    expect(available.map((e) => e.name)).toEqual(["openai"]);
  });
});

describe("dispatch", () => {
  const originalEnv = process.env;
  beforeEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...originalEnv };
  });

  it("dispatches to target engines and produces labeled rows", async () => {
    process.env.OPENAI_API_KEY = "sk-test";

    const mockResult: EngineResult = {
      engine: "openai",
      appeared: true,
      cited: true,
      position: 0,
      source_urls: ["https://acme.com/pricing"],
      model_version: "gpt-4o-2024-08-06",
    };

    const result = await dispatch(
      query,
      { openai: makeAdapter(mockResult) },
      { openai: "OPENAI_API_KEY" },
      context,
    );

    expect(result.coverage.succeeded).toBe(1);
    expect(result.coverage.failed).toBe(0);
    expect(result.coverage.partial).toBe(false);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].rows).toHaveLength(3); // 3 candidates
  });

  it("skips engines whose env var is not set", async () => {
    delete process.env.OPENAI_API_KEY;

    const mockResult: EngineResult = {
      engine: "openai",
      appeared: false,
      cited: false,
      position: null,
      source_urls: [],
      model_version: "gpt-4o-2024-08-06",
    };

    const result = await dispatch(
      query,
      { openai: makeAdapter(mockResult) },
      { openai: "OPENAI_API_KEY" },
      context,
    );

    expect(result.coverage.succeeded).toBe(0);
    expect(result.coverage.failed).toBe(1);
    expect(result.coverage.partial).toBe(false);
  });

  it("isolates engine failures — one failing does not kill the run", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.PERPLEXITY_API_KEY = "pplx-test";

    const q: QueryRecord = { ...query, target_engines: ["openai", "perplexity"] };

    const mockResult: EngineResult = {
      engine: "openai",
      appeared: true,
      cited: true,
      position: 0,
      source_urls: ["https://acme.com/pricing"],
      model_version: "gpt-4o-2024-08-06",
    };

    const result = await dispatch(
      q,
      {
        openai: makeAdapter(mockResult),
        perplexity: errorAdapter,
      },
      { openai: "OPENAI_API_KEY", perplexity: "PERPLEXITY_API_KEY" },
      context,
    );

    expect(result.coverage.succeeded).toBe(1);
    expect(result.coverage.failed).toBe(1);
    expect(result.coverage.partial).toBe(true);
  });

  it("skips unknown engine names in target_engines", async () => {
    process.env.OPENAI_API_KEY = "sk-test";

    const q: QueryRecord = {
      ...query,
      target_engines: ["openai", "unknown_engine"],
    };

    const mockResult: EngineResult = {
      engine: "openai",
      appeared: true,
      cited: true,
      position: 0,
      source_urls: ["https://acme.com/pricing"],
      model_version: "gpt-4o-2024-08-06",
    };

    const result = await dispatch(
      q,
      { openai: makeAdapter(mockResult) },
      { openai: "OPENAI_API_KEY" },
      context,
    );

    expect(result.coverage.succeeded).toBe(1);
    expect(result.coverage.failed).toBe(1);
    expect(result.coverage.partial).toBe(true);
  });
});
