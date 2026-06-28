import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { parseResponsesCitations, runOpenAIQuery } from "../../src/engines/openai";
import type { Citation } from "../../src/types";

// Real OpenAI Responses API capture (model gpt-4o-2024-08-06, web_search tool).
// The source of truth for the citation parser — see the P2 Testing standard in example.test.ts.
const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/openai-responses-web_search.json", import.meta.url), "utf8"),
);

/**
 * Count raw `url_citation` annotations (with a url) in the fixture, the way the engine
 * returned them — BEFORE de-duplication. Computed here so the dedup assertion is derived
 * from the fixture rather than hardcoded.
 */
function rawUrlCitationCount(response: any): number {
  let n = 0;
  for (const item of response?.output ?? []) {
    if (item?.type !== "message") continue;
    for (const block of item?.content ?? []) {
      if (block?.type !== "output_text") continue;
      for (const ann of block?.annotations ?? []) {
        if (ann?.type === "url_citation" && ann?.url) n++;
      }
    }
  }
  return n;
}

describe("parseResponsesCitations", () => {
  it("parses, de-dupes by raw url, and ranks citations from the real fixture", () => {
    const rawCount = rawUrlCitationCount(fixture);
    expect(rawCount).toBeGreaterThan(1); // sanity: the fixture really has annotations + a dup

    const citations = parseResponsesCitations(fixture);

    // Non-empty, and the duplicate url collapsed (fewer than the raw annotation count).
    expect(citations.length).toBeGreaterThan(0);
    expect(citations.length).toBeLessThan(rawCount);

    // Ranks are 1-based, contiguous, no gaps.
    citations.forEach((c, i) => expect(c.rank).toBe(i + 1));
    expect(citations[0]!.rank).toBe(1);

    // First cited source: domain normalized, but raw url (incl. query string) preserved.
    expect(citations[0]!.domain).toBe("seraleads.com");
    expect(citations[0]!.url).toContain("utm_source=openai");

    // Every domain is a bare host — no protocol, path, or port leaked through.
    for (const c of citations) {
      expect(c.domain).not.toContain("/");
      expect(c.domain).not.toContain(":");
      expect(c.domain).not.toMatch(/^https?/);
    }

    // No duplicate raw urls survive.
    const urls = citations.map((c) => c.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("returns [] (no throw) for an empty object", () => {
    expect(parseResponsesCitations({})).toEqual([]);
  });

  it("returns [] (no throw) for an empty output array", () => {
    expect(parseResponsesCitations({ output: [] })).toEqual([]);
  });

  it("is defensive: skips non-url_citation annotations and url-less annotations without throwing", () => {
    const handBuilt = {
      output: [
        { type: "web_search_call", action: { type: "search" } }, // not a message — skip
        {
          type: "message",
          content: [
            { type: "reasoning", text: "ignored — wrong content type" },
            {
              type: "output_text",
              text: "body",
              annotations: [
                { type: "file_citation", url: "https://nope.example.com/x" }, // wrong type — skip
                { type: "url_citation" }, // no url — skip
                { type: "url_citation", url: "" }, // empty url — skip
                { type: "url_citation", url: "https://Keep.Example.com/page?a=1", title: "Keep" }, // the only keeper
              ],
            },
            { type: "output_text" }, // missing annotations — skip, don't throw
          ],
        },
        { type: "message" }, // missing content — skip, don't throw
      ],
    };

    const citations = parseResponsesCitations(handBuilt);
    expect(citations).toHaveLength(1);
    expect(citations[0]).toEqual<Citation>({
      url: "https://Keep.Example.com/page?a=1",
      domain: "keep.example.com",
      title: "Keep",
      rank: 1,
    });
  });
});

describe("runOpenAIQuery", () => {
  it("POSTs the Responses request and maps a successful body to EngineQueryResult", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => fixture,
    }));

    const result = await runOpenAIQuery({
      query: "best AI SDR tools for B2B outbound sales 2026",
      apiKey: "sk-test-123",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.engine).toBe("openai");
    expect(result.model_version).toBe("gpt-4o-2024-08-06");
    expect(result.citations.length).toBeGreaterThan(0);
    expect(typeof result.answer_text).toBe("string");
    expect(result.answer_text.length).toBeGreaterThan(0);

    // Called exactly once, to the Responses endpoint, with the expected request shape.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchImpl.mock.calls[0]!;
    expect(calledUrl).toBe("https://api.openai.com/v1/responses");
    expect(calledInit!.method).toBe("POST");

    const headers = calledInit!.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-test-123");
    expect(headers["Content-Type"]).toBe("application/json");

    const parsedBody = JSON.parse(calledInit!.body as string);
    expect(parsedBody.model).toBe("gpt-4o"); // default applied when no model passed
    expect(parsedBody.input).toBe("best AI SDR tools for B2B outbound sales 2026");
    expect(parsedBody.tools).toEqual([{ type: "web_search" }]);
  });

  it("respects an explicit model override", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => fixture,
    }));

    await runOpenAIQuery({
      query: "q",
      apiKey: "k",
      model: "gpt-4o-mini",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const [, calledInit] = fetchImpl.mock.calls[0]!;
    const parsedBody = JSON.parse(calledInit!.body as string);
    expect(parsedBody.model).toBe("gpt-4o-mini");
  });

  it("throws an error mentioning the status on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: false,
      status: 500,
      text: async () => "boom",
    }));

    await expect(
      runOpenAIQuery({
        query: "q",
        apiKey: "k",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/500/);
  });
});
