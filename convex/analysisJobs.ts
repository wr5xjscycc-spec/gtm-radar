/**
 * Mutations for the ``analysis_jobs`` table — called by the ``analysis.runFit`` action.
 *
 * Separate file so the action can reference ``api.analysisJobs.*`` without a circular
 * dependency (the action calls this mutation, and the mutation doesn't call the action).
 */
import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireWorkspace } from "./lib/auth";

export const insertJob = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    customer_id: v.string(),
    category: v.string(),
    engine: v.union(
      v.literal("openai"),
      v.literal("perplexity"),
      v.literal("gemini"),
    ),
    request: v.string(),
    job_id: v.string(),
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("complete"),
      v.literal("failed"),
    ),
    created_at: v.number(),
    updated_at: v.number(),
  },
  handler: async (ctx, args) => {
    await requireWorkspace(ctx, args.workspaceId);
    return await ctx.db.insert("analysis_jobs", args);
  },
});

export const updateJob = mutation({
  args: {
    jobId: v.id("analysis_jobs"),
    status: v.optional(
      v.union(
        v.literal("queued"),
        v.literal("running"),
        v.literal("complete"),
        v.literal("failed"),
      ),
    ),
    job_id: v.optional(v.string()),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
    updated_at: v.number(),
  },
  handler: async (ctx, args) => {
    const { jobId, ...patch } = args;
    const existing = await ctx.db.get(jobId);
    if (!existing) throw new Error(`analysis_job not found: ${jobId}`);
    await requireWorkspace(ctx, existing.workspaceId);
    await ctx.db.patch(jobId, patch);
  },
});
