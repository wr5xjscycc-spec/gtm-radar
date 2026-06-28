// P3 · Phase 2 test: Orange Slice real client (VENDOR MOCKED).
// Proves createOrangeSliceClient maps the SDK's web.search + scrape.website
// return types to correct OrangeSlicePage[], and that passing the result through
// enrichPages produces valid contract-shaped `page` records. No live network.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { WebSearchResponse, ScrapeWebsiteResult } from "orangeslice";

import { createOrangeSliceClient } from "../src/orangeslice-client";
import { enrichPages } from "../src/content";
import { normalizeUrl } from "../src/domain";
import { CONTENT_EXTRACTOR_VERSION } from "../src/features";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "fixtures", "orangeslice-scrape.json"), "utf8"),
);

type FakeServices = {
  web: {
    search(): Promise<WebSearchResponse>;
  };
  scrape: {
    website: (params: { url: string }) => Promise<ScrapeWebsiteResult>;
  };
};

function fakeServices(): FakeServices {
  return {
    web: {
      async search() {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        return fixture.search;
      },
    },
    scrape: {
      async website({ url }: { url: string }) {
        const scraped = fixture.scrapes[url];
        if (!scraped) throw new Error(`unknown url: ${url}`);
        return scraped;
      },
    },
  };
}

describe("createOrangeSliceClient — mapping fidelity", () => {
  it("returns OrangeSlicePage[] with html=markdown, text=markdown, role=candidate", async () => {
    const client = createOrangeSliceClient({ perDomainLimit: 3 }, fakeServices() as any);
    const pages = await client.scrapeCandidatePages({ domain: "asana.com" });

    expect(pages).toHaveLength(3);
    for (const p of pages) {
      expect(p).toHaveProperty("url");
      expect(p).toHaveProperty("html");
      expect(p).toHaveProperty("text");
      expect(p.role).toBe("candidate");
      expect(typeof p.html).toBe("string");
      expect(p.html.length).toBeGreaterThan(0);
      expect(p.html).toBe(p.text);
    }

    // Verify concrete values from the fixture
    expect(pages[0].url).toBe("https://asana.com");
    expect(pages[0].html).toContain("Asana is a project management platform");
    expect(pages[1].url).toBe("https://asana.com/pricing");
    expect(pages[1].html).toContain("Premium: $10.99");
  });

  it("orders by search result rank", async () => {
    const client = createOrangeSliceClient({ perDomainLimit: 10 }, fakeServices() as any);
    const pages = await client.scrapeCandidatePages({ domain: "asana.com" });

    expect(pages[0].url).toBe("https://asana.com");
    expect(pages[1].url).toBe("https://asana.com/pricing");
    expect(pages[2].url).toBe("https://asana.com/about");
  });

  it("respects perDomainLimit and per-call limit", async () => {
    const client = createOrangeSliceClient({ perDomainLimit: 2 }, fakeServices() as any);
    const pages = await client.scrapeCandidatePages({ domain: "asana.com" });

    expect(pages).toHaveLength(2);
  });

  it("per-call limit overrides perDomainLimit", async () => {
    const client = createOrangeSliceClient({ perDomainLimit: 10 }, fakeServices() as any);
    const pages = await client.scrapeCandidatePages({ domain: "asana.com", limit: 1 });

    expect(pages).toHaveLength(1);
    expect(pages[0].url).toBe("https://asana.com");
  });

  it("returns empty array when web.search throws", async () => {
    const broken: FakeServices = {
      web: {
        async search() { throw new Error("SERP down"); },
      },
      scrape: {
        async website() { return {} as any; },
      },
    };
    const client = createOrangeSliceClient(undefined, broken as any);
    const pages = await client.scrapeCandidatePages({ domain: "asana.com" });

    expect(pages).toEqual([]);
  });

  it("tolerates per-URL scrape failures", async () => {
    const partiallyBroken: FakeServices = {
      web: {
        async search() { return fixture.search; },
      },
      scrape: {
        async website({ url }: { url: string }) {
          if (url === "https://asana.com/pricing") throw new Error("scrape failed");
          const scraped = fixture.scrapes[url];
          if (!scraped) throw new Error("unknown url");
          return scraped;
        },
      },
    };
    const client = createOrangeSliceClient(undefined, partiallyBroken as any);
    const pages = await client.scrapeCandidatePages({ domain: "asana.com" });

    // 3 search results, 1 scrape fails → 2 pages
    expect(pages).toHaveLength(2);
    expect(pages[0].url).toBe("https://asana.com");
    expect(pages[1].url).toBe("https://asana.com/about");
  });
});

describe("createOrangeSliceClient → enrichPages pipeline", () => {
  it("produces valid page records (normalized url, extractor_version, scraped_at number)", async () => {
    const client = createOrangeSliceClient({ perDomainLimit: 3 }, fakeServices() as any);
    const now = "2026-06-28T12:00:00.000Z";

    const pages = await enrichPages(client, {
      companyDomain: "asana.com",
      now,
    });

    expect(pages.length).toBeGreaterThan(0);

    for (const p of pages) {
      // FK is the normalized domain
      expect(p.company_domain).toBe("asana.com");

      // URL is normalized
      expect(p.url).toBe(normalizeUrl(p.url));

      // Role defaults to candidate
      expect(p.role).toBe("candidate");

      // Content features present
      expect(p.content_features).toBeDefined();
      expect(typeof p.content_features.word_count).toBe("number");
      expect(typeof p.content_features.heading_structure).toBe("number");

      // extractor_version stamped
      expect(p.extractor_version).toBe(CONTENT_EXTRACTOR_VERSION);

      // scraped_at is epoch-ms number
      expect(typeof p.scraped_at).toBe("number");
      expect(p.scraped_at).toBeGreaterThan(0);

      // cache_key present
      expect(typeof p.cache_key).toBe("string");
      expect(p.cache_key.length).toBeGreaterThan(0);
    }
  });

  it("dedupes by normalized url (first-seen wins)", async () => {
    // Two search results point to the same normalized URL → only one page record.
    const dupFixture = {
      search: {
        results: [
          { title: "A", link: "https://asana.com", displayed_link: "asana.com" },
          { title: "B", link: "https://asana.com/", displayed_link: "asana.com" },
        ],
        pagination: {
          currentPage: 1, totalPages: 1, totalResults: 2,
          resultsPerPage: 10, hasNextPage: false,
        },
      },
      scrapes: {
        "https://asana.com": fixture.scrapes["https://asana.com"],
        "https://asana.com/": fixture.scrapes["https://asana.com"],
      },
    };
    const dupServices: FakeServices = {
      web: { async search() { return dupFixture.search; } },
      scrape: {
        async website({ url }: { url: string }) {
          const s = dupFixture.scrapes[url];
          if (!s) throw new Error("unknown url");
          return s;
        },
      },
    };
    const client = createOrangeSliceClient(undefined, dupServices as any);
    const pages = await enrichPages(client, {
      companyDomain: "asana.com",
      now: "2026-06-28T12:00:00.000Z",
    });

    expect(pages).toHaveLength(1);
  });
});
