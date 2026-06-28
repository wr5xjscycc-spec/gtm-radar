// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { describe, it, expect } from "vitest";
import schema from "../../convex/schema";
import { api } from "../../convex/_generated/api";

const modules = import.meta.glob("../../convex/**/!(*.config|*.example).ts");

describe("board.gutPunch — you vs competitors per engine (in-process Convex)", () => {
  it("classifies pages by domain and finds the top competitor", async () => {
    const t = convexTest(schema, modules);
    const ws = await t.mutation(api.customers.createWorkspace, {
      name: "Acme", vertical: "v", own_domain: "acme.com",
      competitor_domains: ["competitor.com", "rival.io"],
    });
    const q = await t.mutation(api.records.insertQuery, {
      workspaceId: ws, customer_id: ws, vertical: "v", text: "q",
      seed_source: "paa", target_engines: ["openai"],
    });
    const base = {
      workspaceId: ws, query_id: q, engine: "openai" as const,
      model_version: "m", run_idx: 0, position: null, ts: 1, window_tag: "baseline" as const,
    };
    // you: not cited
    await t.mutation(api.records.insertMeasurement, {
      ...base, page_url: "https://acme.com/pricing", appeared: false, cited: false,
      source_urls: ["competitor.com", "g2.com"],
    });
    // competitor.com: cited
    await t.mutation(api.records.insertMeasurement, {
      ...base, page_url: "https://competitor.com/pricing", appeared: true, cited: true,
      position: 1, source_urls: ["competitor.com"],
    });

    const gp = await t.query(api.board.gutPunch, { workspaceId: ws });
    const e = gp.perEngine.openai;
    expect(gp.own_domain).toBe("acme.com");
    expect(e.you).toEqual({ cited: 0, total: 1 });
    expect(e.topCompetitor).toMatchObject({ domain: "competitor.com", cited: 1, total: 1 });
    expect(e.citedSources).toContain("g2.com"); // "cited from these sources"
  });
});
