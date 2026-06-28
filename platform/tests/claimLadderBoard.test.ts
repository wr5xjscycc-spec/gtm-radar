// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { describe, it, expect } from "vitest";
import schema from "../../convex/schema";
import { api } from "../../convex/_generated/api";
import { makeClaim, RUNG } from "../src/claimLadder";

const modules = import.meta.glob("../../convex/**/!(*.config|*.example).ts");

// The claim-ladder gate enforced END TO END: data layer (board.diagnosis) +
// render guard (makeClaim). A model_fit alone NEVER licenses a causal claim.
describe("board.diagnosis — causal locked until a lift_result exists", () => {
  async function seedWithModelFit(t: any) {
    const ws = await t.mutation(api.customers.createWorkspace, {
      name: "Acme", vertical: "GTM analytics", own_domain: "acme.com", competitor_domains: [],
    });
    await t.mutation(api.records.insertModelFit, {
      workspaceId: ws, customer_id: ws, category: "GTM analytics", engine: "openai",
      coefficients: [
        { feature: "comparison_table", posterior_median: 0.8, ci_low: 0.2, ci_high: 1.4, noise_flag: false },
      ],
      prior_version: "r2d2-2026.06", top_hypotheses: ["comparison_table correlates; test it"],
      n_companies: 24, n_rows: 312,
    });
    return ws;
  }

  it("model_fit but NO lift_result -> rung 1 (hypothesis); causal render THROWS", async () => {
    const t = convexTest(schema, modules);
    const ws = await seedWithModelFit(t);
    const d = await t.query(api.board.diagnosis, { workspaceId: ws });

    expect(d.rung).toBe(1);
    expect(d.hasLiftResult).toBe(false);
    expect(d.liftResults).toEqual([]); // no causal payload emitted
    // the render guard agrees: a causal claim is impossible on this evidence
    expect(() =>
      makeClaim(RUNG.CAUSAL, { hasModelFit: true, hasLiftResult: d.hasLiftResult }),
    ).toThrow(/lift_result/);
  });

  it("once a lift_result exists -> rung 2 unlocks and causal renders", async () => {
    const t = convexTest(schema, modules);
    const ws = await seedWithModelFit(t);
    const exp = await t.mutation(api.records.upsertExperiment, {
      workspaceId: ws, customer_id: ws,
      pairs: [{ treatment_page: "https://acme.com/pricing", control_page: "https://acme.com/about" }],
      status: "complete",
    });
    await t.mutation(api.records.insertLiftResult, {
      workspaceId: ws, experiment_id: exp, estimate: 0.18, ci_low: 0.04, ci_high: 0.32,
      p_value: 0.012, verdict: "worked", claim_rung: 2, computed_at: 1,
    });

    const d = await t.query(api.board.diagnosis, { workspaceId: ws });
    expect(d.rung).toBe(2);
    expect(d.hasLiftResult).toBe(true);
    expect(d.liftResults).toHaveLength(1);
    expect(makeClaim(RUNG.CAUSAL, { hasLiftResult: d.hasLiftResult }).rung).toBe(RUNG.CAUSAL);
  });
});
