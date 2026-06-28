import { describe, it, expect } from "vitest";
import { checkPoolComposition } from "../src/poolComposition";
import type { CandidatePoolItem } from "../src/label";

const makePage = (
  domain: string,
  url?: string,
): CandidatePoolItem => ({
  company_domain: domain,
  page_url: url ?? `https://${domain}/page`,
});

describe("checkPoolComposition", () => {
  it("reports even distribution as non-degenerate", () => {
    const pool = [
      makePage("acme.com"),
      makePage("competitor.com"),
      makePage("rival.io"),
    ];
    const result = checkPoolComposition(pool);
    expect(result.total_pages).toBe(3);
    expect(result.degenerate_pool).toBe(false);
    expect(result.dominant_company).toBe("acme.com");
    expect(result.dominant_percentage).toBeCloseTo(1 / 3, 5);
  });

  it("flags degenerate pool when one company dominates", () => {
    const pool = [
      makePage("acme.com"),
      makePage("acme.com"),
      makePage("acme.com"),
      makePage("acme.com", "https://acme.com/other"),
      makePage("competitor.com"),
    ];
    const result = checkPoolComposition(pool);
    expect(result.total_pages).toBe(5);
    expect(result.degenerate_pool).toBe(true);
    expect(result.dominant_company).toBe("acme.com");
    expect(result.dominant_percentage).toBeCloseTo(0.8, 5);
  });

  it("uses custom threshold", () => {
    const pool = [
      makePage("acme.com"),
      makePage("acme.com"),
      makePage("competitor.com"),
    ];
    // With threshold 0.6, 2/3 = 0.667 > 0.6 → degenerate
    const result = checkPoolComposition(pool, 0.6);
    expect(result.degenerate_pool).toBe(true);
    expect(result.dominant_percentage).toBeCloseTo(2 / 3, 5);

    // With threshold 0.8, 2/3 = 0.667 < 0.8 → not degenerate
    const result2 = checkPoolComposition(pool, 0.8);
    expect(result2.degenerate_pool).toBe(false);
    expect(result2.dominant_percentage).toBeCloseTo(2 / 3, 5);
  });

  it("handles empty pool", () => {
    const result = checkPoolComposition([]);
    expect(result.total_pages).toBe(0);
    expect(result.degenerate_pool).toBe(false);
    expect(result.dominant_company).toBeNull();
    expect(result.dominant_percentage).toBe(0);
    expect(result.companies).toHaveLength(0);
  });

  it("reports all company shares sorted by count descending", () => {
    const pool = [
      makePage("acme.com"),
      makePage("rival.io"),
      makePage("acme.com"),
      makePage("other.com"),
    ];
    const result = checkPoolComposition(pool);
    expect(result.companies).toHaveLength(3);
    expect(result.companies[0].company_domain).toBe("acme.com");
    expect(result.companies[0].count).toBe(2);
    expect(result.companies[0].percentage).toBeCloseTo(0.5, 5);
    expect(result.dominant_company).toBe("acme.com");
  });

  it("normalizes domains before counting", () => {
    const pool = [
      makePage("www.Acme.com"),
      makePage("ACME.com"),
      makePage("acme.com"),
    ];
    const result = checkPoolComposition(pool);
    expect(result.companies).toHaveLength(1);
    expect(result.companies[0].company_domain).toBe("acme.com");
    expect(result.companies[0].count).toBe(3);
    expect(result.dominant_percentage).toBe(1.0);
    expect(result.degenerate_pool).toBe(true);
  });

  it("default threshold is 0.5", () => {
    // Exactly 50% (2/4) should NOT be degenerate
    const pool = [
      makePage("acme.com"),
      makePage("acme.com"),
      makePage("rival.io"),
      makePage("other.com"),
    ];
    const result = checkPoolComposition(pool);
    expect(result.dominant_percentage).toBeCloseTo(0.5, 5);
    expect(result.degenerate_pool).toBe(false);
  });
});
