import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { gatherOffpageSignals } from "../src/offpage";

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

describe("gatherOffpageSignals", () => {
  beforeEach(() => {
    vi.spyOn(global, "fetch").mockImplementation(
      async (_url: RequestInfo | URL, _init?: RequestInit) => {
        return makeResponsesApiResponse(
          JSON.stringify({
            reddit_presence: 12,
            g2_presence: 1,
            wikipedia_presence: 1,
            review_site_presence: 3,
            thirdparty_mentions: 45,
            entity_cooccurrence: 8,
          })
        );
      }
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns offpage signals from OpenAI web search", async () => {
    const result = await gatherOffpageSignals(
      "Acme Analytics",
      "acme.com",
      "sk-test"
    );
    expect(result.offpage.reddit_presence).toBe(12);
    expect(result.offpage.g2_presence).toBe(1);
    expect(result.offpage.wikipedia_presence).toBe(1);
    expect(result.offpage.review_site_presence).toBe(3);
    expect(result.offpage.thirdparty_mentions).toBe(45);
    expect(result.offpage.entity_cooccurrence).toBe(8);
  });

  it("adds coverage_flags for SERP-only fields", async () => {
    const result = await gatherOffpageSignals(
      "Acme Analytics",
      "acme.com",
      "sk-test"
    );
    expect(result.coverage_flags.length).toBeGreaterThan(0);
    expect(
      result.coverage_flags.some((f) => f.includes("brand_search_volume"))
    ).toBe(true);
    expect(
      result.coverage_flags.some((f) => f.includes("backlink_density"))
    ).toBe(true);
  });

  it("stamps source_versions", async () => {
    const result = await gatherOffpageSignals(
      "Acme Analytics",
      "acme.com",
      "sk-test"
    );
    expect(result.source_versions.offpage_gathering).toBeTruthy();
    expect(result.source_versions.offpage_gathering).toContain("offpage-");
  });

  it("sets null for brand_search_volume and backlink_density", async () => {
    const result = await gatherOffpageSignals(
      "Acme Analytics",
      "acme.com",
      "sk-test"
    );
    expect(result.offpage.brand_search_volume).toBeUndefined();
    expect(result.offpage.backlink_density).toBeUndefined();
  });

  it("handles zero values from OpenAI response", async () => {
    vi.restoreAllMocks();
    vi.spyOn(global, "fetch").mockImplementation(async () => {
      return makeResponsesApiResponse(
        JSON.stringify({
          reddit_presence: 0,
          g2_presence: 0,
          wikipedia_presence: 0,
          review_site_presence: 0,
          thirdparty_mentions: 0,
          entity_cooccurrence: 0,
        })
      );
    });

    const result = await gatherOffpageSignals(
      "Unknown Startup",
      "unknown.io",
      "sk-test"
    );
    expect(result.offpage.reddit_presence).toBe(0);
    expect(result.offpage.g2_presence).toBe(0);
  });

  it("gracefully handles missing fields in response", async () => {
    vi.restoreAllMocks();
    vi.spyOn(global, "fetch").mockImplementation(async () => {
      return makeResponsesApiResponse(
        JSON.stringify({ reddit_presence: 5 })
      );
    });

    const result = await gatherOffpageSignals(
      "Some Company",
      "some.co",
      "sk-test"
    );
    expect(result.offpage.reddit_presence).toBe(5);
    expect(result.offpage.g2_presence).toBe(0);
    expect(result.offpage.wikipedia_presence).toBe(0);
    expect(result.offpage.review_site_presence).toBe(0);
    expect(result.offpage.thirdparty_mentions).toBe(0);
  });

  it("strips markdown code fences from response", async () => {
    vi.restoreAllMocks();
    vi.spyOn(global, "fetch").mockImplementation(async () => {
      return makeResponsesApiResponse(
        "```json\n" +
          JSON.stringify({
            reddit_presence: 3,
            g2_presence: 1,
            wikipedia_presence: 0,
            review_site_presence: 2,
            thirdparty_mentions: 10,
            entity_cooccurrence: 4,
          }) +
          "\n```"
      );
    });

    const result = await gatherOffpageSignals(
      "Test Co",
      "test.co",
      "sk-test"
    );
    expect(result.offpage.reddit_presence).toBe(3);
  });

  it("throws without API key", async () => {
    await expect(
      gatherOffpageSignals("Acme", "acme.com", "")
    ).rejects.toThrow("OPENAI_API_KEY");
  });

  it("throws on API error", async () => {
    vi.restoreAllMocks();
    vi.spyOn(global, "fetch").mockImplementation(async () => {
      return new Response("Rate limited", { status: 429 });
    });

    await expect(
      gatherOffpageSignals("Acme", "acme.com", "sk-test")
    ).rejects.toThrow("OpenAI Responses API error");
  });

  it("throws when response has no message output", async () => {
    vi.restoreAllMocks();
    vi.spyOn(global, "fetch").mockImplementation(async () => {
      return new Response(
        JSON.stringify({ id: "resp_test", output: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    await expect(
      gatherOffpageSignals("Acme", "acme.com", "sk-test")
    ).rejects.toThrow("OpenAI Responses API returned no message content");
  });
});
