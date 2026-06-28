import { describe, it, expect } from "vitest";
import { parseCitations } from "../src/parse";

const knownPages = [
  { company_domain: "acme.com", url: "https://acme.com/pricing" },
  { company_domain: "competitor.com", url: "https://competitor.com/pricing" },
];

const knownCompanies = [
  { domain: "acme.com" },
  { domain: "competitor.com" },
  { domain: "rival.io" },
];

describe("parseCitations", () => {
  it("maps source URLs to normalized domains", () => {
    const result = parseCitations(
      [
        "https://www.hubspot.com/products/crm",
        "https://acme.com/pricing",
      ],
      knownPages,
      knownCompanies,
    );

    expect(result.citations).toHaveLength(2);
    expect(result.citations[0].normalized_domain).toBe("hubspot.com");
    expect(result.citations[1].normalized_domain).toBe("acme.com");
  });

  it("matches known companies", () => {
    const result = parseCitations(
      [
        "https://acme.com/pricing",
        "https://competitor.com/pricing",
        "https://unknown-site.com/page",
      ],
      knownPages,
      knownCompanies,
    );

    expect(result.citations[0].matched_company_domain).toBe("acme.com");
    expect(result.citations[1].matched_company_domain).toBe("competitor.com");
    expect(result.citations[2].matched_company_domain).toBeUndefined();
  });

  it("collects cited domains", () => {
    const result = parseCitations(
      [
        "https://acme.com/pricing",
        "https://rival.io",
        "https://hubspot.com",
      ],
      knownPages,
      knownCompanies,
    );

    expect(result.cited_domains).toEqual(["acme.com", "rival.io"]);
  });

  it("handles empty source URLs", () => {
    const result = parseCitations([], knownPages, knownCompanies);

    expect(result.citations).toHaveLength(0);
    expect(result.cited_domains).toHaveLength(0);
  });

  it("normalizes www and subdomains before matching", () => {
    const result = parseCitations(
      ["https://www.acme.com/blog"],
      knownPages,
      knownCompanies,
    );

    expect(result.citations[0].normalized_domain).toBe("acme.com");
    expect(result.citations[0].matched_company_domain).toBe("acme.com");
  });

  it("normalizes uppercase URLs", () => {
    const result = parseCitations(
      ["HTTPS://ACME.COM/Pricing"],
      knownPages,
      knownCompanies,
    );
    expect(result.citations[0].normalized_domain).toBe("acme.com");
    expect(result.citations[0].matched_company_domain).toBe("acme.com");
  });

  it("strips port from URL", () => {
    const result = parseCitations(
      ["https://acme.com:8080/pricing"],
      knownPages,
      knownCompanies,
    );
    expect(result.citations[0].normalized_domain).toBe("acme.com");
    expect(result.citations[0].matched_company_domain).toBe("acme.com");
  });

  it("strips trailing dot from URL", () => {
    const result = parseCitations(
      ["https://acme.com./pricing"],
      knownPages,
      knownCompanies,
    );
    expect(result.citations[0].normalized_domain).toBe("acme.com");
    expect(result.citations[0].matched_company_domain).toBe("acme.com");
  });

  it("normalizes bare host (no scheme)", () => {
    const result = parseCitations(
      ["acme.com/pricing"],
      knownPages,
      knownCompanies,
    );
    expect(result.citations[0].normalized_domain).toBe("acme.com");
    expect(result.citations[0].matched_company_domain).toBe("acme.com");
  });

  it("strips tracking params from URL before domain normalization", () => {
    // normalizeDomain strips path/query so tracking params are irrelevant
    const result = parseCitations(
      ["https://acme.com/pricing?utm_source=twitter&gclid=abc123"],
      knownPages,
      knownCompanies,
    );
    expect(result.citations[0].normalized_domain).toBe("acme.com");
    expect(result.citations[0].matched_company_domain).toBe("acme.com");
  });
});
