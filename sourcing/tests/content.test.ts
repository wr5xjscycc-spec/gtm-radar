import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  extractContentFeatures,
  extractSubjectiveFeatures,
  mergeFeatures,
  enrichPage,
  buildCacheKey,
  type ContentFeatures,
  type SubjectiveFeatures,
} from "../src/content";

const SAMPLE_HTML = `<!DOCTYPE html>
<html>
<head>
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product"}</script>
</head>
<body>
  <h1>Acme Analytics — Pricing</h1>
  <h2>Compare Plans</h2>
  <h3>Starter vs Professional</h3>
  <p>Acme Analytics is the best GTM analytics platform for B2B teams. Compare our features and pricing to see why thousands of companies choose us.</p>
  <p>Published: 2026-03-15</p>
  <ul>
    <li>Feature one — included in all plans</li>
    <li>Feature two — included in Pro and above</li>
    <li>Feature three — included in Enterprise</li>
    <li>Feature four — Pro only</li>
    <li>Feature five — Enterprise only</li>
    <li>Feature six — add-on</li>
    <li>Feature seven — coming soon</li>
  </ul>
  <table>
    <tr><th>Feature</th><th>Free</th><th>Pro</th><th>Enterprise</th></tr>
    <tr><td>Seats</td><td>1</td><td>10</td><td>Unlimited</td></tr>
  </table>
</body>
</html>`;

const NO_SCHEMA_HTML = `<!DOCTYPE html><html><body><p>Plain page with no schema markup, no headings, and no tables. Just some text for testing.</p></body></html>`;

const EMPTY_HTML = "";

const LISTICLE_HTML = `<!DOCTYPE html>
<html><body>
<h1>10 Best GTM Tools</h1>
<ol>
  <li>Tool A — great for analytics</li>
  <li>Tool B — best for outreach</li>
  <li>Tool C — affordable option</li>
  <li>Tool D — enterprise grade</li>
  <li>Tool E — free tier available</li>
  <li>Tool F — AI-powered</li>
  <li>Tool G — simple UI</li>
  <li>Tool H — API-first</li>
  <li>Tool I — open source</li>
  <li>Tool J — new entrant</li>
  <li>Tool K — popular choice</li>
  <li>Tool L — under the radar</li>
</ol>
</body></html>`;

describe("extractContentFeatures", () => {
  it("detects schema markup", () => {
    const f = extractContentFeatures(SAMPLE_HTML);
    expect(f.schema_markup).toBe(true);
  });

  it("returns false when no schema markup", () => {
    const f = extractContentFeatures(NO_SCHEMA_HTML);
    expect(f.schema_markup).toBe(false);
  });

  it("detects comparison tables with comparison keywords", () => {
    const f = extractContentFeatures(SAMPLE_HTML);
    expect(f.comparison_table).toBe(true);
  });

  it("returns false for table without comparison keywords", () => {
    const html = `<!DOCTYPE html><html><body><table><tr><td>just</td><td>data</td></tr></table></body></html>`;
    const f = extractContentFeatures(html);
    expect(f.comparison_table).toBe(false);
  });

  it("counts words accurately", () => {
    const f = extractContentFeatures(SAMPLE_HTML);
    expect(f.word_count).toBeGreaterThan(30);
    expect(f.word_count).toBeLessThan(200);
  });

  it("returns 0 for empty HTML", () => {
    const f = extractContentFeatures(EMPTY_HTML);
    expect(f.word_count).toBe(0);
  });

  it("extracts heading structure", () => {
    const f = extractContentFeatures(SAMPLE_HTML);
    expect(f.heading_structure).toContain("h1:");
    expect(f.heading_structure).toContain("h2:");
    expect(f.heading_structure).toContain("h3:");
  });

  it("returns 'none' for headingless HTML", () => {
    const f = extractContentFeatures(NO_SCHEMA_HTML);
    expect(f.heading_structure).toBe("none");
  });

  it("extracts freshness_days from dates in HTML", () => {
    const f = extractContentFeatures(SAMPLE_HTML);
    expect(f.freshness_days).not.toBeNull();
    expect(f.freshness_days).toBeGreaterThanOrEqual(0);
  });

  it("returns null freshness for HTML with no dates", () => {
    const f = extractContentFeatures(NO_SCHEMA_HTML);
    expect(f.freshness_days).toBeNull();
  });

  it("computes query_term_coverage when terms provided", () => {
    const f = extractContentFeatures(SAMPLE_HTML, ["acme", "analytics", "pricing", "gtm"]);
    expect(f.query_term_coverage).not.toBeNull();
    expect(f.query_term_coverage).toBeGreaterThan(0);
    expect(f.query_term_coverage).toBeLessThanOrEqual(1);
  });

  it("returns null query_term_coverage when no terms", () => {
    const f = extractContentFeatures(SAMPLE_HTML);
    expect(f.query_term_coverage).toBeNull();
  });

  it("returns 0 query_term_coverage when no terms match", () => {
    const f = extractContentFeatures(NO_SCHEMA_HTML, ["zyxwv", "abcdefg"]);
    expect(f.query_term_coverage).toBe(0);
  });

  it("classifies listicle vs prose", () => {
    const f = extractContentFeatures(LISTICLE_HTML);
    expect(f.listicle_vs_prose).toBe("listicle");
  });

  it("classifies prose for pages with few lists", () => {
    const f = extractContentFeatures(NO_SCHEMA_HTML);
    expect(f.listicle_vs_prose).toBe("prose");
  });

  it("sets subjective fields to defaults", () => {
    const f = extractContentFeatures(SAMPLE_HTML);
    expect(f.direct_answer_first).toBe(false);
    expect(f.stats_density).toBe("none");
    expect(f.citation_density).toBe("none");
    expect(f.quote_density).toBe("none");
  });
});

describe("extractSubjectiveFeatures", () => {
  beforeEach(() => {
    vi.spyOn(global, "fetch").mockImplementation(
      async (_url: RequestInfo | URL, _init?: RequestInit) => {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    direct_answer_first: true,
                    stats_density: "medium",
                    citation_density: "low",
                    quote_density: "high",
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns parsed subjective features from OpenAI", async () => {
    const subj = await extractSubjectiveFeatures(SAMPLE_HTML, "sk-test");
    expect(subj.direct_answer_first).toBe(true);
    expect(subj.stats_density).toBe("medium");
    expect(subj.citation_density).toBe("low");
    expect(subj.quote_density).toBe("high");
  });

  it("falls back to defaults on partial response", async () => {
    vi.restoreAllMocks();
    vi.spyOn(global, "fetch").mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: JSON.stringify({
                  direct_answer_first: false,
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const subj = await extractSubjectiveFeatures(SAMPLE_HTML, "sk-test");
    expect(subj.direct_answer_first).toBe(false);
    expect(subj.stats_density).toBe("none");
    expect(subj.citation_density).toBe("none");
    expect(subj.quote_density).toBe("none");
  });

  it("strips markdown code fences", async () => {
    vi.restoreAllMocks();
    vi.spyOn(global, "fetch").mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content:
                  "```json\n" +
                  JSON.stringify({
                    direct_answer_first: true,
                    stats_density: "high",
                    citation_density: "medium",
                    quote_density: "low",
                  }) +
                  "\n```",
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const subj = await extractSubjectiveFeatures(SAMPLE_HTML, "sk-test");
    expect(subj.direct_answer_first).toBe(true);
    expect(subj.stats_density).toBe("high");
  });

  it("throws on API error", async () => {
    vi.restoreAllMocks();
    vi.spyOn(global, "fetch").mockImplementation(async () => {
      return new Response("Over quota", { status: 429 });
    });

    await expect(
      extractSubjectiveFeatures(SAMPLE_HTML, "sk-test")
    ).rejects.toThrow("OpenAI API error");
  });
});

describe("mergeFeatures", () => {
  it("overrides deterministic defaults with subjective", () => {
    const det: ContentFeatures = {
      schema_markup: true,
      comparison_table: false,
      word_count: 100,
      heading_structure: "h1:1",
      freshness_days: 5,
      query_term_coverage: 0.5,
      direct_answer_first: false,
      stats_density: "none",
      citation_density: "none",
      quote_density: "none",
      listicle_vs_prose: "prose",
    };
    const subj: SubjectiveFeatures = {
      direct_answer_first: true,
      stats_density: "high",
      citation_density: "medium",
      quote_density: "low",
    };
    const merged = mergeFeatures(det, subj);
    expect(merged.direct_answer_first).toBe(true);
    expect(merged.stats_density).toBe("high");
    expect(merged.citation_density).toBe("medium");
    expect(merged.quote_density).toBe("low");
    expect(merged.word_count).toBe(100);
    expect(merged.schema_markup).toBe(true);
  });
});

describe("buildCacheKey", () => {
  it("combines normalized URL with extractor version", () => {
    const key = buildCacheKey("https://acme.com/pricing", "extractor-v1");
    expect(key).toContain("acme.com");
    expect(key).toContain("extractor-v1");
    expect(key).toContain("::");
  });
});

describe("enrichPage", () => {
  const MOCK_HTML = `<!DOCTYPE html><html><body><h1>Test Page</h1><p>Published: 2026-06-15</p></body></html>`;
  const MOCK_OPENAI_RESPONSE = {
    choices: [
      {
        message: {
          role: "assistant",
          content: JSON.stringify({
            direct_answer_first: true,
            stats_density: "low",
            citation_density: "none",
            quote_density: "none",
          }),
        },
      },
    ],
  };

  beforeEach(() => {
    let callCount = 0;
    vi.spyOn(global, "fetch").mockImplementation(
      async (url: RequestInfo | URL) => {
        const urlStr = url.toString();
        if (urlStr.includes("api.openai.com")) {
          return new Response(JSON.stringify(MOCK_OPENAI_RESPONSE), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        callCount++;
        return new Response(MOCK_HTML, {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches HTML and returns a page record", async () => {
    const page = await enrichPage(
      "acme.com",
      "https://acme.com/test",
      "candidate",
      "sk-test"
    );
    expect(page.company_domain).toBe("acme.com");
    expect(page.url).toContain("acme.com");
    expect(page.role).toBe("candidate");
    expect(page.content_features).toBeDefined();
    expect(page.content_features.word_count).toBeGreaterThan(0);
    expect(page.content_features.schema_markup).toBe(false);
    expect(page.content_features.direct_answer_first).toBe(true);
    expect(page.extractor_version).toBeTruthy();
    expect(page.scraped_at).toBeTruthy();
    expect(page.cache_key).toBeTruthy();
  });

  it("throws on invalid URL", async () => {
    await expect(
      enrichPage("acme.com", "", "candidate", "sk-test")
    ).rejects.toThrow("Invalid URL");
  });

  it("throws on fetch failure", async () => {
    vi.restoreAllMocks();
    vi.spyOn(global, "fetch").mockImplementation(async () => {
      return new Response("Not Found", { status: 404 });
    });

    await expect(
      enrichPage("acme.com", "https://acme.com/404", "candidate", "sk-test")
    ).rejects.toThrow("Failed to fetch");
  });
});
