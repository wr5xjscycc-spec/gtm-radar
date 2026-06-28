// Standalone (node-env) unit test for Card A's PURE measurement helpers.
//
// Imports ONLY the pure functions from convex/measure (no convex-test, no
// import.meta.glob over all convex files) so it runs in isolation without loading
// sibling lanes' in-progress convex modules. This is the Card A author's own
// verification harness; the load-bearing board assertions live in measure.test.ts
// (convex-test, edge-runtime), which the orchestrator runs at integration.
import { describe, it, expect } from "vitest";
import {
  buildSeedQueries,
  buildCandidatePool,
  pagesToCandidatePool,
} from "../../convex/measure";

describe("buildSeedQueries", () => {
  it("defaults to 8 keyword queries that embed the vertical", () => {
    const q = buildSeedQueries("AI SDR");
    expect(q).toHaveLength(8);
    expect(q.every((s) => s.seed_source === "keyword")).toBe(true);
    expect(q.every((s) => s.text.includes("AI SDR"))).toBe(true);
  });

  it("respects nQueries, caps at 16, floors at 1, treats 0/NaN as default", () => {
    expect(buildSeedQueries("v", 2)).toHaveLength(2);
    expect(buildSeedQueries("v", 12)).toHaveLength(12);
    expect(buildSeedQueries("v", 100)).toHaveLength(16);
    expect(buildSeedQueries("v", 1)).toHaveLength(1);
    expect(buildSeedQueries("v", -3)).toHaveLength(1);
    expect(buildSeedQueries("v", 0)).toHaveLength(8);
    expect(buildSeedQueries("v", NaN)).toHaveLength(8);
  });

  it("falls back to a generic vertical when blank", () => {
    expect(buildSeedQueries("").every((s) => s.text.includes("software"))).toBe(true);
    expect(buildSeedQueries("   ").every((s) => s.text.includes("software"))).toBe(true);
  });

  it("produces distinct query texts (no accidental duplicates within the default set)", () => {
    const texts = buildSeedQueries("crm").map((s) => s.text);
    expect(new Set(texts).size).toBe(texts.length);
  });
});

describe("buildCandidatePool", () => {
  it("puts own domain first as the customer, competitors after", () => {
    const pool = buildCandidatePool("acme.com", ["seraleads.com", "rival.io"]);
    expect(pool).toEqual([
      { company_domain: "acme.com", url: "acme.com", role: "customer" },
      { company_domain: "seraleads.com", url: "seraleads.com", role: "competitor" },
      { company_domain: "rival.io", url: "rival.io", role: "competitor" },
    ]);
  });

  it("skips empty domains", () => {
    expect(buildCandidatePool("", [])).toEqual([]);
    expect(buildCandidatePool("acme.com", ["", "rival.io"])).toHaveLength(2);
  });
});

describe("pagesToCandidatePool", () => {
  it("de-dupes urls and keys company_domain on the registrable domain", () => {
    const pool = pagesToCandidatePool([
      "https://www.acme.com/pricing",
      "https://www.acme.com/pricing",
      "https://blog.rival.io/post",
      "",
    ]);
    expect(pool).toHaveLength(2);
    expect(pool[0]).toEqual({
      company_domain: "acme.com",
      url: "https://www.acme.com/pricing",
      role: "candidate",
    });
    expect(pool[1].company_domain).toBe("rival.io");
  });
});
