import { describe, it, expect, vi, beforeEach } from "vitest";
import { parsePerplexityResponse, createPerplexityAdapter } from "../src/perplexity";
import type { PerplexityResponse } from "../src/perplexity";
import citationFixture from "./fixtures/perplexity-citation.json";
import emptyFixture from "./fixtures/perplexity-empty-citation.json";

describe("parsePerplexityResponse", () => {
  it("extracts source URLs from citations array", () => {
    const result = parsePerplexityResponse(
      citationFixture as PerplexityResponse,
      "hubspot.com",
    );

    expect(result.engine).toBe("perplexity");
    expect(result.appeared).toBe(true);
    expect(result.cited).toBe(true);
    expect(result.position).toBe(0);
    expect(result.source_urls).toHaveLength(4);
    expect(result.source_urls[0]).toBe("https://www.hubspot.com/products/crm");
    expect(result.model_version).toBe("sonar");
  });

  it("reports cited=false when targetDomain not cited", () => {
    const result = parsePerplexityResponse(
      citationFixture as PerplexityResponse,
      "zoho.com",
    );

    expect(result.cited).toBe(false);
    expect(result.position).toBeNull();
  });

  it("handles empty citations gracefully", () => {
    const result = parsePerplexityResponse(
      emptyFixture as PerplexityResponse,
      "hubspot.com",
    );

    expect(result.appeared).toBe(false);
    expect(result.cited).toBe(false);
    expect(result.position).toBeNull();
    expect(result.source_urls).toHaveLength(0);
  });

  it("normalizes domains for matching", () => {
    const result = parsePerplexityResponse(
      citationFixture as PerplexityResponse,
      "https://www.hubspot.com/blog",
    );

    expect(result.cited).toBe(true);
    expect(result.position).toBe(0);
  });

  it("finds cited domain at non-zero position", () => {
    const result = parsePerplexityResponse(
      citationFixture as PerplexityResponse,
      "salesforce.com",
    );

    expect(result.cited).toBe(true);
    expect(result.position).toBe(2);
  });
});

describe("createPerplexityAdapter", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...originalEnv };
  });

  it("calls Perplexity API and parses the result", async () => {
    process.env.PERPLEXITY_API_KEY = "pplx-test-key";

    const mockResponse = {
      ok: true,
      json: async () => citationFixture,
      text: async () => "",
    } as Response;

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const adapter = createPerplexityAdapter();
    const result = await adapter.measure("best crm for startups 2026", {
      targetDomain: "hubspot.com",
    });

    expect(result.engine).toBe("perplexity");
    expect(result.cited).toBe(true);
    expect(result.source_urls).toHaveLength(4);
  });

  it("throws if PERPLEXITY_API_KEY is not set", async () => {
    delete process.env.PERPLEXITY_API_KEY;

    const adapter = createPerplexityAdapter();
    await expect(
      adapter.measure("test", { targetDomain: "example.com" }),
    ).rejects.toThrow("PERPLEXITY_API_KEY");
  });
});
