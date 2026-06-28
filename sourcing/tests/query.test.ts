import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateQuerySet, QUERY_VERSION } from "../src/query";

function makeResponsesApiResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      id: "resp_test",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function makeChatResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content } }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

describe("generateQuerySet", () => {
  beforeEach(() => {
    vi.spyOn(global, "fetch").mockImplementation(
      async (url: RequestInfo | URL) => {
        const urlStr = url.toString();
        if (urlStr.includes("/responses")) {
          return makeResponsesApiResponse(
            JSON.stringify([
              "best gtm analytics platform 2026",
              "how to measure sales pipeline velocity",
              "what is revenue intelligence software",
              "salesforce vs hubspot for enterprise",
              "gtm analytics tools comparison",
              "b2b sales attribution models",
              "how to calculate cac payback period",
              "open source gtm tools",
              "ai for sales forecasting",
              "lead scoring best practices",
            ])
          );
        }
        return makeChatResponse(
          JSON.stringify([
            "gtm analytics for small business pricing",
            "how to track multi-channel attribution",
            "best free gtm analytics tools",
            "revenue intelligence vs crm",
            "gtm analytics implementation guide",
            "sales pipeline coverage ratio benchmark",
          ])
        );
      }
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns query records from web search", async () => {
    const queries = await generateQuerySet("GTM analytics", "cust-1", "sk-test");
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) {
      expect(q.customer_id).toBe("cust-1");
      expect(q.vertical).toBe("GTM analytics");
      expect(q.text).toBeTruthy();
      expect(q.text.length).toBeGreaterThan(5);
      expect(q.target_engines).toEqual(["openai"]);
    }
  });

  it("tags seed queries as keyword and expansions as llm_expand", async () => {
    const queries = await generateQuerySet("GTM analytics", "cust-1", "sk-test");
    const keywords = queries.filter((q) => q.seed_source === "keyword");
    const expands = queries.filter((q) => q.seed_source === "llm_expand");
    expect(keywords.length).toBeGreaterThan(0);
    expect(expands.length).toBeGreaterThan(0);
  });

  it("generates unique IDs per query", async () => {
    const queries = await generateQuerySet("CRM", "cust-2", "sk-test");
    const ids = queries.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("returns at least 5 total queries", async () => {
    const queries = await generateQuerySet("CRM", "cust-1", "sk-test");
    expect(queries.length).toBeGreaterThanOrEqual(5);
  });

  it("handles empty response from web search gracefully", async () => {
    vi.restoreAllMocks();
    vi.spyOn(global, "fetch").mockImplementation(
      async (url: RequestInfo | URL) => {
        const urlStr = url.toString();
        if (urlStr.includes("/responses")) {
          return makeResponsesApiResponse("[]");
        }
        return makeChatResponse("[]");
      }
    );

    const queries = await generateQuerySet("CRM", "cust-1", "sk-test");
    expect(queries).toEqual([]);
  });

  it("throws without API key", async () => {
    await expect(
      generateQuerySet("CRM", "cust-1", "")
    ).rejects.toThrow("OPENAI_API_KEY");
  });

  it("throws on API error", async () => {
    vi.restoreAllMocks();
    vi.spyOn(global, "fetch").mockImplementation(async () => {
      return new Response("Unauthorized", { status: 401 });
    });

    await expect(
      generateQuerySet("CRM", "cust-1", "sk-test")
    ).rejects.toThrow("OpenAI Responses API error");
  });
});
