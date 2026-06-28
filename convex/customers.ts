/**
 * Onboarding + customer/workspace record (owner: P1).
 *
 * The thin entry point (PRD Stage 1): one own-URL + a few competitor URLs.
 * Domains are normalized AT THE MUTATION BOUNDARY via ./lib/domain so no raw
 * key can ever reach the store — the red-team's #1 silent-join-failure mode is
 * closed here, not by convention downstream.
 */
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { normalizeDomain } from "./lib/domain";
import { getOwner, requireWorkspace } from "./lib/auth";

/** Create the workspace skeleton from onboarding input. */
export const createWorkspace = mutation({
  args: {
    name: v.string(),
    vertical: v.string(),
    own_domain: v.string(),
    competitor_domains: v.array(v.string()),
    query_pack_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const own_domain = normalizeDomain(args.own_domain);
    if (!own_domain) throw new Error("own_domain did not normalize to a key");
    // Normalize + de-dupe competitors; never include the customer's own domain.
    const competitor_domains = Array.from(
      new Set(
        args.competitor_domains
          .map(normalizeDomain)
          .filter((d) => d && d !== own_domain),
      ),
    );
    const owner = await getOwner(ctx);
    return await ctx.db.insert("workspaces", {
      name: args.name,
      vertical: args.vertical,
      own_domain,
      competitor_domains,
      query_pack_id: args.query_pack_id,
      owner,
    });
  },
});

export const getWorkspace = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    return await requireWorkspace(ctx, workspaceId);
  },
});

export const listWorkspaces = query({
  args: {},
  handler: async (ctx) => {
    const owner = await getOwner(ctx);
    if (owner === undefined) {
      // Pre-auth bring-up: show all (single-tenant dev).
      return await ctx.db.query("workspaces").collect();
    }
    return await ctx.db
      .query("workspaces")
      .withIndex("by_owner", (q) => q.eq("owner", owner))
      .collect();
  },
});
