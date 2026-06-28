import { describe, it, expect } from "vitest";
import { parseOpenAIResponse } from "../src/openai";
import { parsePerplexityResponse } from "../src/perplexity";
import { parseGeminiResponse } from "../src/gemini";
import type { OpenAIResponsesResponse } from "../src/openai";
import type { PerplexityResponse } from "../src/perplexity";
import type { GeminiResponse } from "../src/gemini";
import openaiFixture from "./fixtures/openai-citation.json";
import perplexityFixture from "./fixtures/perplexity-citation.json";
import geminiFixture from "./fixtures/gemini-citation.json";

describe("interface conformance — all engines return the same normalized shape", () => {
  const TARGET = "hubspot.com";

  const results = {
    openai: parseOpenAIResponse(openaiFixture as OpenAIResponsesResponse, TARGET),
    perplexity: parsePerplexityResponse(
      perplexityFixture as PerplexityResponse,
      TARGET,
    ),
    gemini: parseGeminiResponse(geminiFixture as GeminiResponse, TARGET),
  };

  for (const [engine, result] of Object.entries(results)) {
    it(`${engine} has all required fields`, () => {
      expect(result).toHaveProperty("engine");
      expect(result).toHaveProperty("appeared");
      expect(result).toHaveProperty("cited");
      expect(result).toHaveProperty("position");
      expect(result).toHaveProperty("source_urls");
      expect(result).toHaveProperty("model_version");
    });

    it(`${engine} returns correct field types`, () => {
      expect(typeof result.engine).toBe("string");
      expect(typeof result.appeared).toBe("boolean");
      expect(typeof result.cited).toBe("boolean");
      expect(result.position === null || typeof result.position === "number").toBe(
        true,
      );
      expect(Array.isArray(result.source_urls)).toBe(true);
      expect(typeof result.model_version).toBe("string");
    });

    it(`${engine} correctly identifies cited target`, () => {
      expect(result.cited).toBe(true);
      expect(result.position).toBe(0);
    });

    it(`${engine} returns 4 source URLs`, () => {
      expect(result.source_urls).toHaveLength(4);
    });
  }
});
