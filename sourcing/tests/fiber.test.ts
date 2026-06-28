import { describe, it, expect } from "vitest";
import {
  findSimilarCompanies,
  createMockFiberClient,
  type FiberSimilarCompany,
} from "../src/fiber";
import { normalizeDomain } from "../../convex/lib/domain";

const mockData: FiberSimilarCompany[] = [
  { domain: "competitor.com", name: "Competitor Inc" },
  { domain: "rival.io", name: "Rival.io" },
  { domain: "other-corp.com", name: "Other Corp" },
];

describe("findSimilarCompanies", () => {
  const client = createMockFiberClient(mockData);

  it("returns companies from mock", async () => {
    const result = await findSimilarCompanies("acme.com", { client });
    expect(result.length).toBeGreaterThan(0);
  });

  it("normalizes every returned domain and is idempotent under normalizeDomain", async () => {
    const result = await findSimilarCompanies("acme.com", { client });
    for (const c of result) {
      expect(c.domain).toBe(normalizeDomain(c.domain));
    }
  });

  it("marks all returned records as role=battlefield", async () => {
    const result = await findSimilarCompanies("acme.com", { client });
    for (const c of result) {
      expect(c.role).toBe("battlefield");
    }
  });

  it("excludes the seed customer's own domain", async () => {
    const result = await findSimilarCompanies("acme.com", { client });
    const domains = result.map((c) => c.domain);
    expect(domains).not.toContain(normalizeDomain("acme.com"));
  });

  it("deduplicates companies with the same normalized domain", async () => {
    const dupeClient = createMockFiberClient([
      ...mockData,
      { domain: "www.Competitor.com", name: "Competitor Dupe" },
    ]);
    const result = await findSimilarCompanies("acme.com", {
      client: dupeClient,
    });
    const domains = result.map((c) => c.domain);
    expect(new Set(domains).size).toBe(domains.length);
    expect(domains.filter((d) => d === "competitor.com").length).toBe(1);
  });

  it("respects the limit option", async () => {
    const result = await findSimilarCompanies("acme.com", {
      client,
      limit: 2,
    });
    expect(result.length).toBe(2);
  });

  it("handles mixed-case and www-prefixed seed domains", async () => {
    const result = await findSimilarCompanies("www.Acme.com", { client });
    const domains = result.map((c) => c.domain);
    expect(domains).not.toContain("acme.com");
  });

  it("stamps source_versions on every record", async () => {
    const result = await findSimilarCompanies("acme.com", { client });
    for (const c of result) {
      expect(c.source_versions).toBeDefined();
      expect(c.source_versions?.fiber_lookup).toBe("fiber-2026.06");
    }
  });
});
