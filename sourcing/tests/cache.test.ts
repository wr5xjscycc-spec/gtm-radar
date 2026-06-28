import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PageCache } from "../src/cache";
import {
  enrichPageWithCache,
  buildCacheKey,
  EXTRACTOR_VERSION,
  type PageRecord,
} from "../src/content";

describe("PageCache", () => {
  let cache: PageCache;
  const URL = "https://acme.com/pricing";
  const VERSION = "extractor-2026.06-v3";
  const MOCK_PAGE: PageRecord = {
    company_domain: "acme.com",
    url: URL,
    role: "candidate",
    cache_key: buildCacheKey(URL, VERSION),
    scraped_at: new Date().toISOString(),
    extractor_version: VERSION,
    content_features: {
      schema_markup: true,
      comparison_table: false,
      word_count: 100,
      heading_structure: "h1:1",
      freshness_days: 5,
      query_term_coverage: null,
      direct_answer_first: false,
      stats_density: "none",
      citation_density: "none",
      quote_density: "none",
      listicle_vs_prose: "prose",
    },
  };

  beforeEach(() => {
    cache = new PageCache(60_000);
  });

  describe("get / set", () => {
    it("returns null on empty store", async () => {
      const result = await cache.get(URL, VERSION);
      expect(result).toBeNull();
    });

    it("returns cached page on exact match", async () => {
      await cache.set(URL, VERSION, "<html />", MOCK_PAGE);
      const result = await cache.get(URL, VERSION);
      expect(result).toEqual(MOCK_PAGE);
      expect(cache.hitRate()).toBeGreaterThan(0);
    });

    it("misses on different URL", async () => {
      await cache.set(URL, VERSION, "<html />", MOCK_PAGE);
      const result = await cache.get("https://other.com", VERSION);
      expect(result).toBeNull();
    });

    it("misses on different version", async () => {
      await cache.set(URL, "v1", "<html />", MOCK_PAGE);
      const result = await cache.get(URL, "v2");
      expect(result).toBeNull();
    });
  });

  describe("staleness", () => {
    it("invalidates stale entries on get", async () => {
      const shortCache = new PageCache(1);
      await shortCache.set(URL, VERSION, "<html />", MOCK_PAGE);
      await new Promise((r) => setTimeout(r, 5));
      const result = await shortCache.get(URL, VERSION);
      expect(result).toBeNull();
      expect(shortCache.stats().invalidated).toBe(1);
    });
  });

  describe("computeContentHash", () => {
    it("produces deterministic hash for same input", () => {
      const h1 = cache.computeContentHash("hello world");
      const h2 = cache.computeContentHash("hello world");
      expect(h1).toBe(h2);
    });

    it("produces different hash for different input", () => {
      const h1 = cache.computeContentHash("hello world");
      const h2 = cache.computeContentHash("hello world!");
      expect(h1).not.toBe(h2);
    });
  });

  describe("stats", () => {
    it("starts at zero", () => {
      const s = cache.stats();
      expect(s.hits).toBe(0);
      expect(s.misses).toBe(0);
      expect(s.stored).toBe(0);
      expect(s.invalidated).toBe(0);
    });

    it("tracks hits and misses", async () => {
      await cache.get(URL, VERSION);
      await cache.get(URL, VERSION);
      await cache.set(URL, VERSION, "<html />", MOCK_PAGE);
      await cache.get(URL, VERSION);
      const s = cache.stats();
      expect(s.misses).toBe(2);
      expect(s.hits).toBe(1);
      expect(s.stored).toBe(1);
    });

    it("tracks invalidations from stale entries", async () => {
      const shortCache = new PageCache(1);
      await shortCache.set(URL, VERSION, "<html />", MOCK_PAGE);
      await shortCache.set("https://other.com", VERSION, "<html />", MOCK_PAGE);
      await new Promise((r) => setTimeout(r, 5));
      const count = shortCache.invalidate();
      expect(count).toBe(2);
      expect(shortCache.stats().invalidated).toBe(2);
    });
  });

  describe("clear", () => {
    it("resets store and stats", async () => {
      await cache.set(URL, VERSION, "<html />", MOCK_PAGE);
      await cache.get(URL, VERSION);
      cache.clear();
      expect(cache.stats().hits).toBe(0);
      expect(cache.stats().stored).toBe(0);
      const result = await cache.get(URL, VERSION);
      expect(result).toBeNull();
    });
  });

  describe("buildKey", () => {
    it("produces consistent key across cache method and standalone", () => {
      const fromCache = cache.buildKey(URL, VERSION);
      const fromFn = buildCacheKey(URL, VERSION);
      expect(fromCache).toBe(fromFn);
    });
  });
});

describe("enrichPageWithCache", () => {
  let cache: PageCache;
  const URL = "https://acme.com/page";
  const VERSION = "extractor-2026.06-v3";
  const MOCK_HTML = `<!DOCTYPE html><html><body><h1>Cache Test</h1><p>Published: 2026-06-15</p></body></html>`;
  const MOCK_OPENAI = {
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
    cache = new PageCache(60_000);
    vi.spyOn(global, "fetch").mockImplementation(async (url: RequestInfo | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes("api.openai.com")) {
        return new Response(JSON.stringify(MOCK_OPENAI), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(MOCK_HTML, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns page and populates cache on first call", async () => {
    const page = await enrichPageWithCache("acme.com", URL, "candidate", "sk-test", cache);
    expect(page.company_domain).toBe("acme.com");
    expect(page.url).toBe(URL);
    expect(page.content_features.word_count).toBeGreaterThan(0);
    expect(cache.stats().stored).toBe(1);
    expect(cache.stats().misses).toBe(1);
    expect(cache.stats().hits).toBe(0);
  });

  it("returns cached page on second call — no fetch", async () => {
    const page1 = await enrichPageWithCache("acme.com", URL, "candidate", "sk-test", cache);
    const fetchCountBefore = vi.mocked(fetch).mock.calls.length;
    const page2 = await enrichPageWithCache("acme.com", URL, "candidate", "sk-test", cache);
    expect(page1).toEqual(page2);
    expect(vi.mocked(fetch).mock.calls.length).toBe(fetchCountBefore);
    expect(cache.stats().hits).toBe(1);
    expect(cache.stats().misses).toBe(1);
  });
});
