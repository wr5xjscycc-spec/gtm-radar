// Card B · task #1 + #3 — sourcing edge logic (mocked vendors, no network).
//
// Two concerns the `convex/sourcing.ts` action and `scripts/enrich-pages.ts` edge
// runner depend on are unit-tested here, in the isolated sourcing workspace:
//
//  1. buildBattlefield THIN-SLICE logic: with an EMPTY Fiber stub (no live battlefield
//     discovery) `buildCompanyLayer` must write EXACTLY the customer + the known
//     competitors and NO battlefield rows. This mirrors what `convex/sourcing.ts`
//     does (empty fiber + a CompanyWriter over `ctx.runMutation(upsertCompany)`); we
//     exercise the same pure logic with a mock CompanyWriter that records exactly
//     what the action would forward to the mutation.
//
//     NOTE: the Convex `action` wrapper itself (workspace -> args mapping, the
//     runMutation adapter) is NOT reachable from this workspace without compiling
//     convex/ (forbidden under lane isolation). This covers the shared pure logic.
//
//  2. enrichPages -> upsertPage path coherence: with a mock OrangeSliceClient, every
//     `Page` enrichPages produces must carry the EXACT fields `api.records.upsertPage`
//     requires, with a role in its accepted union — proving the edge runner's write
//     loop is coherent without a live scrape or a live Convex deploy.

import { describe, it, expect } from "vitest";

import {
  buildCompanyLayer,
  type CompanyWriter,
} from "../src/battlefield";
import type { FiberClient } from "../src/fiber";
import { enrichPages, type OrangeSliceClient, type OrangeSlicePage } from "../src/content";
import { isNormalizedDomain } from "../src/domain";
import type { Company } from "../src/types";

/** Records exactly the Company objects the CompanyWriter port receives. */
class RecordingCompanyWriter implements CompanyWriter {
  readonly written: Company[] = [];
  async upsertCompany(company: Company): Promise<void> {
    this.written.push(company);
  }
}

/** The empty Fiber stub the thin-slice action injects (no live battlefield). */
const EMPTY_FIBER: FiberClient = {
  async findSimilarCompanies() {
    return [];
  },
};

describe("buildBattlefield thin slice (empty Fiber): customer + competitors only", () => {
  // A workspace-shaped input, matching what `ctx.runQuery(getWorkspace)` returns.
  const workspace = {
    name: "Linear",
    own_domain: "linear.app",
    competitor_domains: ["asana.com", "monday.com"],
  };

  async function run() {
    const writer = new RecordingCompanyWriter();
    const companies = await buildCompanyLayer(EMPTY_FIBER, writer, {
      customerDomain: workspace.own_domain,
      customerName: workspace.name,
      competitorDomains: workspace.competitor_domains,
    });
    return { writer, companies };
  }

  it("writes the customer row (role=customer) with the workspace name", async () => {
    const { writer } = await run();
    const customer = writer.written.find((c) => c.role === "customer");
    expect(customer).toBeDefined();
    expect(customer!.domain).toBe("linear.app");
    expect(customer!.name).toBe("Linear");
  });

  it("writes every known competitor (role=competitor)", async () => {
    const { writer } = await run();
    const competitors = writer.written.filter((c) => c.role === "competitor");
    expect(competitors.map((c) => c.domain).sort()).toEqual(["asana.com", "monday.com"]);
  });

  it("writes NO battlefield rows (no live Fiber discovery in the thin slice)", async () => {
    const { writer } = await run();
    expect(writer.written.some((c) => c.role === "battlefield")).toBe(false);
  });

  it("writes exactly [customer, ...competitors] — one row per normalized domain", async () => {
    const { writer, companies } = await run();
    expect(writer.written).toHaveLength(3); // 1 customer + 2 competitors, 0 battlefield
    expect(companies).toHaveLength(3);
    // write order: customer first, then competitors (battlefield would follow, none here)
    expect(writer.written.map((c) => c.role)).toEqual(["customer", "competitor", "competitor"]);
    for (const c of writer.written) {
      expect(isNormalizedDomain(c.domain), `not normalized: ${c.domain}`).toBe(true);
    }
  });

  it("stamps fresh coverage flags and no battlefield source version (enrichment not run)", async () => {
    const { writer } = await run();
    for (const c of writer.written) {
      expect(c.coverage_flags).toEqual([
        "firmographics_missing",
        "offpage_missing",
        "understanding_missing",
      ]);
      // No row came from Fiber, so none carries the battlefield provenance.
      expect(c.source_versions.battlefield).toBeUndefined();
    }
  });

  it("normalizes messy onboarding input to clean keys (mirrors the customers boundary)", async () => {
    const writer = new RecordingCompanyWriter();
    await buildCompanyLayer(EMPTY_FIBER, writer, {
      customerDomain: "https://www.Linear.app/",
      customerName: "Linear",
      competitorDomains: ["HTTPS://www.Asana.com/", "Monday.com/pricing"],
    });
    expect(writer.written.map((c) => c.domain).sort()).toEqual([
      "asana.com",
      "linear.app",
      "monday.com",
    ]);
  });
});

// ── enrichPages -> upsertPage path coherence ────────────────────────────────────

/** A mock OrangeSlice client returning fixed scraped pages — never hits network. */
function mockOrange(pages: OrangeSlicePage[]): OrangeSliceClient {
  return {
    async scrapeCandidatePages() {
      return pages;
    },
  };
}

/** The required (non-optional) arg names on `api.records.upsertPage` (besides workspaceId). */
const UPSERT_PAGE_REQUIRED = ["company_domain", "url", "role", "extractor_version"] as const;
/** Roles `upsertPage`'s validator accepts. */
const UPSERT_PAGE_ROLES = ["candidate", "customer", "competitor"];

describe("enrichPages -> upsertPage path coherence (mock OrangeSlice, no network)", () => {
  const NOW = "2026-06-28T00:00:00.000Z";

  it("produces page records whose fields match upsertPage's args exactly", async () => {
    const orange = mockOrange([
      { url: "https://linear.app/features", html: "<h1>Features</h1><p>Track issues.</p>" },
      { url: "https://linear.app/pricing", html: "<h1>Pricing</h1><p>Plans.</p>" },
    ]);
    const pages = await enrichPages(orange, { companyDomain: "linear.app", now: NOW });

    expect(pages.length).toBe(2);
    for (const page of pages) {
      // Every required upsertPage arg is present and the right type.
      for (const key of UPSERT_PAGE_REQUIRED) {
        expect(page, `missing ${key}`).toHaveProperty(key);
      }
      expect(typeof page.company_domain).toBe("string");
      expect(typeof page.url).toBe("string");
      expect(UPSERT_PAGE_ROLES).toContain(page.role); // role within the accepted union
      expect(typeof page.extractor_version).toBe("string");
      // optional-but-present fields the runner forwards:
      expect(typeof page.scraped_at).toBe("number");
      expect(typeof page.cache_key).toBe("string");
      expect(page.content_features).toBeDefined();
      // keys are normalized (the cross-lane join contract)
      expect(isNormalizedDomain(page.company_domain)).toBe(true);
    }
    // FK (company_domain) is the normalized seed; default role is candidate.
    expect(pages.every((p) => p.company_domain === "linear.app")).toBe(true);
    expect(pages.every((p) => p.role === "candidate")).toBe(true);
    // scraped_at reflects the INJECTED now (reproducible, no Date.now()).
    expect(pages[0].scraped_at).toBe(Date.parse(NOW));
  });

  it("returns nothing to upsert when the scrape yields no usable pages", async () => {
    const pages = await enrichPages(mockOrange([]), { companyDomain: "linear.app", now: NOW });
    expect(pages).toEqual([]);
  });
});
