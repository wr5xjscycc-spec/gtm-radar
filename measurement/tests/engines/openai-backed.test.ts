import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runOpenAIQuery } from "../../src/engines/openai";
import {
  ENGINE_MODELS,
  makeOpenAIBackedAdapter,
  buildOpenAIBackedRegistry,
  spreadOpenAIKey,
} from "../../src/engines/openai-backed";
import type { Engine } from "../../src/types";

// Same captured OpenAI Responses fixture the direct adapter's test uses (model
// gpt-4o-2024-08-06, web_search tool). Reusing it is the whole point: the OpenAI-backed
// stand-ins go through the SAME parser as the real adapter, so their parsed output must
// match the direct adapter's byte-for-byte — only the engine LABEL differs.
const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/openai-responses-web_search.json", import.meta.url), "utf8"),
);

/** The REAL model id the fixture's API response carries — distinct from any bound model id. */
const REAL_MODEL_VERSION = "gpt-4o-2024-08-06";

/** A fake fetch that always returns the captured fixture (never hits the network). */
function fakeFetch() {
  return vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok: true,
    status: 200,
    json: async () => fixture,
  })) as unknown as typeof fetch;
}

describe("ENGINE_MODELS", () => {
  it("binds a DIFFERENT OpenAI model to each engine slot so the numbers diverge", () => {
    expect(ENGINE_MODELS).toEqual<Record<Engine, string>>({
      openai: "gpt-5",
      perplexity: "gpt-5-mini",
      gemini: "gpt-5-nano",
    });
  });
});

describe("makeOpenAIBackedAdapter", () => {
  it("OVERRIDES the engine label (perplexity), never leaving it 'openai'", async () => {
    const adapter = makeOpenAIBackedAdapter({ engine: "perplexity", model: "gpt-5-mini" });
    const result = await adapter({ query: "q", apiKey: "k", fetchImpl: fakeFetch() });

    expect(result.engine).toBe("perplexity");
    expect(result.engine).not.toBe("openai");
  });

  it("OVERRIDES the engine label (gemini)", async () => {
    const adapter = makeOpenAIBackedAdapter({ engine: "gemini", model: "gpt-5-nano" });
    const result = await adapter({ query: "q", apiKey: "k", fetchImpl: fakeFetch() });

    expect(result.engine).toBe("gemini");
  });

  it("keeps model_version as the REAL response value, NOT the bound model id", async () => {
    const adapter = makeOpenAIBackedAdapter({ engine: "perplexity", model: "gpt-5-mini" });
    const result = await adapter({ query: "q", apiKey: "k", fetchImpl: fakeFetch() });

    // The stand-in is self-evident in the data: model_version is the genuine OpenAI model
    // the API returned, NOT the slot's bound id. Drift detection therefore stays real.
    expect(result.model_version).toBe(REAL_MODEL_VERSION);
    expect(result.model_version).not.toBe("gpt-5-mini");
  });

  it("binds the model: passes opts.model down to runOpenAIQuery's request body", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => fixture,
    }));

    const adapter = makeOpenAIBackedAdapter({ engine: "gemini", model: "gpt-5-nano" });
    await adapter({ query: "q", apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });

    const [, calledInit] = fetchImpl.mock.calls[0]!;
    const parsedBody = JSON.parse(calledInit!.body as string);
    expect(parsedBody.model).toBe("gpt-5-nano");
  });

  it("parses citations IDENTICALLY to the direct adapter (same fixture → same citations)", async () => {
    const direct = await runOpenAIQuery({ query: "q", apiKey: "k", fetchImpl: fakeFetch() });

    const adapter = makeOpenAIBackedAdapter({ engine: "perplexity", model: "gpt-5-mini" });
    const backed = await adapter({ query: "q", apiKey: "k", fetchImpl: fakeFetch() });

    // Only the engine label is allowed to differ; everything parsed is identical.
    expect(backed.citations).toEqual(direct.citations);
    expect(backed.answer_text).toBe(direct.answer_text);
    expect(backed.model_version).toBe(direct.model_version);
    expect(backed.citations.length).toBeGreaterThan(0);
  });
});

describe("buildOpenAIBackedRegistry", () => {
  it("wires all three engine slots, each callable with its bound model", async () => {
    const registry = buildOpenAIBackedRegistry();

    expect(Object.keys(registry).sort()).toEqual(["gemini", "openai", "perplexity"]);

    for (const engine of ["openai", "perplexity", "gemini"] as Engine[]) {
      const adapter = registry[engine];
      expect(adapter).toBeTypeOf("function");
      const result = await adapter!({ query: "q", apiKey: "k", fetchImpl: fakeFetch() });
      // The slot's adapter stamps its own engine label.
      expect(result.engine).toBe(engine);
      // …while model_version stays the real response value across all three slots.
      expect(result.model_version).toBe(REAL_MODEL_VERSION);
    }
  });

  it("binds the slot's ENGINE_MODELS id into each adapter's request", async () => {
    const registry = buildOpenAIBackedRegistry();

    for (const engine of ["openai", "perplexity", "gemini"] as Engine[]) {
      const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => ({
        ok: true,
        status: 200,
        json: async () => fixture,
      }));
      await registry[engine]!({
        query: "q",
        apiKey: "k",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const [, calledInit] = fetchImpl.mock.calls[0]!;
      const parsedBody = JSON.parse(calledInit!.body as string);
      expect(parsedBody.model).toBe(ENGINE_MODELS[engine]);
    }
  });
});

describe("spreadOpenAIKey", () => {
  it("spreads one key across all three engine slots", () => {
    expect(spreadOpenAIKey("k")).toEqual({ openai: "k", perplexity: "k", gemini: "k" });
  });
});
