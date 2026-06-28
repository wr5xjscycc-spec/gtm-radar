import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseOpenAIResponse, createOpenAIAdapter } from "../src/openai";
import type { OpenAIResponsesResponse } from "../src/openai";
import citationFixture from "./fixtures/openai-citation.json";
import emptyFixture from "./fixtures/openai-empty-citation.json";

describe("parseOpenAIResponse", () => {
  it("extracts source URLs from url_citation annotations", () => {
    const result = parseOpenAIResponse(
      citationFixture as OpenAIResponsesResponse,
      "hubspot.com",
    );

    expect(result.engine).toBe("openai");
    expect(result.appeared).toBe(true);
    expect(result.cited).toBe(true);
    expect(result.position).toBe(0);
    expect(result.source_urls).toHaveLength(4);
    expect(result.source_urls[0]).toBe("https://www.hubspot.com/products/crm");
    expect(result.model_version).toBe("gpt-4o-2024-08-06");
  });

  it("reports cited=false when targetDomain is not cited", () => {
    const result = parseOpenAIResponse(
      citationFixture as OpenAIResponsesResponse,
      "zoho.com",
    );

    expect(result.appeared).toBe(true);
    expect(result.cited).toBe(false);
    expect(result.position).toBeNull();
  });

  it("handles empty annotations gracefully (not cited)", () => {
    const result = parseOpenAIResponse(
      emptyFixture as OpenAIResponsesResponse,
      "hubspot.com",
    );

    expect(result.appeared).toBe(false);
    expect(result.cited).toBe(false);
    expect(result.position).toBeNull();
    expect(result.source_urls).toHaveLength(0);
  });

  it("normalizes domains for matching (www stripped, subdomain stripped)", () => {
    const result = parseOpenAIResponse(
      citationFixture as OpenAIResponsesResponse,
      "https://www.hubspot.com/blog",
    );

    expect(result.cited).toBe(true);
    expect(result.position).toBe(0);
  });

  it("finds cited domain at non-zero position", () => {
    const result = parseOpenAIResponse(
      citationFixture as OpenAIResponsesResponse,
      "salesforce.com",
    );

    expect(result.cited).toBe(true);
    expect(result.position).toBe(2);
  });
});

describe("createOpenAIAdapter", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...originalEnv };
  });

  it("calls the Responses API and parses the result", async () => {
    process.env.OPENAI_API_KEY = "sk-test-key";

    const mockResponse = {
      ok: true,
      json: async () => citationFixture,
      text: async () => "",
    } as Response;

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const adapter = createOpenAIAdapter();
    const result = await adapter.measure("best crm for startups 2026", {
      targetDomain: "hubspot.com",
    });

    expect(result.engine).toBe("openai");
    expect(result.cited).toBe(true);
    expect(result.source_urls).toHaveLength(4);
  });

  it("throws if OPENAI_API_KEY is not set", async () => {
    delete process.env.OPENAI_API_KEY;

    const adapter = createOpenAIAdapter();
    await expect(
      adapter.measure("test query", { targetDomain: "example.com" }),
    ).rejects.toThrow("OPENAI_API_KEY");
  });

  it("throws on non-OK response", async () => {
    process.env.OPENAI_API_KEY = "sk-test-key";

    const mockResponse = {
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => '{"error": "invalid credentials"}',
    } as Response;

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const adapter = createOpenAIAdapter();
    await expect(
      adapter.measure("test query", { targetDomain: "example.com" }),
    ).rejects.toThrow("OpenAI API error: 401 Unauthorized");
  });
});
