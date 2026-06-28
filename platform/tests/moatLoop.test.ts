// @vitest-environment edge-runtime
// The COMPOUND step — the wire that closes the alpha loop. Verifies (1) the
// interventional dataset is READ back and pooled ACROSS customers in a category
// (cross-customer compounding), with feature-level aggregates only (tenant
// isolation), and (2) pickFeatureToChange prefers a proven measured lift over a
// mere correlational hypothesis.
import { convexTest } from "convex-test";
import { describe, it, expect } from "vitest";
import schema from "../../convex/schema";
import { api } from "../../convex/_generated/api";
import { pickFeatureToChange } from "../../convex/diagnose";

const modules = import.meta.glob("../../convex/**/!(*.config|*.example).ts");

async function workspace(t: any, name: string, domain: string, vertical: string) {
  return await t.mutation(api.customers.createWorkspace, {
    name, vertical, own_domain: domain, competitor_domains: [],
  });
}
async function experiment(t: any, ws: any) {
  return await t.mutation(api.records.upsertExperiment, {
    workspaceId: ws, customer_id: ws,
    pairs: [{ treatment_page: "https://x.com/a", control_page: "https://x.com/b" }],
    status: "complete",
  });
}

describe("moat.provenLiftsByCategory — the read-back / COMPOUND wire", () => {
  it("pools measured lift ACROSS customers in a category (cross-customer moat)", async () => {
    const t = convexTest(schema, modules);
    const cat = "serverless database";
    // Two DIFFERENT customers, same category, both ran an experiment on comparison_table.
    const a = await workspace(t, "Convex", "convex.dev", cat);
    const b = await workspace(t, "Acme", "acme.com", cat);
    const ea = await experiment(t, a);
    const eb = await experiment(t, b);
    await t.mutation(api.records.insertIntervention, {
      workspaceId: a, feature_changed: "comparison_table", category: cat, engine: "openai",
      measured_lift: 0.12, ci_low: 0.06, ci_high: 0.18, experiment_id: ea, recorded_at: 1,
    });
    await t.mutation(api.records.insertIntervention, {
      workspaceId: b, feature_changed: "comparison_table", category: cat, engine: "openai",
      measured_lift: 0.16, ci_low: 0.10, ci_high: 0.22, experiment_id: eb, recorded_at: 2,
    });

    // Customer A asks: it sees the POOLED result incl. customer B's experiment.
    const proven = await t.query(api.moat.provenLiftsByCategory, {
      workspaceId: a, category: cat,
    });
    expect(proven).toHaveLength(1);
    expect(proven[0].feature).toBe("comparison_table");
    expect(proven[0].n).toBe(2); // both customers' experiments pooled
    expect(proven[0].mean_lift).toBeGreaterThan(0.12);
    expect(proven[0].mean_lift).toBeLessThan(0.16); // weighted mean between the two
    // tenant isolation: only feature-level aggregate fields, no customer identifiers
    expect(Object.keys(proven[0]).sort()).toEqual(
      ["ci_high", "ci_low", "engine", "feature", "mean_lift", "n"].sort(),
    );
  });

  it("does not pool across DIFFERENT categories", async () => {
    const t = convexTest(schema, modules);
    const a = await workspace(t, "Convex", "convex.dev", "serverless database");
    const ea = await experiment(t, a);
    await t.mutation(api.records.insertIntervention, {
      workspaceId: a, feature_changed: "comparison_table", category: "serverless database",
      engine: "openai", measured_lift: 0.12, ci_low: 0.06, ci_high: 0.18, experiment_id: ea, recorded_at: 1,
    });
    const other = await t.query(api.moat.provenLiftsByCategory, {
      workspaceId: a, category: "project management",
    });
    expect(other).toEqual([]); // empty for an unrelated category (cold start)
  });
});

describe("pickFeatureToChange — proven measured lift outranks correlation", () => {
  const fits = [{
    coefficients: [
      { feature: "direct_answer_first", posterior_median: 0.9, noise_flag: false },
      { feature: "comparison_table", posterior_median: 0.3, noise_flag: false },
    ],
    top_hypotheses: ["direct_answer_first"],
  }];

  it("with no proven lifts, falls back to the top correlational coefficient", () => {
    expect(pickFeatureToChange(fits)).toBe("direct_answer_first");
  });

  it("a DECISIVE positive measured lift beats a stronger mere correlation", () => {
    const proven = [
      { feature: "comparison_table", mean_lift: 0.14, ci_low: 0.08 }, // measured, decisive
    ];
    expect(pickFeatureToChange(fits, proven)).toBe("comparison_table");
  });

  it("a measured lift whose CI crosses zero does NOT win (not decisive)", () => {
    const proven = [
      { feature: "comparison_table", mean_lift: 0.05, ci_low: -0.02 }, // crosses zero
    ];
    expect(pickFeatureToChange(fits, proven)).toBe("direct_answer_first");
  });
});
