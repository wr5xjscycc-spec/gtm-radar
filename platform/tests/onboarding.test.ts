// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { describe, it, expect } from "vitest";
import schema from "../../convex/schema";
import { api } from "../../convex/_generated/api";

// In-process Convex (no network): proves the mutation layer enforces
// normalization and the board queries compute correctly. This is the P1·1
// "onboarding mutation tests" requirement + a guard on the whole write path.
const modules = import.meta.glob("../../convex/**/!(*.config|*.example).ts");

describe("createWorkspace — normalization enforced at the mutation boundary", () => {
  it("normalizes own_domain, dedupes+normalizes competitors, excludes own", async () => {
    const t = convexTest(schema, modules);
    const wsId = await t.mutation(api.customers.createWorkspace, {
      name: "Acme",
      vertical: "gtm-analytics",
      own_domain: "https://www.Acme.com/",
      competitor_domains: ["competitor.com", "https://rival.io/", "www.Acme.com"],
    });
    const ws = await t.query(api.customers.getWorkspace, { workspaceId: wsId });
    expect(ws!.own_domain).toBe("acme.com");
    expect(ws!.competitor_domains).toEqual(["competitor.com", "rival.io"]);
    expect(ws!.competitor_domains).not.toContain("acme.com");
  });

  it("rejects an own_domain that doesn't normalize to a key", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.customers.createWorkspace, {
        name: "x", vertical: "v", own_domain: "   ", competitor_domains: [],
      }),
    ).rejects.toThrow();
  });
});

describe("write path + board read are consistent", () => {
  it("upsertCompany normalizes the domain key; battlefield query sees it", async () => {
    const t = convexTest(schema, modules);
    const wsId = await t.mutation(api.customers.createWorkspace, {
      name: "A", vertical: "v", own_domain: "acme.com", competitor_domains: [],
    });
    await t.mutation(api.records.upsertCompany, {
      workspaceId: wsId, domain: "https://www.Acme.com/pricing", role: "customer",
    });
    const bf = await t.query(api.board.battlefield, { workspaceId: wsId });
    expect(bf).toHaveLength(1);
    expect(bf[0].domain).toBe("acme.com");
  });

  it("citationBoard computes cited/total per engine (the gut-punch)", async () => {
    const t = convexTest(schema, modules);
    const wsId = await t.mutation(api.customers.createWorkspace, {
      name: "A", vertical: "v", own_domain: "acme.com", competitor_domains: [],
    });
    const qId = await t.mutation(api.records.insertQuery, {
      workspaceId: wsId, customer_id: wsId, vertical: "v", text: "q",
      seed_source: "paa", target_engines: ["openai"],
    });
    const base = {
      workspaceId: wsId, query_id: qId, engine: "openai" as const,
      model_version: "m", run_idx: 0, position: null, ts: 1,
      window_tag: "baseline" as const,
    };
    await t.mutation(api.records.insertMeasurement, {
      ...base, page_url: "https://acme.com/pricing", appeared: false, cited: false,
      source_urls: ["competitor.com"],
    });
    await t.mutation(api.records.insertMeasurement, {
      ...base, page_url: "https://competitor.com/pricing", appeared: true, cited: true,
      position: 1, source_urls: ["competitor.com"],
    });
    const board = await t.query(api.board.citationBoard, { workspaceId: wsId });
    expect(board.perEngine.openai.cited).toBe(1);
    expect(board.perEngine.openai.total).toBe(2);
  });
});
