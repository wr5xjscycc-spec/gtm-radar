// P3 · Phase 2 required test: Orange Slice page-feature mapping tests (fixtures).
//
// Proves the content-enrichment pass end-to-end inside the lane with NO live
// vendor call — the OrangeSliceClient port and the gpt-4o-mini ChatModel port are
// both mocked (docs/TESTING.md rule 1). Inline HTML fixtures keep it self-contained.

import { describe, it, expect } from "vitest";

import {
  enrichPages,
  contentHash,
  normalizeUrl,
  type OrangeSliceClient,
  type OrangeSlicePage,
} from "../src/content";
import { CONTENT_EXTRACTOR_VERSION } from "../src/features";
import type { ChatModel } from "../src/understanding";

const NOW = "2026-06-27T00:00:00Z";

/** A page with structured data, a comparison table, and a modified-time meta. */
const RICH_PAGE: OrangeSlicePage = {
  url: "https://www.Example.com/best-crm/",
  lastModified: "2026-06-20T00:00:00Z",
  html: `
    <html><head>
      <script type="application/ld+json">{"@type":"Article"}</script>
      <meta property="article:modified_time" content="2026-06-20T00:00:00Z">
    </head><body>
      <h1>Best CRM</h1><h2>Compare</h2>
      <table>
        <thead><tr><th>Feature</th><th>Us</th><th>Them</th></tr></thead>
        <tbody>
          <tr><td>Price</td><td>$1</td><td>$2</td></tr>
          <tr><td>API</td><td>Yes</td><td>No</td></tr>
        </tbody>
      </table>
      <p>The best CRM for sales teams who want pipeline visibility.</p>
    </body></html>`,
};

/** A plain page, no markup, no table. */
const PLAIN_PAGE: OrangeSlicePage = {
  url: "https://example.com/about",
  html: `<html><body><h1>About</h1><p>We make software for teams.</p></body></html>`,
};

function mockOrange(pages: OrangeSlicePage[]): {
  client: OrangeSliceClient;
  calls: { domain: string; limit?: number }[];
} {
  const calls: { domain: string; limit?: number }[] = [];
  const client: OrangeSliceClient = {
    async scrapeCandidatePages(args) {
      calls.push(args);
      return pages;
    },
  };
  return { client, calls };
}

/** A ChatModel mock returning a fixed strict-JSON subjective vector. */
const GOOD_SUBJECTIVE = JSON.stringify({
  direct_answer_first: true,
  stats_density: 4.2,
  citation_density: 1.5,
  quote_density: 0,
  listicle_vs_prose: 0.5,
});

function mockModel(reply: string): { model: ChatModel; calls: { system: string; user: string }[] } {
  const calls: { system: string; user: string }[] = [];
  const model: ChatModel = {
    async complete(args) {
      calls.push(args);
      return reply;
    },
  };
  return { model, calls };
}

describe("normalizeUrl", () => {
  it("lowercases host, strips www + trailing slash + fragment, keeps path", () => {
    expect(normalizeUrl("https://www.Example.com/Best-CRM/#top")).toBe(
      "https://example.com/Best-CRM",
    );
  });

  it("adds a scheme when missing", () => {
    expect(normalizeUrl("example.com/x")).toBe("https://example.com/x");
  });
});

describe("Orange Slice page-feature mapping (mocked vendors)", () => {
  it("normalizes company_domain (FK) and url (key)", async () => {
    const { client } = mockOrange([RICH_PAGE]);
    const pages = await enrichPages(client, { companyDomain: "https://www.Example.com/", now: NOW });
    expect(pages).toHaveLength(1);
    expect(pages[0].company_domain).toBe("example.com");
    expect(pages[0].url).toBe("https://example.com/best-crm");
  });

  it("forwards the normalized domain + limit to Orange Slice", async () => {
    const { client, calls } = mockOrange([RICH_PAGE]);
    await enrichPages(client, { companyDomain: "WWW.Example.com", now: NOW, limit: 5 });
    expect(calls[0]).toEqual({ domain: "example.com", limit: 5 });
  });

  it("produces the FULL deterministic vector even with NO model", async () => {
    const { client } = mockOrange([RICH_PAGE]);
    const pages = await enrichPages(client, {
      companyDomain: "example.com",
      now: NOW,
      queryTerms: ["crm", "pipeline", "kanban"],
    });
    const f = pages[0].content_features;
    // deterministic family present and correct
    expect(f.schema_markup).toBe(true);
    expect(f.comparison_table).toBe(true);
    expect(f.heading_structure).toBe(2); // h1=1 + h2=1 + h3=0
    expect(f.word_count).toBeGreaterThan(0);
    expect(f.freshness_days).toBe(7);
    expect(f.query_term_coverage).toBeCloseTo(2 / 3, 5);
    // subjective fields OMITTED when no model supplied
    expect(f.direct_answer_first).toBeUndefined();
    expect(f.stats_density).toBeUndefined();
    expect(f.listicle_vs_prose).toBeUndefined();
  });

  it("merges subjective fields when a model is supplied", async () => {
    const { client } = mockOrange([RICH_PAGE]);
    const { model } = mockModel(GOOD_SUBJECTIVE);
    const pages = await enrichPages(client, { companyDomain: "example.com", now: NOW, model });
    const f = pages[0].content_features;
    // deterministic still present...
    expect(f.schema_markup).toBe(true);
    expect(f.word_count).toBeGreaterThan(0);
    // ...plus the subjective vector
    expect(f.direct_answer_first).toBe(true);
    expect(f.stats_density).toBe(4.2);
    expect(f.citation_density).toBe(1.5);
    expect(f.quote_density).toBe(0);
    expect(f.listicle_vs_prose).toBe(0.5);
  });

  it("keeps the deterministic vector when the model reply is unparseable", async () => {
    const { client } = mockOrange([PLAIN_PAGE]);
    const { model } = mockModel("sorry, I can't do that");
    const pages = await enrichPages(client, { companyDomain: "example.com", now: NOW, model });
    const f = pages[0].content_features;
    expect(f.word_count).toBeGreaterThan(0); // deterministic stands
    expect(f.direct_answer_first).toBeUndefined(); // subjective gracefully omitted
  });

  it("stamps the injected scraped_at (not Date.now)", async () => {
    const { client } = mockOrange([RICH_PAGE]);
    const { model } = mockModel(GOOD_SUBJECTIVE);
    const pages = await enrichPages(client, { companyDomain: "example.com", now: NOW, model });
    expect(pages[0].scraped_at).toBe(Date.parse(NOW));
  });

  it("encodes the subjective state in extractor_version (honest + cache-safe)", async () => {
    const { client } = mockOrange([RICH_PAGE]);
    // no model → deterministic-only, base version
    const none = await enrichPages(client, { companyDomain: "example.com", now: NOW });
    expect(none[0].extractor_version).toBe(CONTENT_EXTRACTOR_VERSION);
    // model succeeds → +subj
    const ok = await enrichPages(client, {
      companyDomain: "example.com",
      now: NOW,
      model: mockModel(GOOD_SUBJECTIVE).model,
    });
    expect(ok[0].extractor_version).toBe(`${CONTENT_EXTRACTOR_VERSION}+subj`);
    // model called but fails → +subj-err (distinct from "no model")
    const failed = await enrichPages(client, {
      companyDomain: "example.com",
      now: NOW,
      model: mockModel("not json").model,
    });
    expect(failed[0].extractor_version).toBe(`${CONTENT_EXTRACTOR_VERSION}+subj-err`);
    // the three states produce three DISTINCT cache keys for identical HTML
    const keys = new Set([none[0].cache_key, ok[0].cache_key, failed[0].cache_key]);
    expect(keys.size).toBe(3);
  });

  it("defaults role to candidate but honors an explicit page role", async () => {
    const explicit: OrangeSlicePage = { ...PLAIN_PAGE, url: "https://example.com/x", role: "competitor" };
    const { client } = mockOrange([RICH_PAGE, explicit]);
    const pages = await enrichPages(client, { companyDomain: "example.com", now: NOW });
    expect(pages[0].role).toBe("candidate");
    expect(pages[1].role).toBe("competitor");
  });

  it("builds a deterministic cache_key (domain + content hash + queryTerms hash + extractor_version)", async () => {
    const { client } = mockOrange([RICH_PAGE]);
    const a = await enrichPages(client, { companyDomain: "example.com", now: NOW });
    const b = await enrichPages(client, { companyDomain: "example.com", now: "2099-01-01T00:00:00Z" });
    const expected = `example.com|${contentHash(RICH_PAGE.html)}|noqt|${CONTENT_EXTRACTOR_VERSION}`;
    expect(a[0].cache_key).toBe(expected);
    // cache_key is content-derived, so it's stable across runs/timestamps
    expect(b[0].cache_key).toBe(a[0].cache_key);
  });

  it("cache_key differs when the query-term set differs (Phase-5 cache correctness)", async () => {
    // Identical HTML scored against different query packs yields different
    // query_term_coverage, so it must NOT collide on one cache entry.
    const { client } = mockOrange([RICH_PAGE]);
    const a = await enrichPages(client, { companyDomain: "example.com", now: NOW, queryTerms: ["crm"] });
    const b = await enrichPages(client, { companyDomain: "example.com", now: NOW, queryTerms: ["kanban"] });
    expect(a[0].cache_key).not.toBe(b[0].cache_key);
    // ...but is order-independent for the same set
    const c = await enrichPages(client, {
      companyDomain: "example.com",
      now: NOW,
      queryTerms: ["b", "a"],
    });
    const d = await enrichPages(client, {
      companyDomain: "example.com",
      now: NOW,
      queryTerms: ["a", "b"],
    });
    expect(c[0].cache_key).toBe(d[0].cache_key);
  });

  it("dedupes pages that normalize to the same url (first-seen wins)", async () => {
    const dupe: OrangeSlicePage = { ...RICH_PAGE, url: "https://Example.com/best-crm" };
    const { client } = mockOrange([RICH_PAGE, dupe]);
    const pages = await enrichPages(client, { companyDomain: "example.com", now: NOW });
    expect(pages).toHaveLength(1);
    expect(pages[0].url).toBe("https://example.com/best-crm");
  });

  it("skips malformed scraped entries (missing url or html)", async () => {
    const bad = { url: "", html: "<p>x</p>" } as OrangeSlicePage;
    const { client } = mockOrange([bad, PLAIN_PAGE]);
    const pages = await enrichPages(client, { companyDomain: "example.com", now: NOW });
    expect(pages).toHaveLength(1);
    expect(pages[0].url).toBe("https://example.com/about");
  });
});
