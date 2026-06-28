import { describe, it, expect } from "vitest";
import { normalizeDomain, normalizeUrl, sameDomain } from "../src/normalize";

describe("normalizeDomain", () => {
  it("bare domain stays as-is", () => {
    expect(normalizeDomain("acme.com")).toBe("acme.com");
  });

  it("lowercases the host", () => {
    expect(normalizeDomain("WWW.Acme.com")).toBe("acme.com");
  });

  it("strips a leading www", () => {
    expect(normalizeDomain("www.acme.com")).toBe("acme.com");
  });

  it("strips ALL subdomains", () => {
    expect(normalizeDomain("docs.acme.com")).toBe("acme.com");
  });

  it("strips arbitrary subdomains", () => {
    expect(normalizeDomain("blog.acme.com")).toBe("acme.com");
  });

  it("handles multi-label suffix (co.uk) — keeps 3 labels", () => {
    expect(normalizeDomain("blog.acme.co.uk")).toBe("acme.co.uk");
  });

  it("handles multi-label suffix (co.uk) with another subdomain", () => {
    expect(normalizeDomain("docs.example.co.uk")).toBe("example.co.uk");
  });

  it("strips scheme, path, query from a full URL", () => {
    expect(normalizeDomain("https://www.Acme.com/pricing?x=1")).toBe("acme.com");
  });

  it("strips userinfo", () => {
    expect(normalizeDomain("user:pass@example.com")).toBe("example.com");
  });

  it("strips subdomains and port from a full host string", () => {
    expect(normalizeDomain("sub.host.example.com:8080")).toBe("example.com");
  });

  it("strips trailing dots", () => {
    expect(normalizeDomain("example.com..")).toBe("example.com");
  });

  it("lowercases and strips scheme", () => {
    expect(normalizeDomain("HTTP://Foo.COM/")).toBe("foo.com");
  });

  it("preserves localhost (no dot)", () => {
    expect(normalizeDomain("localhost")).toBe("localhost");
  });

  it("returns empty string for empty/garbage input", () => {
    expect(normalizeDomain("")).toBe("");
    expect(normalizeDomain("   ")).toBe("");
  });

  it("trims whitespace", () => {
    expect(normalizeDomain("  www.Example.com.  ")).toBe("example.com");
  });

  it("strips protocol, path, query and fragment from a full URL", () => {
    expect(normalizeDomain("https://www.example.com/blog/post?utm=1#top")).toBe("example.com");
  });

  it("strips an explicit port", () => {
    expect(normalizeDomain("https://example.com:443/")).toBe("example.com");
  });

  it("treats a bare host followed by a path as a domain", () => {
    expect(normalizeDomain("Example.com/pricing")).toBe("example.com");
  });

  it("is idempotent — f(f(x)) === f(x)", () => {
    const inputs = [
      "acme.com",
      "WWW.Acme.com",
      "docs.acme.com",
      "blog.acme.co.uk",
      "https://www.Acme.com/pricing?x=1",
      "user:pass@example.com",
      "sub.host.example.com:8080",
      "example.com..",
      "HTTP://Foo.COM/",
    ];
    for (const input of inputs) {
      const once = normalizeDomain(input);
      const twice = normalizeDomain(once);
      expect(twice).toBe(once);
    }
  });
});

describe("normalizeUrl", () => {
  it("lowercases host, strips www, keeps path case", () => {
    expect(normalizeUrl("https://www.Example.com/Home")).toBe("https://example.com/Home");
  });

  it("strips trailing slash, strips www", () => {
    expect(normalizeUrl("https://www.Acme.com/About-Us/")).toBe("https://acme.com/About-Us");
  });

  it("keeps non-www subdomains", () => {
    expect(normalizeUrl("https://docs.acme.com/x")).toBe("https://docs.acme.com/x");
  });

  it("forces https from http", () => {
    expect(normalizeUrl("http://example.com")).toBe("https://example.com");
  });

  it("drops tracking params, sorts remaining", () => {
    expect(normalizeUrl("https://example.com/page?utm_source=x&q=1&a=2")).toBe("https://example.com/page?a=2&q=1");
  });

  it("strips trailing slash of root path", () => {
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com");
  });

  it("adds https scheme and strips trailing slash", () => {
    expect(normalizeUrl("example.com/Path/")).toBe("https://example.com/Path");
  });

  it("drops fragment and sorts params", () => {
    expect(normalizeUrl("https://www.Example.com/a?b=2&a=1#frag")).toBe("https://example.com/a?a=1&b=2");
  });

  it("returns empty string for empty input", () => {
    expect(normalizeUrl("")).toBe("");
  });

  it("strips fbclid tracking param", () => {
    expect(normalizeUrl("https://example.com/page?fbclid=abc123")).toBe("https://example.com/page");
  });

  it("strips gclid tracking param", () => {
    expect(normalizeUrl("https://example.com/page?gclid=xyz")).toBe("https://example.com/page");
  });

  it("is idempotent — f(f(x)) === f(x)", () => {
    const inputs = [
      "https://www.Example.com/Home",
      "https://www.Acme.com/About-Us/",
      "https://docs.acme.com/x",
      "http://example.com",
      "https://example.com/page?utm_source=x&q=1&a=2",
      "https://example.com/",
      "example.com/Path/",
      "https://www.Example.com/a?b=2&a=1#frag",
    ];
    for (const input of inputs) {
      const once = normalizeUrl(input);
      const twice = normalizeUrl(once);
      expect(twice).toBe(once);
    }
  });
});

describe("sameDomain", () => {
  it("returns true for same registrable domain", () => {
    expect(sameDomain("www.example.com", "example.com")).toBe(true);
    expect(sameDomain("blog.example.com", "example.com")).toBe(true);
    expect(sameDomain("https://www.example.com/path", "example.com")).toBe(true);
  });

  it("returns false for different registrable domains", () => {
    expect(sameDomain("example.com", "other.com")).toBe(false);
    expect(sameDomain("example.co.uk", "other.co.uk")).toBe(false);
  });
});
