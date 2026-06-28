import { describe, it, expect } from "vitest";
import { normalizeDomain, isNormalizedDomain } from "../src/domain";

describe("normalizeDomain", () => {
  it("lowercases and strips scheme, www, path, query, and fragment", () => {
    expect(normalizeDomain("https://www.Example.com/path?q=1#frag")).toBe("example.com");
    expect(normalizeDomain("HTTP://EXAMPLE.COM")).toBe("example.com");
    expect(normalizeDomain("//www.example.com/")).toBe("example.com");
  });

  it("strips port, userinfo, and a trailing FQDN dot", () => {
    expect(normalizeDomain("example.com:8080")).toBe("example.com");
    expect(normalizeDomain("user:pass@example.com")).toBe("example.com");
    expect(normalizeDomain("example.com.")).toBe("example.com");
  });

  it("treats a bare domain as already-host", () => {
    expect(normalizeDomain("Monday.com")).toBe("monday.com");
  });

  it("is idempotent", () => {
    const once = normalizeDomain("https://www.Example.com/a/b");
    expect(normalizeDomain(once)).toBe(once);
  });

  it("strips ALL subdomains to the registrable domain (eTLD+1) — per canonical domain.ts contract", () => {
    expect(normalizeDomain("JIRA.atlassian.com")).toBe("atlassian.com");
    expect(normalizeDomain("blog.example.co.uk")).toBe("example.co.uk");
  });

  it("returns empty string on empty / whitespace / null-ish input (never throws)", () => {
    expect(normalizeDomain("")).toBe("");
    expect(normalizeDomain("   ")).toBe("");
    // @ts-expect-error exercising the runtime guard
    expect(normalizeDomain(undefined)).toBe("");
  });

  it("isNormalizedDomain reflects whether input equals its normal form", () => {
    expect(isNormalizedDomain("example.com")).toBe(true);
    expect(isNormalizedDomain("www.example.com")).toBe(false);
    expect(isNormalizedDomain("")).toBe(false);
  });
});
