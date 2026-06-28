import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseGeminiResponse, createGeminiAdapter } from "../src/gemini";
import type { GeminiResponse } from "../src/gemini";
import citationFixture from "./fixtures/gemini-citation.json";
import emptyFixture from "./fixtures/gemini-empty-citation.json";

describe("parseGeminiResponse", () => {
  it("extracts source URLs from grounding metadata", () => {
    const result = parseGeminiResponse(
      citationFixture as GeminiResponse,
      "hubspot.com",
    );

    expect(result.engine).toBe("gemini");
    expect(result.appeared).toBe(true);
    expect(result.cited).toBe(true);
    expect(result.position).toBe(0);
    expect(result.source_urls).toHaveLength(4);
    expect(result.source_urls[0]).toBe("https://www.hubspot.com/products/crm");
  });

  it("reports cited=false when targetDomain not cited", () => {
    const result = parseGeminiResponse(
      citationFixture as GeminiResponse,
      "zoho.com",
    );

    expect(result.cited).toBe(false);
    expect(result.position).toBeNull();
  });

  it("handles missing grounding metadata gracefully", () => {
    const result = parseGeminiResponse(
      emptyFixture as GeminiResponse,
      "hubspot.com",
    );

    expect(result.appeared).toBe(false);
    expect(result.cited).toBe(false);
    expect(result.position).toBeNull();
    expect(result.source_urls).toHaveLength(0);
  });

  it("normalizes domains for matching", () => {
    const result = parseGeminiResponse(
      citationFixture as GeminiResponse,
      "https://www.hubspot.com/blog",
    );

    expect(result.cited).toBe(true);
    expect(result.position).toBe(0);
  });

  it("finds cited domain at non-zero position", () => {
    const result = parseGeminiResponse(
      citationFixture as GeminiResponse,
      "salesforce.com",
    );

    expect(result.cited).toBe(true);
    expect(result.position).toBe(2);
  });
});

describe("createGeminiAdapter", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...originalEnv };
  });

  it("calls Gemini API and parses the result", async () => {
    process.env.GEMINI_API_KEY = "gemini-test-key";

    const mockResponse = {
      ok: true,
      json: async () => citationFixture,
      text: async () => "",
    } as Response;

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const adapter = createGeminiAdapter();
    const result = await adapter.measure("best crm for startups 2026", {
      targetDomain: "hubspot.com",
    });

    expect(result.engine).toBe("gemini");
    expect(result.cited).toBe(true);
    expect(result.source_urls).toHaveLength(4);
  });

  it("throws if GEMINI_API_KEY is not set", async () => {
    delete process.env.GEMINI_API_KEY;

    const adapter = createGeminiAdapter();
    await expect(
      adapter.measure("test", { targetDomain: "example.com" }),
    ).rejects.toThrow("GEMINI_API_KEY");
  });
});
