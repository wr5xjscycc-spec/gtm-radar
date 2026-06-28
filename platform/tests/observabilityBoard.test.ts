// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { describe, it, expect } from "vitest";
import schema from "../../convex/schema";
import { api } from "../../convex/_generated/api";
import { opsSummary } from "../src/observability";

const modules = import.meta.glob("../../convex/**/!(*.config|*.example).ts");

describe("observability board (P1·6) — spend visible end to end", () => {
  it("records a cycle and the ops summary surfaces spend + budget health", async () => {
    const t = convexTest(schema, modules);
    const ws = await t.mutation(api.customers.createWorkspace, {
      name: "Acme", vertical: "v", own_domain: "acme.com", competitor_domains: [],
    });
    await t.mutation(api.records.recordCycle, {
      workspaceId: ws, cycle_id: "cycle-1", queries_issued: 40, calls_made: 120,
      spend_usd: 98.5, per_engine: { openai: { calls: 120, errors: 2 } }, ts: 1,
    });
    const runs = await t.query(api.board.runRecords, { workspaceId: ws });
    expect(runs).toHaveLength(1);
    const summary = opsSummary(runs as any);
    expect(summary.total_spend).toBe(98.5);
    expect(summary.within_budget).toBe(true);
    expect(summary.per_engine_error_rate.openai).toBeCloseTo(2 / 120, 4);
  });
});
