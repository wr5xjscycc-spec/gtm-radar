import { describe, it, expect } from "vitest";
import { buildLabelTable } from "../../src/quality/label-table";
import type { MeasurementAggregate } from "../../src/stats/aggregate";
import type { CandidatePage } from "../../src/contract-records";

// P2.4 Module 2 — model-ready label table for P4.
//
// Join aggregates -> candidate pool by EXACT page_url (the contract carries normalized URLs
// already; only company_domain is normalized via normalizeDomain). label = p_cited >= 0.5 ?
// "winner" : "loser" (tie -> winner). Aggregates with no matching pool page are surfaced in
// `unmatched`, never silently dropped. Row order follows input aggregate order (stable).
//
// Pure function only — pools/aggregates are constructed literals.

// Minimal aggregate factory; only the fields the table consumes are interesting, the rest are
// carried through verbatim so we can assert they pass through unchanged.
function agg(over: Partial<MeasurementAggregate> = {}): MeasurementAggregate {
  return {
    query_id: "q1",
    page_url: "https://example.com/pricing",
    engine: "openai",
    model_version: "gpt-x",
    k: 3,
    cited_count: 3,
    p_cited: 1.0,
    ci_low: 0.4,
    ci_high: 1.0,
    position_weight: 1.0,
    ...over,
  };
}

describe("buildLabelTable", () => {
  it("labels a cited aggregate (p_cited 1.0) a winner, attaching NORMALIZED company_domain + role from the pool", () => {
    const aggregates = [agg({ p_cited: 1.0, cited_count: 3, k: 3 })];
    // Pool company_domain is deliberately NON-normalized: scheme + WWW + mixed case + trailing
    // slash. The row's company_domain MUST come out normalized ("example.com"). If this fixture
    // were already normalized the assertion would pass even when normalizeDomain is never called.
    const pool: CandidatePage[] = [
      { company_domain: "https://WWW.Example.com/", url: "https://example.com/pricing", role: "candidate" },
    ];

    const table = buildLabelTable(aggregates, pool);

    expect(table.unmatched).toEqual([]);
    expect(table.rows).toHaveLength(1);
    const row = table.rows[0]!;
    expect(row.label).toBe("winner");
    expect(row.company_domain).toBe("example.com"); // observably normalized
    expect(row.role).toBe("candidate");
    // Aggregate fields pass through verbatim.
    expect(row.query_id).toBe("q1");
    expect(row.engine).toBe("openai");
    expect(row.page_url).toBe("https://example.com/pricing");
    expect(row.p_cited).toBe(1.0);
    expect(row.ci_low).toBe(0.4);
    expect(row.ci_high).toBe(1.0);
    expect(row.position_weight).toBe(1.0);
    expect(row.k).toBe(3);
    expect(row.model_version).toBe("gpt-x");
  });

  it("labels an uncited aggregate (p_cited 0.0) a loser", () => {
    const aggregates = [agg({ p_cited: 0.0, cited_count: 0, k: 3, position_weight: 0 })];
    const pool: CandidatePage[] = [
      { company_domain: "example.com", url: "https://example.com/pricing", role: "competitor" },
    ];

    const table = buildLabelTable(aggregates, pool);

    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]!.label).toBe("loser");
    expect(table.rows[0]!.role).toBe("competitor");
  });

  it("treats p_cited exactly 0.5 as a winner (tie -> cited)", () => {
    const aggregates = [agg({ p_cited: 0.5, cited_count: 2, k: 4 })];
    const pool: CandidatePage[] = [
      { company_domain: "example.com", url: "https://example.com/pricing", role: "candidate" },
    ];

    const table = buildLabelTable(aggregates, pool);

    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]!.label).toBe("winner");
  });

  it("surfaces an aggregate whose page_url is absent from the pool in `unmatched`, not in rows", () => {
    const matched = agg({ page_url: "https://example.com/pricing" });
    const missing = agg({ query_id: "q2", page_url: "https://nowhere.com/orphan" });
    const aggregates = [matched, missing];
    const pool: CandidatePage[] = [
      { company_domain: "example.com", url: "https://example.com/pricing", role: "candidate" },
    ];

    const table = buildLabelTable(aggregates, pool);

    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]!.page_url).toBe("https://example.com/pricing");
    // The orphan is surfaced by reference, never dropped.
    expect(table.unmatched).toHaveLength(1);
    expect(table.unmatched[0]).toBe(missing);
  });

  it("joins by EXACT url — a near-miss the URL would only match if re-normalized lands in `unmatched`", () => {
    // The aggregate page_url differs from the pool url ONLY by a trailing slash + www + case —
    // exactly the kind of difference normalizeDomain WOULD collapse. Because the path is joined
    // exactly (never re-normalized), this must NOT match.
    const aggregates = [agg({ page_url: "https://WWW.Example.com/Pricing/" })];
    const pool: CandidatePage[] = [
      { company_domain: "example.com", url: "https://example.com/pricing", role: "candidate" },
    ];

    const table = buildLabelTable(aggregates, pool);

    expect(table.rows).toEqual([]);
    expect(table.unmatched).toHaveLength(1);
    expect(table.unmatched[0]).toBe(aggregates[0]);
  });

  it("preserves per-engine rows: same page_url on two engines -> two rows from the one pool entry", () => {
    const aggregates = [
      agg({ engine: "openai", page_url: "https://example.com/pricing" }),
      agg({ engine: "perplexity", page_url: "https://example.com/pricing" }),
    ];
    const pool: CandidatePage[] = [
      { company_domain: "example.com", url: "https://example.com/pricing", role: "candidate" },
    ];

    const table = buildLabelTable(aggregates, pool);

    expect(table.rows).toHaveLength(2);
    expect(table.rows.map((r) => r.engine)).toEqual(["openai", "perplexity"]);
    // Both resolved the same pool entry — engines are never merged.
    expect(table.rows.every((r) => r.company_domain === "example.com")).toBe(true);
  });

  it("preserves input aggregate order (stable rows)", () => {
    const aggregates = [
      agg({ query_id: "qA", page_url: "https://a.com/p" }),
      agg({ query_id: "qB", page_url: "https://b.com/p" }),
      agg({ query_id: "qC", page_url: "https://c.com/p" }),
    ];
    const pool: CandidatePage[] = [
      { company_domain: "b.com", url: "https://b.com/p", role: "candidate" },
      { company_domain: "c.com", url: "https://c.com/p", role: "candidate" },
      { company_domain: "a.com", url: "https://a.com/p", role: "candidate" },
    ];

    const table = buildLabelTable(aggregates, pool);

    // Row order follows the AGGREGATE order, not the pool order.
    expect(table.rows.map((r) => r.query_id)).toEqual(["qA", "qB", "qC"]);
  });

  it("returns an empty table for empty inputs", () => {
    expect(buildLabelTable([], [])).toEqual({ rows: [], unmatched: [] });
    // Aggregates but no pool -> everything is unmatched, no rows.
    const a = agg();
    const table = buildLabelTable([a], []);
    expect(table.rows).toEqual([]);
    expect(table.unmatched).toEqual([a]);
  });
});
