// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { describe, it, expect } from "vitest";
import schema from "../../convex/schema";
import { api, internal } from "../../convex/_generated/api";

const modules = import.meta.glob("../../convex/**/!(*.config|*.example).ts");

async function newExperiment(t: any) {
  const ws = await t.mutation(api.customers.createWorkspace, {
    name: "Acme", vertical: "v", own_domain: "acme.com", competitor_domains: [],
  });
  const exp = await t.mutation(api.records.upsertExperiment, {
    workspaceId: ws, customer_id: ws,
    pairs: [{ treatment_page: "https://acme.com/pricing", control_page: "https://acme.com/about" }],
    status: "designing",
  });
  return { ws, exp };
}

describe("experiment compliance gate (data layer)", () => {
  it("cannot go 'running' without publishing first", async () => {
    const t = convexTest(schema, modules);
    const { exp } = await newExperiment(t);
    await expect(t.mutation(api.experiments.recordPublish, { experimentId: exp })).rejects.toThrow();
  });

  it("designing -> awaiting_publish -> running (publish event) is allowed", async () => {
    const t = convexTest(schema, modules);
    const { ws, exp } = await newExperiment(t);
    await t.mutation(api.experiments.requestPublish, { experimentId: exp });
    const ts = await t.mutation(api.experiments.recordPublish, { experimentId: exp });
    expect(typeof ts).toBe("number");
    const feed = await t.query(api.experiments.consoleFeed, { workspaceId: ws });
    expect(feed[0].status).toBe("running");
  });

  it("console feed HIDES controls (Hawthorne) and gates Rung-2 on a lift_result", async () => {
    const t = convexTest(schema, modules);
    const { ws, exp } = await newExperiment(t);
    let feed = await t.query(api.experiments.consoleFeed, { workspaceId: ws });
    expect(feed[0].treatments).toEqual(["https://acme.com/pricing"]);
    expect(JSON.stringify(feed[0])).not.toContain("/about"); // control never exposed
    expect(feed[0].lift).toBeNull(); // no causal claim yet

    await t.mutation(api.records.insertLiftResult, {
      workspaceId: ws, experiment_id: exp, estimate: 0.18, ci_low: 0.04, ci_high: 0.32,
      p_value: 0.012, verdict: "worked", claim_rung: 2, computed_at: 1,
    });
    feed = await t.query(api.experiments.consoleFeed, { workspaceId: ws });
    expect(feed[0].lift?.verdict).toBe("worked"); // Rung-2 now available
  });

  it("expireStaleSlots expires a 14-day-old unpublished slot", async () => {
    const t = convexTest(schema, modules);
    const { ws, exp } = await newExperiment(t);
    await t.mutation(api.experiments.requestPublish, { experimentId: exp });
    // backdate awaiting_since beyond 14 days
    await t.run(async (ctx: any) => {
      await ctx.db.patch(exp, { awaiting_since: Date.now() - 15 * 24 * 60 * 60 * 1000 });
    });
    const res = await t.mutation(internal.experiments.expireStaleSlots, {});
    expect(res.expired).toBe(1);
    const feed = await t.query(api.experiments.consoleFeed, { workspaceId: ws });
    expect(feed[0].status).toBe("expired");
  });
});
