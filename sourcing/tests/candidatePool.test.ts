import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  sourceCandidatePool,
  sourceCandidatePools,
  CANDIDATE_POOL_VERSION,
  type CandidatePoolItem,
} from "../src/candidatePool";
import { normalizeDomain, normalizeUrl } from "../../convex/lib/domain";

function makeResponsesResponse(
  text: string,
  annotationUrls?: string[]
): Response {
  const annotations = annotationUrls
    ? annotationUrls.map((url) => ({ type: "url_citation", url }))
    : [];
  return new Response(
    JSON.stringify({
      id: "resp_candidate_test",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text,
              annotations,
            },
          ],
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

describe("sourceCandidatePool", () => {
  beforeEach(() => {
    vi.spyOn(global, "fetch").mockImplementation(async () => {
      return makeResponsesResponse(
        "Here are the search results for 'best GTM analytics tools':\n\n" +
          "URL: https://www.acme.com/gtm-analytics\n" +
          "URL: https://rival.io/pricing\n" +
          "URL: https://competitor.com/features\n" +
          "URL: https://another-tool.com\n" +
          "URL: https://startup.io\n" +
          "URL: https://bigvendor.com/analytics\n" +
          "URL: https://opensource-tool.org\n" +
          "URL: https://newsite.co/blog/gtm-tools",
        [
          "https://www.acme.com/gtm-analytics",
          "https://rival.io/pricing",
          "https://competitor.com/features",
          "https://another-tool.com",
          "https://startup.io",
          "https://bigvendor.com/analytics",
          "https://opensource-tool.org",
          "https://newsite.co/blog/gtm-tools",
        ]
      );
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns candidate pool items for a query", async () => {
    const items = await sourceCandidatePool(
      "best GTM analytics tools",
      "sk-test"
    );
    expect(items.length).toBeGreaterThanOrEqual(3);
    for (const item of items) {
      expect(item.company_domain).toBeTruthy();
      expect(item.page_url).toBeTruthy();
    }
  });

  it("normalizes every company_domain", async () => {
    const items = await sourceCandidatePool(
      "best GTM analytics tools",
      "sk-test"
    );
    for (const item of items) {
      expect(item.company_domain).toBe(
        normalizeDomain(item.company_domain)
      );
    }
  });

  it("normalizes every page_url", async () => {
    const items = await sourceCandidatePool(
      "best GTM analytics tools",
      "sk-test"
    );
    for (const item of items) {
      expect(item.page_url).toBe(normalizeUrl(item.page_url));
    }
  });

  it("matches CandidatePoolItem interface exactly", async () => {
    const items = await sourceCandidatePool(
      "best GTM analytics tools",
      "sk-test"
    );
    for (const item of items) {
      const keys = Object.keys(item).sort();
      expect(keys).toEqual(["company_domain", "page_url"]);
    }
  });

  it("deduplicates by normalized URL", async () => {
    const items = await sourceCandidatePool(
      "best GTM analytics tools",
      "sk-test"
    );
    const urls = items.map((i) => i.page_url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("removes www prefix from company_domain", async () => {
    const items = await sourceCandidatePool(
      "best GTM analytics tools",
      "sk-test"
    );
    for (const item of items) {
      expect(item.company_domain).not.toMatch(/^www\./);
    }
  });

  it("throws without API key", async () => {
    await expect(
      sourceCandidatePool("GTM tools", "")
    ).rejects.toThrow("OPENAI_API_KEY");
  });

  it("throws on API error", async () => {
    vi.restoreAllMocks();
    vi.spyOn(global, "fetch").mockImplementation(async () => {
      return new Response("Unauthorized", { status: 401 });
    });

    await expect(
      sourceCandidatePool("GTM tools", "sk-test")
    ).rejects.toThrow("OpenAI Responses API error");
  });

  it("handles empty search results", async () => {
    vi.restoreAllMocks();
    vi.spyOn(global, "fetch").mockImplementation(async () => {
      return makeResponsesResponse("No results found.", []);
    });

    const items = await sourceCandidatePool(
      "obscure query with no results",
      "sk-test"
    );
    expect(items).toEqual([]);
  });
});

describe("sourceCandidatePools", () => {
  let callCount = 0;
  const QUERY_SETS: Record<string, string[]> = {
    "best GTM analytics tools": [
      "https://acme.com/gtm",
      "https://rival.io",
      "https://competitor.com",
    ],
    "revenue intelligence platforms": [
      "https://revenue-ai.com",
      "https://acme.com/gtm",
      "https://another-vendor.com",
    ],
  };

  beforeEach(() => {
    callCount = 0;
    vi.spyOn(global, "fetch").mockImplementation(async () => {
      const queries = Object.keys(QUERY_SETS);
      const urls = QUERY_SETS[queries[callCount % queries.length]] || [];
      callCount++;
      const text = urls.map((u) => `URL: ${u}`).join("\n");
      return makeResponsesResponse(text, urls);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("merges candidate pools across queries, deduplicating by URL", async () => {
    const queries = [
      { text: "best GTM analytics tools" },
      { text: "revenue intelligence platforms" },
    ];
    const items = await sourceCandidatePools(queries, "sk-test");

    const acmeItems = items.filter((i) =>
      i.page_url.includes("acme.com")
    );
    expect(acmeItems.length).toBe(1);

    const urls = items.map((i) => i.page_url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("strips www from all domains after dedup", async () => {
    const items = await sourceCandidatePools(
      [{ text: "best GTM analytics tools" }],
      "sk-test"
    );
    for (const item of items) {
      expect(item.company_domain).not.toMatch(/^www\./);
    }
  });
});
