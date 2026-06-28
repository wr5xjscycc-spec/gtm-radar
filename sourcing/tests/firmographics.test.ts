// P3 · Phase 1 required test: firmographic field-mapping tests (VENDOR MOCKED).
// Proves Fiber firmographics -> contract `company.firmographics`, that the
// context-feature family stays SMALL (only the five contract fields survive),
// and that enrichment is non-mutating + provenance-stamped. No live network.

import { describe, it, expect } from "vitest";

import {
  mapFirmographics,
  enrichFirmographics,
  FIBER_FIRMOGRAPHICS_VERSION,
  type FiberFirmographicsClient,
  type FiberFirmographicsResponse,
} from "../src/firmographics";
import type { Company } from "../src/types";

/** A representative, full Fiber firmographics payload. */
const fullRaw: FiberFirmographicsResponse = {
  size: "201-500",
  funding_stage: "Series B",
  headcount_growth: "+18% YoY",
  hiring_velocity: "12 open roles",
  tech_stack: ["React", "Postgres", "AWS"],
};

/** Minimal valid contract-shaped Company (role=battlefield, nothing enriched). */
function makeCompany(overrides: Partial<Company> = {}): Company {
  return {
    domain: "asana.com",
    name: "Asana",
    role: "battlefield",
    coverage_flags: {
      firmographics_missing: true,
      offpage_missing: true,
      understanding_missing: true,
    },
    source_versions: { battlefield: "fiber/find-similar-companies@v1" },
    ...overrides,
  };
}

/** Mocked Fiber firmographics client — replays a canned payload, never hits net. */
function mockFiber(
  payload: FiberFirmographicsResponse,
  onCall?: (args: { domain: string }) => void,
): FiberFirmographicsClient {
  return {
    async getFirmographics(args) {
      onCall?.(args);
      return payload;
    },
  };
}

describe("mapFirmographics — field mapping", () => {
  it("maps all five contract fields from a representative response", () => {
    const out = mapFirmographics(fullRaw);
    expect(out).toEqual({
      size: "201-500",
      funding_stage: "Series B",
      headcount_growth: "+18% YoY",
      hiring_velocity: "12 open roles",
      tech_stack: ["React", "Postgres", "AWS"],
    });
  });

  it("drops extra/unknown fields — family stays small (<= 5 keys)", () => {
    const noisy: FiberFirmographicsResponse = {
      ...fullRaw,
      // Fields Fiber might return that are NOT part of the contract family:
      revenue: "$10M",
      employee_count: 350,
      founded_year: 2008,
      ceo_name: "Jane Doe",
      industry: "SaaS",
      raw_blob: { nested: true },
    };
    const out = mapFirmographics(noisy);
    const keys = Object.keys(out).sort();
    expect(keys).toEqual([
      "funding_stage",
      "headcount_growth",
      "hiring_velocity",
      "size",
      "tech_stack",
    ]);
    // Hard guarantee: nothing outside the five-field family leaks through.
    expect(keys.length).toBeLessThanOrEqual(5);
    expect(out).not.toHaveProperty("revenue");
    expect(out).not.toHaveProperty("industry");
  });

  it("normalizes tech_stack: array input passes through (trimmed)", () => {
    const out = mapFirmographics({ tech_stack: [" React ", "Postgres", ""] });
    expect(out.tech_stack).toEqual(["React", "Postgres"]);
  });

  it("normalizes tech_stack: comma-string input -> string[]", () => {
    const out = mapFirmographics({ tech_stack: "React, Postgres ,AWS" });
    expect(out.tech_stack).toEqual(["React", "Postgres", "AWS"]);
  });

  it("normalizes tech_stack: absent input -> undefined", () => {
    const out = mapFirmographics({ size: "10-50" });
    expect(out.tech_stack).toBeUndefined();
  });

  it("tolerates missing fields -> undefined, no empty-string pollution", () => {
    const out = mapFirmographics({
      size: "  ", // blank -> must not survive as ""
      funding_stage: "Seed",
    });
    expect(out.funding_stage).toBe("Seed");
    expect(out.size).toBeUndefined();
    expect(out.headcount_growth).toBeUndefined();
    expect(out.hiring_velocity).toBeUndefined();
    expect(out.tech_stack).toBeUndefined();
    // No key should hold an empty string.
    for (const v of Object.values(out)) {
      expect(v).not.toBe("");
    }
  });
});

describe("enrichFirmographics — enrichment + provenance", () => {
  it("sets firmographics, flips coverage flag, stamps source version", async () => {
    const company = makeCompany();
    const enriched = await enrichFirmographics(mockFiber(fullRaw), company);

    expect(enriched.firmographics).toEqual({
      size: "201-500",
      funding_stage: "Series B",
      headcount_growth: "+18% YoY",
      hiring_velocity: "12 open roles",
      tech_stack: ["React", "Postgres", "AWS"],
    });
    expect(enriched.coverage_flags.firmographics_missing).toBe(false);
    expect(enriched.source_versions.firmographics).toBe(FIBER_FIRMOGRAPHICS_VERSION);
  });

  it("queries Fiber with the company's domain unchanged (join key intact)", async () => {
    const seen: Array<{ domain: string }> = [];
    const company = makeCompany({ domain: "monday.com" });
    const enriched = await enrichFirmographics(
      mockFiber(fullRaw, (args) => seen.push(args)),
      company,
    );
    expect(seen[0]).toEqual({ domain: "monday.com" });
    expect(enriched.domain).toBe("monday.com");
  });

  it("preserves other coverage flags and source versions", async () => {
    const company = makeCompany();
    const enriched = await enrichFirmographics(mockFiber(fullRaw), company);

    expect(enriched.coverage_flags.offpage_missing).toBe(true);
    expect(enriched.coverage_flags.understanding_missing).toBe(true);
    expect(enriched.source_versions.battlefield).toBe("fiber/find-similar-companies@v1");
    expect(enriched.role).toBe("battlefield");
    expect(enriched.name).toBe("Asana");
  });

  it("coverage honesty: an EMPTY Fiber response leaves the row flagged missing + unstamped", async () => {
    // Red-team transparency rule: never claim coverage we don't have. If Fiber
    // returns nothing usable, firmographics_missing must stay true and no version
    // is stamped — otherwise the board would show a hollow row as "covered".
    const company = makeCompany();
    const enriched = await enrichFirmographics(mockFiber({}), company);

    expect(enriched.firmographics).toEqual({});
    expect(enriched.coverage_flags.firmographics_missing).toBe(true);
    expect(enriched.source_versions.firmographics).toBeUndefined();
  });

  it("coverage honesty: a blank-but-present Fiber response is also treated as missing", async () => {
    const enriched = await enrichFirmographics(
      mockFiber({ size: "   ", tech_stack: [], junk: "ignored" }),
      makeCompany(),
    );
    expect(enriched.firmographics).toEqual({});
    expect(enriched.coverage_flags.firmographics_missing).toBe(true);
    expect(enriched.source_versions.firmographics).toBeUndefined();
  });

  it("does NOT mutate the input company (immutability)", async () => {
    const company = makeCompany();
    const snapshot = structuredClone(company);

    const enriched = await enrichFirmographics(mockFiber(fullRaw), company);

    // Input is byte-identical to before the call.
    expect(company).toEqual(snapshot);
    expect(company.firmographics).toBeUndefined();
    expect(company.coverage_flags.firmographics_missing).toBe(true);
    expect(company.source_versions.firmographics).toBeUndefined();
    // And a genuinely new object was returned.
    expect(enriched).not.toBe(company);
    expect(enriched.coverage_flags).not.toBe(company.coverage_flags);
    expect(enriched.source_versions).not.toBe(company.source_versions);
  });
});
