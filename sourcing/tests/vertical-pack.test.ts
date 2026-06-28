// P3 · Phase 6 required test: vertical-pack validation tests.
//
// Proves the launch-vertical curation + validation pipeline inside the lane with NO
// network. Asserts: the anti-horizontal gate (cross-vertical queries excluded AND
// surfaced as an issue), dedupe by normalized text, the real-seed ratio floor, the
// size floor, the CMS-target gate, and the honesty rule (an invalid pack is still
// RETURNED with populated issues, never thrown). Small inline fixtures; minQueries is
// overridden to keep sets tiny.

import { describe, it, expect } from "vitest";

import {
  buildVerticalPack,
  curateQueries,
  isSingleVertical,
  VERTICAL_PACK_VERSION,
  DEFAULT_MIN_QUERIES,
  DEFAULT_MIN_REAL_RATIO,
} from "../src/vertical-pack";
import { seedSourceRatio } from "../src/queries";
import type { CmsTarget, Engine, Query, SeedSource } from "../src/types";

const VERTICAL = "project-management";
const ENGINES: Engine[] = ["openai", "perplexity", "gemini"];

let idCounter = 0;
/** Build a minimal Query; defaults to the target vertical. */
function q(
  text: string,
  seed_source: SeedSource = "keyword",
  vertical: string = VERTICAL,
): Query {
  return {
    id: `q-${idCounter++}`,
    customer_id: "cust-1",
    vertical,
    text,
    seed_source,
    target_engines: ENGINES,
  };
}

function cms(vertical: string = VERTICAL): CmsTarget {
  return { vertical, cms: "webflow", destination: "collections/blog" };
}

/** N distinct real (keyword) queries in the target vertical. */
function realQueries(n: number): Query[] {
  return Array.from({ length: n }, (_, i) => q(`real query ${i}`, "keyword"));
}

describe("vertical-pack metadata + defaults", () => {
  it("exposes a stable pack version and documented default gates", () => {
    expect(VERTICAL_PACK_VERSION).toBe("vertical-pack@v1");
    expect(DEFAULT_MIN_QUERIES).toBe(50);
    expect(DEFAULT_MIN_REAL_RATIO).toBe(0.4);
  });
});

describe("vertical-pack validation tests — happy path", () => {
  it("validates a single-vertical, healthy-ratio pack with a matching CMS target", () => {
    const queries = realQueries(4); // all keyword → realRatio 1.0
    const pack = buildVerticalPack({
      vertical: VERTICAL,
      queries,
      cmsTargets: [cms()],
      minQueries: 3,
    });

    expect(pack.validated).toBe(true);
    expect(pack.issues).toEqual([]);
    expect(pack.vertical).toBe(VERTICAL);
    expect(pack.version).toBe(VERTICAL_PACK_VERSION);
    expect(pack.queries).toHaveLength(4);
    expect(pack.cms_targets).toEqual([cms()]);
    expect(pack.seed_source_ratio).toEqual(seedSourceRatio(queries));
    expect(pack.seed_source_ratio.realRatio).toBe(1);
  });
});

describe("vertical-pack validation tests — ANTI-HORIZONTAL gate", () => {
  it("excludes off-vertical queries and records a cross-vertical issue", () => {
    const queries: Query[] = [
      ...realQueries(3),
      q("crm pipeline stages", "keyword", "sales-crm"),
      q("hr onboarding checklist", "paa", "hr-tech"),
    ];
    const pack = buildVerticalPack({
      vertical: VERTICAL,
      queries,
      cmsTargets: [cms()],
      minQueries: 3,
    });

    // curated pack is single-vertical only
    expect(pack.queries).toHaveLength(3);
    expect(isSingleVertical(pack.queries, VERTICAL)).toBe(true);
    expect(pack.queries.every((x) => x.vertical === VERTICAL)).toBe(true);

    // contamination surfaced
    expect(pack.validated).toBe(false);
    const issue = pack.issues.find((s) => /cross-vertical/i.test(s));
    expect(issue).toBeDefined();
    expect(issue).toMatch(/sales-crm/);
    expect(issue).toMatch(/hr-tech/);
  });
});

describe("vertical-pack validation tests — dedupe", () => {
  it("collapses case/whitespace duplicate texts to one and does NOT flag it as an issue", () => {
    const queries: Query[] = [
      q("Best Issue Tracker", "keyword"),
      q("  best   issue tracker ", "paa"),
      q("best issue tracker", "reddit"),
      q("sprint planning tips", "keyword"),
    ];
    const curated = curateQueries(queries, VERTICAL);
    expect(curated).toHaveLength(2); // "best issue tracker" collapsed + the distinct one

    const pack = buildVerticalPack({
      vertical: VERTICAL,
      queries,
      cmsTargets: [cms()],
      minQueries: 2,
    });
    expect(pack.queries).toHaveLength(2);
    expect(pack.validated).toBe(true);
    expect(pack.issues).toEqual([]);
    // dedupe is curation, never a recorded issue
    expect(pack.issues.some((s) => /dup/i.test(s))).toBe(false);
  });
});

describe("vertical-pack validation tests — RATIO gate", () => {
  it("fails when llm_expand dominates (realRatio below floor) and surfaces the number", () => {
    const queries: Query[] = [
      q("real one", "keyword"),
      ...Array.from({ length: 9 }, (_, i) => q(`expanded ${i}`, "llm_expand")),
    ];
    const pack = buildVerticalPack({
      vertical: VERTICAL,
      queries,
      cmsTargets: [cms()],
      minQueries: 1,
      minRealRatio: 0.4,
    });

    expect(pack.seed_source_ratio.realRatio).toBeCloseTo(0.1, 5);
    expect(pack.validated).toBe(false);
    const issue = pack.issues.find((s) => /real-seed ratio/i.test(s));
    expect(issue).toBeDefined();
    expect(issue).toMatch(/0\.100/); // the surfaced number
  });
});

describe("vertical-pack validation tests — SIZE gate", () => {
  it("fails when curated count is below minQueries", () => {
    const pack = buildVerticalPack({
      vertical: VERTICAL,
      queries: realQueries(2),
      cmsTargets: [cms()],
      minQueries: 5,
    });
    expect(pack.validated).toBe(false);
    const issue = pack.issues.find((s) => /too small/i.test(s));
    expect(issue).toBeDefined();
    expect(issue).toMatch(/< minimum 5/);
  });
});

describe("vertical-pack validation tests — CMS gate", () => {
  it("fails and excludes mismatched-vertical CMS targets", () => {
    const pack = buildVerticalPack({
      vertical: VERTICAL,
      queries: realQueries(3),
      cmsTargets: [cms("sales-crm"), cms("hr-tech")],
      minQueries: 3,
    });
    expect(pack.cms_targets).toHaveLength(0); // mismatched targets excluded
    expect(pack.validated).toBe(false);
    expect(pack.issues.some((s) => /CMS target/i.test(s))).toBe(true);
  });

  it("fails when there are zero CMS targets at all", () => {
    const pack = buildVerticalPack({
      vertical: VERTICAL,
      queries: realQueries(3),
      cmsTargets: [],
      minQueries: 3,
    });
    expect(pack.validated).toBe(false);
    expect(pack.issues.some((s) => /no CMS target/i.test(s))).toBe(true);
  });
});

describe("vertical-pack validation tests — honesty", () => {
  it("STILL returns an invalid pack (never throws) with populated issues + curated work", () => {
    const queries: Query[] = [
      q("real one", "keyword"),
      q("off vertical thing", "keyword", "sales-crm"),
    ];
    let pack: ReturnType<typeof buildVerticalPack> | undefined;
    expect(() => {
      pack = buildVerticalPack({
        vertical: VERTICAL,
        queries,
        cmsTargets: [],
        minQueries: 50, // force a size failure too
      });
    }).not.toThrow();

    expect(pack).toBeDefined();
    expect(pack!.validated).toBe(false);
    expect(pack!.issues.length).toBeGreaterThan(0);
    // work is preserved, not discarded
    expect(pack!.queries).toHaveLength(1);
    expect(pack!.version).toBe(VERTICAL_PACK_VERSION);
    // multiple gates surfaced together (cross-vertical + size + CMS)
    expect(pack!.issues.some((s) => /cross-vertical/i.test(s))).toBe(true);
    expect(pack!.issues.some((s) => /too small/i.test(s))).toBe(true);
    expect(pack!.issues.some((s) => /CMS target/i.test(s))).toBe(true);
  });
});

describe("vertical-pack validation tests — gate boundaries", () => {
  it("size gate passes exactly AT the minimum (>= not >)", () => {
    const pack = buildVerticalPack({
      vertical: VERTICAL,
      queries: realQueries(3),
      cmsTargets: [cms()],
      minQueries: 3, // curated === min → still valid
    });
    expect(pack.validated).toBe(true);
    expect(pack.issues).toEqual([]);
  });

  it("real-seed ratio passes exactly AT the floor (0.4)", () => {
    // 2 real + 3 llm_expand = 5 → realRatio 0.4, exactly the floor.
    const queries: Query[] = [
      q("real a", "keyword"),
      q("real b", "paa"),
      q("exp a", "llm_expand"),
      q("exp b", "llm_expand"),
      q("exp c", "llm_expand"),
    ];
    const pack = buildVerticalPack({ vertical: VERTICAL, queries, cmsTargets: [cms()], minQueries: 5 });
    expect(pack.seed_source_ratio.realRatio).toBeCloseTo(0.4, 10);
    expect(pack.validated).toBe(true); // 0.4 >= 0.4
  });
});

describe("vertical-pack validation tests — vertical slug matched case-insensitively", () => {
  it("does NOT mislabel a casing/whitespace-variant vertical as cross-vertical contamination", () => {
    const queries = [
      q("a", "keyword", "Project-Management"),
      q("b", "keyword", "  project-management  "),
    ];
    const pack = buildVerticalPack({
      vertical: VERTICAL,
      queries,
      cmsTargets: [cms("PROJECT-MANAGEMENT")],
      minQueries: 2,
    });
    expect(pack.queries).toHaveLength(2); // both kept, none excluded
    expect(pack.cms_targets).toHaveLength(1); // casing-variant CMS target accepted
    expect(pack.issues.some((s) => /cross-vertical/i.test(s))).toBe(false); // no false signal
    expect(pack.validated).toBe(true);
    expect(isSingleVertical(queries, VERTICAL)).toBe(true);
    expect(curateQueries(queries, VERTICAL)).toHaveLength(2);
  });
});
