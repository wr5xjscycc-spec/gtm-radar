import { describe, it, expect } from "vitest";
import { normalizeDomain } from "../src/normalize";

// TEMP in-lane mirror of P1's single shared domain helper (docs/CONTRACT.md "Global rules").
// Conservative on purpose: strip www only, never arbitrary subdomains — over-stripping silently
// breaks the company↔page↔measurement join (the contract's #1 failure mode).
describe("normalizeDomain (temp mirror of P1's shared helper)", () => {
  it("lowercases the host", () => {
    expect(normalizeDomain("Example.COM")).toBe("example.com");
  });

  it("strips protocol, path, query and fragment from a full URL", () => {
    expect(normalizeDomain("https://www.example.com/blog/post?utm=1#top")).toBe("example.com");
  });

  it("strips a leading www.", () => {
    expect(normalizeDomain("www.foo.io")).toBe("foo.io");
  });

  it("preserves a non-www subdomain (conservative — no over-stripping)", () => {
    expect(normalizeDomain("https://blog.example.com")).toBe("blog.example.com");
  });

  it("strips an explicit port", () => {
    expect(normalizeDomain("https://example.com:443/")).toBe("example.com");
  });

  it("treats a bare host followed by a path as a domain", () => {
    expect(normalizeDomain("Example.com/pricing")).toBe("example.com");
  });

  it("trims surrounding whitespace and a trailing dot", () => {
    expect(normalizeDomain("  www.Example.com.  ")).toBe("example.com");
  });

  it("returns '' for empty/garbage input rather than throwing", () => {
    expect(normalizeDomain("")).toBe("");
    expect(normalizeDomain("   ")).toBe("");
  });
});
