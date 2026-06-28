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

  it("strips ONLY www — non-www subdomains are preserved (P1 helper owns suffix-aware stripping)", () => {
    // Documented placeholder limitation: stripping arbitrary subdomains needs a
    // public-suffix list. We keep the host intact rather than corrupt the key.
    expect(normalizeDomain("JIRA.atlassian.com")).toBe("jira.atlassian.com");
    expect(normalizeDomain("blog.example.co.uk")).toBe("blog.example.co.uk");
  });

  it("throws on empty / whitespace / null-ish input (fail loud, never write a junk key)", () => {
    expect(() => normalizeDomain("")).toThrow();
    expect(() => normalizeDomain("   ")).toThrow();
    // @ts-expect-error exercising the runtime guard
    expect(() => normalizeDomain(undefined)).toThrow();
  });

  it("isNormalizedDomain reflects whether input equals its normal form", () => {
    expect(isNormalizedDomain("example.com")).toBe(true);
    expect(isNormalizedDomain("www.example.com")).toBe(false);
    expect(isNormalizedDomain("")).toBe(false);
  });
});
