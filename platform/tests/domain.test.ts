import { describe, it, expect } from "vitest";
// Single source of truth lives in convex/ (where Convex needs it); tested from
// the platform vitest harness via a relative import. The helper is pure TS with
// no Convex imports, so vitest resolves it without pulling the convex runtime.
import {
  normalizeDomain,
  normalizeUrl,
  sameDomain,
} from "../../convex/lib/domain";

describe("normalizeDomain — the cross-lane company.domain join key", () => {
  it("lowercases", () => {
    expect(normalizeDomain("Acme.COM")).toBe("acme.com");
  });

  it("strips www", () => {
    expect(normalizeDomain("www.acme.com")).toBe("acme.com");
  });

  it("strips ALL subdomains (registrable domain only)", () => {
    expect(normalizeDomain("docs.acme.com")).toBe("acme.com");
    expect(normalizeDomain("blog.eng.acme.com")).toBe("acme.com");
    expect(normalizeDomain("m.acme.com")).toBe("acme.com");
  });

  it("accepts a BARE HOST and a FULL URL and returns the same key", () => {
    // This is the load-bearing case: P2 normalizes citation *source URLs*,
    // P3 writes company.domain from a host — they must collide or the
    // company↔measurement join fails silently.
    expect(normalizeDomain("acme.com")).toBe("acme.com");
    expect(normalizeDomain("https://www.acme.com/pricing?utm_source=x#top")).toBe(
      "acme.com",
    );
    expect(normalizeDomain("http://acme.com")).toBe(
      normalizeDomain("https://acme.com"),
    );
  });

  it("collapses redirect aliases deterministically (http↔https, slash, www, case)", () => {
    const key = normalizeDomain("https://acme.com");
    expect(normalizeDomain("http://www.Acme.com/")).toBe(key);
    expect(normalizeDomain("ACME.com")).toBe(key);
  });

  it("does NOT over-collapse multi-label public suffixes", () => {
    expect(normalizeDomain("blog.acme.co.uk")).toBe("acme.co.uk");
    expect(normalizeDomain("www.acme.co.uk")).toBe("acme.co.uk");
    expect(normalizeDomain("shop.acme.com.au")).toBe("acme.com.au");
    expect(normalizeDomain("acme.co.uk")).toBe("acme.co.uk");
  });

  it("drops port and userinfo", () => {
    expect(normalizeDomain("https://user:pass@acme.com:8443/x")).toBe("acme.com");
  });

  it("handles trailing dots and empty/garbage input", () => {
    expect(normalizeDomain("acme.com.")).toBe("acme.com");
    expect(normalizeDomain("")).toBe("");
    expect(normalizeDomain("   ")).toBe("");
  });

  it("is idempotent", () => {
    const inputs = [
      "https://www.Acme.com/pricing",
      "docs.acme.co.uk",
      "ACME.COM",
    ];
    for (const i of inputs) {
      const once = normalizeDomain(i);
      expect(normalizeDomain(once)).toBe(once);
    }
  });
});

describe("normalizeUrl — the page.url / measurement.page_url join key", () => {
  it("forces https and strips www", () => {
    expect(normalizeUrl("http://www.acme.com/pricing")).toBe(
      "https://acme.com/pricing",
    );
  });

  it("KEEPS meaningful subdomains (docs. ≠ root)", () => {
    expect(normalizeUrl("https://docs.acme.com/guide")).toBe(
      "https://docs.acme.com/guide",
    );
    expect(normalizeUrl("https://docs.acme.com/guide")).not.toBe(
      normalizeUrl("https://acme.com/guide"),
    );
  });

  it("strips a trailing slash but preserves path case", () => {
    expect(normalizeUrl("https://acme.com/Pricing/")).toBe(
      "https://acme.com/Pricing",
    );
    expect(normalizeUrl("https://acme.com/")).toBe("https://acme.com");
    expect(normalizeUrl("https://acme.com")).toBe("https://acme.com");
  });

  it("drops the fragment", () => {
    expect(normalizeUrl("https://acme.com/x#section")).toBe("https://acme.com/x");
  });

  it("drops tracking params, keeps and sorts the rest", () => {
    expect(
      normalizeUrl("https://acme.com/x?utm_source=g&b=2&gclid=z&a=1"),
    ).toBe("https://acme.com/x?a=1&b=2");
    expect(normalizeUrl("https://acme.com/x?utm_campaign=q&fbclid=z")).toBe(
      "https://acme.com/x",
    );
  });

  it("is idempotent", () => {
    const inputs = [
      "http://www.acme.com/Pricing/?utm_source=x#a",
      "https://docs.acme.com/guide",
    ];
    for (const i of inputs) {
      const once = normalizeUrl(i);
      expect(normalizeUrl(once)).toBe(once);
    }
  });

  it("returns '' for empty input", () => {
    expect(normalizeUrl("")).toBe("");
  });
});

describe("sameDomain", () => {
  it("matches across www / subdomain / scheme / path differences", () => {
    expect(sameDomain("https://www.acme.com/pricing", "docs.acme.com")).toBe(true);
    expect(sameDomain("acme.com", "notacme.com")).toBe(false);
  });
});
