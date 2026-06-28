/**
 * Sourcing action — build the live company "battlefield" for one workspace.
 *
 * Thin-slice (Card B, no live Fiber): the company layer is sourced ENTIRELY from
 * the workspace's own onboarding input — `own_domain` (role=customer) plus
 * `competitor_domains` (role=competitor). Fiber `find-similar-companies` is the
 * future battlefield expander; until that's wired we inject an EMPTY Fiber stub so
 * `buildCompanyLayer` writes exactly the customer + the known competitors (no
 * battlefield discovery rows). The seam is identical, so dropping a real
 * `createFiberClient` in later just adds the extra discovery rows.
 *
 * Lane discipline mirrors `convex/analysis.ts`: this is the ONLY place the sourcing
 * pure-logic (`sourcing/src/battlefield.ts`) is reached from Convex. It's a default
 * V8 action (NO `"use node"`): it touches no Node-only API — it only reuses the pure
 * `buildCompanyLayer` (its transitive deps — domain/fiber/types — are pure TS) and
 * writes through the sanctioned `api.records.upsertCompany` mutation. Actions can't
 * touch `ctx.db`, so the workspace read goes via `ctx.runQuery` and every company
 * write via `ctx.runMutation` (the CompanyWriter port adapter below).
 */
import { action } from "./_generated/server";
import { api } from "./_generated/api";
import { v } from "convex/values";

import {
  buildCompanyLayer,
  type CompanyWriter,
} from "../sourcing/src/battlefield";
import type { FiberClient } from "../sourcing/src/fiber";
import type { Company } from "../sourcing/src/types";

/**
 * Empty Fiber stub for the thin slice: `find-similar-companies` returns nothing,
 * so `buildCompanyLayer` produces only the customer + known competitors (no
 * battlefield discovery rows). Swap this for `createFiberClient(...)` to go live.
 */
const EMPTY_FIBER: FiberClient = {
  async findSimilarCompanies() {
    return [];
  },
};

export const buildBattlefield = action({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    // 1. Read the workspace (own_domain + competitor_domains) — already normalized
    //    at the customers mutation boundary.
    const workspace = await ctx.runQuery(api.customers.getWorkspace, {
      workspaceId: args.workspaceId,
    });
    if (!workspace) {
      throw new Error(`buildBattlefield: workspace ${args.workspaceId} not found`);
    }

    // 2. CompanyWriter port -> the sanctioned `api.records.upsertCompany` mutation.
    //    Pass only the optional enrichment families that are actually present so we
    //    never push `undefined`s through the mutation validator. Upsert is keyed on
    //    normalized domain, so re-runs are idempotent.
    const writer: CompanyWriter = {
      async upsertCompany(company: Company) {
        await ctx.runMutation(api.records.upsertCompany, {
          workspaceId: args.workspaceId,
          domain: company.domain,
          name: company.name,
          role: company.role,
          coverage_flags: company.coverage_flags,
          source_versions: company.source_versions as Record<string, string>,
          ...(company.firmographics !== undefined
            ? { firmographics: company.firmographics }
            : {}),
          ...(company.offpage !== undefined ? { offpage: company.offpage } : {}),
          ...(company.understanding !== undefined
            ? { understanding: company.understanding }
            : {}),
        });
      },
    };

    // 3. Build the company layer with the empty Fiber stub. Output (write order):
    //    customer first, then each known competitor. No battlefield rows (no Fiber).
    const companies = await buildCompanyLayer(EMPTY_FIBER, writer, {
      customerDomain: workspace.own_domain,
      customerName: workspace.name,
      competitorDomains: workspace.competitor_domains,
    });

    return {
      written: companies.length,
      customer: companies.filter((c) => c.role === "customer").length,
      competitors: companies.filter((c) => c.role === "competitor").length,
      battlefield: companies.filter((c) => c.role === "battlefield").length,
      domains: companies.map((c) => c.domain),
    };
  },
});
