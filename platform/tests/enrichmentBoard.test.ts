// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { describe, it, expect } from "vitest";
import schema from "../../convex/schema";
import { api } from "../../convex/_generated/api";
import { llmExpandRatio, coverageSummary } from "../src/enrichmentReview";

const modules = import.meta.glob("../../convex/**/!(*.config|*.example).ts");

describe("P1·2 enrichment/query review board queries (in-process Convex)", () => {
  it("board.queries returns the set; the review helper flags an ungrounded set", async () => {
    const t = convexTest(schema, modules);
    const ws = await t.mutation(api.customers.createWorkspace, {
      name: "A", vertical: "v", own_domain: "acme.com", competitor_domains: [],
    });
    for (const ss of ["llm_expand", "llm_expand", "paa"] as const) {
      await t.mutation(api.records.insertQuery, {
        workspaceId: ws, customer_id: ws, vertical: "v", text: "q",
        seed_source: ss, target_engines: ["openai"],
      });
    }
    const qs = await t.query(api.board.queries, { workspaceId: ws });
    expect(qs).toHaveLength(3);
    expect(llmExpandRatio(qs).tooHigh).toBe(true); // 2/3 ungrounded -> surfaced
  });

  it("board.pages feeds the feature-vector inspector; coverage surfaces gaps", async () => {
    const t = convexTest(schema, modules);
    const ws = await t.mutation(api.customers.createWorkspace, {
      name: "A", vertical: "v", own_domain: "acme.com", competitor_domains: [],
    });
    await t.mutation(api.records.upsertCompany, {
      workspaceId: ws, domain: "acme.com", role: "customer",
      offpage: { thirdparty_mentions: 3 }, coverage_flags: ["low_offpage_coverage"],
    });
    await t.mutation(api.records.upsertPage, {
      workspaceId: ws, company_domain: "acme.com", url: "https://acme.com/pricing",
      role: "candidate", extractor_version: "v1", content_features: { word_count: 480 },
    });
    const pgs = await t.query(api.board.pages, { workspaceId: ws });
    expect(pgs).toHaveLength(1);
    expect(pgs[0].content_features?.word_count).toBe(480);

    const bf = await t.query(api.board.battlefield, { workspaceId: ws });
    const cov = coverageSummary(bf[0] as any);
    expect(cov.present).toContain("thirdparty_mentions");
    expect(cov.flags).toContain("low_offpage_coverage");
  });
});
