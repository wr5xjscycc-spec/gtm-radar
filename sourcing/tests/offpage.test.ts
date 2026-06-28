// P3 · Phase 2 required test: off-page signal mapping tests (VENDORS MOCKED).
// Proves the three off-page sources (Fiber entity + SERP + Reddit) map to the
// contract `company.offpage`, that every field has a SINGLE vendor origin (no
// double-sourcing), that a real 0 survives while a missing signal stays
// undefined, and that enrichment is non-mutating, coverage-honest and resilient
// to a single vendor failing. No live network.

import { describe, it, expect } from "vitest";

import {
  mergeOffpage,
  enrichOffpage,
  OFFPAGE_VERSION,
  type OffpageFiberClient,
  type OffpageSerpClient,
  type OffpageRedditClient,
  type OffpageFiberEntityResponse,
  type OffpageSerpBrandResponse,
  type OffpageRedditResponse,
} from "../src/offpage";
import type { Company } from "../src/types";

// ── Representative full payloads, one per vendor ──
const fiberFull: OffpageFiberEntityResponse = {
  thirdparty_mentions: 124,
  backlink_density: 0.42,
  entity_cooccurrence: 0.71,
  wikipedia_presence: 1,
};
const serpFull: OffpageSerpBrandResponse = {
  brand_search_volume: 9000,
  g2_presence: 1,
  review_site_presence: 5,
};
const redditFull: OffpageRedditResponse = {
  reddit_presence: 33,
};

/** Minimal valid contract-shaped Company (role=battlefield, nothing enriched). */
function makeCompany(overrides: Partial<Company> = {}): Company {
  return {
    domain: "asana.com",
    name: "Asana",
    role: "battlefield",
    coverage_flags: [
      "firmographics_missing",
      "offpage_missing",
      "understanding_missing",
    ],
    source_versions: { battlefield: "fiber/find-similar-companies@v1" },
    ...overrides,
  };
}

function mockFiber(
  payload: OffpageFiberEntityResponse,
  onCall?: (args: { domain: string }) => void,
): OffpageFiberClient {
  return {
    async getEntitySignals(args) {
      onCall?.(args);
      return payload;
    },
  };
}
function mockSerp(
  payload: OffpageSerpBrandResponse,
  onCall?: (args: { domain: string; brand?: string }) => void,
): OffpageSerpClient {
  return {
    async getBrandSignals(args) {
      onCall?.(args);
      return payload;
    },
  };
}
function mockReddit(
  payload: OffpageRedditResponse,
  onCall?: (args: { domain: string; brand?: string }) => void,
): OffpageRedditClient {
  return {
    async getRedditPresence(args) {
      onCall?.(args);
      return payload;
    },
  };
}

describe("mergeOffpage — off-page signal mapping", () => {
  it("maps all eight contract fields from representative 3-vendor responses", () => {
    const out = mergeOffpage({ fiber: fiberFull, serp: serpFull, reddit: redditFull });
    expect(out).toEqual({
      thirdparty_mentions: 124,
      backlink_density: 0.42,
      entity_cooccurrence: 0.71,
      wikipedia_presence: 1,
      brand_search_volume: 9000,
      g2_presence: 1,
      review_site_presence: 5,
      reddit_presence: 33,
    });
    expect(Object.keys(out)).toHaveLength(8);
  });

  it("drops extra/unknown fields each vendor may return", () => {
    const out = mergeOffpage({
      fiber: { ...fiberFull, domain_authority: 88, raw_blob: { nested: true } },
      serp: { ...serpFull, serp_features: ["paa"], cpc: 4.2 },
      reddit: { ...redditFull, top_subreddit: "r/projectmanagement" },
    });
    expect(Object.keys(out).sort()).toEqual([
      "backlink_density",
      "brand_search_volume",
      "entity_cooccurrence",
      "g2_presence",
      "reddit_presence",
      "review_site_presence",
      "thirdparty_mentions",
      "wikipedia_presence",
    ]);
    expect(out).not.toHaveProperty("domain_authority");
    expect(out).not.toHaveProperty("cpc");
    expect(out).not.toHaveProperty("top_subreddit");
  });

  it("missing fields stay undefined; a real 0 is preserved as 0 (distinct from undefined)", () => {
    const out = mergeOffpage({
      // thirdparty_mentions is a TRUE measured 0 — must survive.
      fiber: { thirdparty_mentions: 0 },
      // brand_search_volume absent; g2_presence is a true 0.
      serp: { g2_presence: 0 },
      reddit: {},
    });
    // Real zeros preserved.
    expect(out.thirdparty_mentions).toBe(0);
    expect(out.g2_presence).toBe(0);
    expect(Object.prototype.hasOwnProperty.call(out, "thirdparty_mentions")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(out, "g2_presence")).toBe(true);
    // Absent signals stay undefined — and don't even appear as keys (no pollution).
    expect(out.backlink_density).toBeUndefined();
    expect(out.brand_search_volume).toBeUndefined();
    expect(out.reddit_presence).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(out, "reddit_presence")).toBe(false);
    // null / NaN / non-number readings are NOT mistaken for data.
    const noisy = mergeOffpage({
      fiber: { backlink_density: NaN, entity_cooccurrence: null as unknown as number },
      serp: { brand_search_volume: "9000" as unknown as number },
      reddit: {},
    });
    expect(noisy).toEqual({});
  });

  it("tolerates entirely-missing vendor parts (null / undefined)", () => {
    expect(mergeOffpage({})).toEqual({});
    expect(mergeOffpage({ fiber: null, serp: undefined, reddit: null })).toEqual({});
    // Only one vendor present -> only its fields appear.
    expect(mergeOffpage({ reddit: redditFull })).toEqual({ reddit_presence: 33 });
  });
});

describe("mergeOffpage — no double-source (single vendor origin per field)", () => {
  it("a field is read only from its owning vendor; a conflicting copy on another vendor is ignored", () => {
    // Each vendor tries to also supply a field it does NOT own, with a CONFLICTING
    // value. The documented source of truth must win every time.
    const out = mergeOffpage({
      // Fiber owns thirdparty_mentions (=124). Fiber ALSO leaks reddit_presence &
      // brand_search_volume it does not own — those must be ignored here.
      fiber: {
        ...fiberFull,
        reddit_presence: 999,
        brand_search_volume: 111,
      } as OffpageFiberEntityResponse,
      // SERP owns brand_search_volume (=9000). It leaks thirdparty_mentions it
      // does not own.
      serp: {
        ...serpFull,
        thirdparty_mentions: 777,
      } as OffpageSerpBrandResponse,
      // Reddit owns reddit_presence (=33). It leaks g2_presence it does not own.
      reddit: {
        ...redditFull,
        g2_presence: 888,
      } as OffpageRedditResponse,
    });

    // Owning vendor wins; the foreign copies are dropped.
    expect(out.thirdparty_mentions).toBe(124); // Fiber, not SERP's 777
    expect(out.brand_search_volume).toBe(9000); // SERP, not Fiber's 111
    expect(out.reddit_presence).toBe(33); // Reddit, not Fiber's 999
    expect(out.g2_presence).toBe(1); // SERP, not Reddit's 888
  });
});

describe("enrichOffpage — enrichment + provenance", () => {
  function fullClients() {
    return {
      fiber: mockFiber(fiberFull),
      serp: mockSerp(serpFull),
      reddit: mockReddit(redditFull),
    };
  }

  it("sets offpage, flips coverage flag, stamps source version", async () => {
    const enriched = await enrichOffpage(fullClients(), makeCompany());
    expect(enriched.offpage).toEqual({
      thirdparty_mentions: 124,
      backlink_density: 0.42,
      entity_cooccurrence: 0.71,
      wikipedia_presence: 1,
      brand_search_volume: 9000,
      g2_presence: 1,
      review_site_presence: 5,
      reddit_presence: 33,
    });
    expect(enriched.coverage_flags).not.toContain("offpage_missing");
    expect(enriched.source_versions.offpage).toBe(OFFPAGE_VERSION);
  });

  it("queries every vendor with the company's domain unchanged (join key intact)", async () => {
    const seen: Array<{ vendor: string; domain: string }> = [];
    const company = makeCompany({ domain: "monday.com" });
    const enriched = await enrichOffpage(
      {
        fiber: mockFiber(fiberFull, (a) => seen.push({ vendor: "fiber", domain: a.domain })),
        serp: mockSerp(serpFull, (a) => seen.push({ vendor: "serp", domain: a.domain })),
        reddit: mockReddit(redditFull, (a) => seen.push({ vendor: "reddit", domain: a.domain })),
      },
      company,
    );
    expect(seen.map((s) => s.domain)).toEqual(["monday.com", "monday.com", "monday.com"]);
    expect(enriched.domain).toBe("monday.com");
  });

  it("preserves other coverage flags, source versions, role and name", async () => {
    const enriched = await enrichOffpage(fullClients(), makeCompany());
    expect(enriched.coverage_flags).toContain("firmographics_missing");
    expect(enriched.coverage_flags).toContain("understanding_missing");
    expect(enriched.source_versions.battlefield).toBe("fiber/find-similar-companies@v1");
    expect(enriched.role).toBe("battlefield");
    expect(enriched.name).toBe("Asana");
  });

  it("does NOT mutate the input company (immutability)", async () => {
    const company = makeCompany();
    const snapshot = structuredClone(company);

    const enriched = await enrichOffpage(fullClients(), company);

    // Input is byte-identical to before the call.
    expect(company).toEqual(snapshot);
    expect(company.offpage).toBeUndefined();
    expect(company.coverage_flags).toContain("offpage_missing");
    expect(company.source_versions.offpage).toBeUndefined();
    // And a genuinely new object was returned.
    expect(enriched).not.toBe(company);
    expect(enriched.coverage_flags).not.toBe(company.coverage_flags);
    expect(enriched.source_versions).not.toBe(company.source_versions);
  });
});

describe("enrichOffpage — coverage honesty", () => {
  it("all three vendors blank/empty -> offpage_missing stays true, version unstamped", async () => {
    const enriched = await enrichOffpage(
      {
        fiber: mockFiber({ junk: "ignored" } as OffpageFiberEntityResponse),
        serp: mockSerp({} as OffpageSerpBrandResponse),
        reddit: mockReddit({} as OffpageRedditResponse),
      },
      makeCompany(),
    );
    expect(enriched.offpage).toEqual({});
    expect(enriched.coverage_flags).toContain("offpage_missing");
    expect(enriched.source_versions.offpage).toBeUndefined();
  });
});

describe("enrichOffpage — resilience (one vendor down)", () => {
  it("a rejecting vendor does not throw; surviving vendors' signals still land", async () => {
    const explodingFiber: OffpageFiberClient = {
      async getEntitySignals() {
        throw new Error("fiber MCP timeout");
      },
    };
    const enriched = await enrichOffpage(
      {
        fiber: explodingFiber,
        serp: mockSerp(serpFull),
        reddit: mockReddit(redditFull),
      },
      makeCompany(),
    );
    // No Fiber/entity fields, but SERP + Reddit signals survived.
    expect(enriched.offpage).toEqual({
      brand_search_volume: 9000,
      g2_presence: 1,
      review_site_presence: 5,
      reddit_presence: 33,
    });
    expect(enriched.coverage_flags).not.toContain("offpage_missing");
    expect(enriched.source_versions.offpage).toBe(OFFPAGE_VERSION);
  });

  it("ALL vendors down -> no throw, row stays honestly flagged missing", async () => {
    const boom = () => {
      throw new Error("down");
    };
    const enriched = await enrichOffpage(
      {
        fiber: { async getEntitySignals() { return boom(); } },
        serp: { async getBrandSignals() { return boom(); } },
        reddit: { async getRedditPresence() { return boom(); } },
      },
      makeCompany(),
    );
    expect(enriched.offpage).toEqual({});
    expect(enriched.coverage_flags).toContain("offpage_missing");
    expect(enriched.source_versions.offpage).toBeUndefined();
  });
});
