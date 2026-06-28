/**
 * Experiment lifecycle + compliance mutations (owner: P1, Phase 5).
 *
 * Enforces the compliance gate AT THE DATA LAYER using the same ./lib/compliance
 * logic the UI renders: an experiment cannot enter "running" without a publish
 * event; unpublished slots expire at 14 days. The publish event is what triggers
 * P2's event-driven post-window re-measurement.
 */
import { mutation, internalMutation, query } from "./_generated/server";
import { v } from "convex/values";
import { canTransition, slotExpired } from "./lib/compliance";
import { requireWorkspace } from "./lib/auth";

/** Customer clicks "ready to publish" — move design → awaiting_publish, start the 14-day clock. */
export const requestPublish = mutation({
  args: { experimentId: v.id("experiments") },
  handler: async (ctx, { experimentId }) => {
    const exp = await ctx.db.get(experimentId);
    if (!exp) throw new Error("experiment not found");
    await requireWorkspace(ctx, exp.workspaceId);
    if (!canTransition(exp.status, "awaiting_publish", { hasPublishEvent: false })) {
      throw new Error(`illegal transition ${exp.status} -> awaiting_publish`);
    }
    await ctx.db.patch(experimentId, {
      status: "awaiting_publish",
      awaiting_since: Date.now(),
    });
  },
});

/**
 * The publish event (treatment shipped). Gate: only from awaiting_publish, and
 * this IS the publish event, so running becomes legal. Sets publish_event_ts —
 * which P2 watches to fire the post-window re-measurement.
 */
export const recordPublish = mutation({
  args: { experimentId: v.id("experiments") },
  handler: async (ctx, { experimentId }) => {
    const exp = await ctx.db.get(experimentId);
    if (!exp) throw new Error("experiment not found");
    await requireWorkspace(ctx, exp.workspaceId);
    if (!canTransition(exp.status, "running", { hasPublishEvent: true })) {
      throw new Error(`illegal transition ${exp.status} -> running (needs awaiting_publish)`);
    }
    const ts = Date.now();
    await ctx.db.patch(experimentId, { status: "running", publish_event_ts: ts });
    return ts; // P2: trigger post-window re-measurement on this event
  },
});

export const completeExperiment = mutation({
  args: { experimentId: v.id("experiments") },
  handler: async (ctx, { experimentId }) => {
    const exp = await ctx.db.get(experimentId);
    if (!exp) throw new Error("experiment not found");
    await requireWorkspace(ctx, exp.workspaceId);
    if (!canTransition(exp.status, "complete", { hasPublishEvent: true })) {
      throw new Error(`illegal transition ${exp.status} -> complete`);
    }
    await ctx.db.patch(experimentId, { status: "complete" });
  },
});

/**
 * Cron target: expire any awaiting_publish slot older than 14 days (free the
 * credits). Runs daily. Internal — only the scheduler calls it.
 */
export const expireStaleSlots = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const pending = await ctx.db
      .query("experiments")
      .withIndex("by_status", (q) => q.eq("status", "awaiting_publish"))
      .collect();
    let expired = 0;
    for (const e of pending) {
      if (e.awaiting_since && slotExpired(e.awaiting_since, now)) {
        await ctx.db.patch(e._id, { status: "expired" });
        expired++;
      }
    }
    return { expired };
  },
});

/**
 * Cron target: monthly baseline re-measurement trigger. Marks active workspaces
 * for a baseline sweep (P2 executes). Monthly cadence ONLY — never weekly
 * multi-engine (cost guard; see ./lib/compliance isAllowedCadence).
 */
export const monthlyBaseline = internalMutation({
  args: {},
  handler: async (ctx) => {
    const workspaces = await ctx.db.query("workspaces").collect();
    // Hand-off point: enqueue a baseline measurement per workspace for P2.
    // (P2's remeasure action consumes this; kept as a no-op marker for v1.)
    return { scheduled: workspaces.length };
  },
});

/** The experiment console feed — controls are NOT exposed (Hawthorne). */
export const consoleFeed = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    await requireWorkspace(ctx, workspaceId);
    const experiments = await ctx.db
      .query("experiments")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();
    const lifts = await ctx.db
      .query("lift_results")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();
    const liftByExp = new Map(lifts.map((l) => [l.experiment_id, l]));
    return experiments.map((e) => ({
      _id: e._id,
      status: e.status,
      baseline_window: e.baseline_window,
      post_window: e.post_window,
      // control_page stripped — customer never sees the control (Hawthorne)
      treatments: e.pairs.map((p) => p.treatment_page),
      n_pairs: e.pairs.length,
      lift: liftByExp.get(e._id) ?? null, // Rung-2 only when a lift_result exists
    }));
  },
});
