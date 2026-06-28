// P3 · Phase 0 required test: Fiber-MCP smoke test (VENDOR MOCKED) that writes a
// `company` record with a normalized domain. Proves company sourcing through
// Fiber end-to-end inside the lane, with no live network call (docs/TESTING.md).

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { buildBattlefield, type CompanyWriter } from "../src/battlefield";
import { parseFiberResponse, type FiberClient } from "../src/fiber";
import { isNormalizedDomain } from "../src/domain";
import type { Company } from "../src/types";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "fixtures", "fiber-find-similar.json"), "utf8"),
);

/** Mocked Fiber MCP client — replays the recorded fixture, never hits the network. */
const mockFiber: FiberClient = {
  async findSimilarCompanies() {
    return parseFiberResponse(fixture);
  },
};

/** In-memory stand-in for P1's Convex `company` upsert (keyed on normalized domain). */
class InMemoryCompanyWriter implements CompanyWriter {
  readonly byDomain = new Map<string, Company>();
  async upsertCompany(company: Company): Promise<void> {
    this.byDomain.set(company.domain, company);
  }
}

describe("Fiber battlefield smoke (mocked)", () => {
  let writer: InMemoryCompanyWriter;
  let written: Company[];

  beforeEach(async () => {
    writer = new InMemoryCompanyWriter();
    written = await buildBattlefield(mockFiber, writer, { customerDomain: fixture.seed });
  });

  it("writes at least one company record", () => {
    expect(written.length).toBeGreaterThan(0);
    expect(writer.byDomain.size).toBe(written.length);
  });

  it("DoD: every written record has a NORMALIZED domain key", () => {
    for (const c of written) {
      expect(isNormalizedDomain(c.domain), `not normalized: ${c.domain}`).toBe(true);
    }
    // messy fixture inputs collapse to clean keys
    expect(writer.byDomain.has("asana.com")).toBe(true);
    expect(writer.byDomain.has("monday.com")).toBe(true);
    expect(writer.byDomain.has("clickup.com")).toBe(true);
    expect(writer.byDomain.has("shortcut.com")).toBe(true);
  });

  it("every record is role=battlefield with the source version stamped", () => {
    for (const c of written) {
      expect(c.role).toBe("battlefield");
      expect(c.source_versions.battlefield).toBe("fiber/find-similar-companies@v1");
    }
  });

  it("flags missing enrichment families (coverage honesty, not silent drops)", () => {
    const c = writer.byDomain.get("asana.com")!;
    expect(c.coverage_flags).toContain("firmographics_missing");
    expect(c.coverage_flags).toContain("offpage_missing");
    expect(c.coverage_flags).toContain("understanding_missing");
  });

  it("excludes the seed customer even when Fiber echoes it back", () => {
    expect(writer.byDomain.has("linear.app")).toBe(false);
  });

  it("dedupes apex/www and repeated domains to one row", () => {
    const asanaRows = written.filter((c) => c.domain === "asana.com");
    expect(asanaRows.length).toBe(1); // fixture has asana twice (URL form + bare)
  });

  it("forwards the normalized seed and limit to Fiber", async () => {
    const calls: unknown[] = [];
    const spyFiber: FiberClient = {
      async findSimilarCompanies(args) {
        calls.push(args);
        return [];
      },
    };
    await buildBattlefield(spyFiber, new InMemoryCompanyWriter(), {
      customerDomain: "https://www.Linear.app/",
      limit: 25,
    });
    expect(calls[0]).toEqual({ domain: "linear.app", limit: 25 });
  });
});
