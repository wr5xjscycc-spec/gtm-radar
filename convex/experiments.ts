/**
 * Experiment lifecycle + compliance mutations (owner: P1, Phase 5).
 *
 * Enforces the compliance gate AT THE DATA LAYER using the same ./lib/compliance
 * logic the UI renders: an experiment cannot enter "running" without a publish
 * event; unpublished slots expire at 14 days. The publish event is what triggers
 * P2's event-driven post-window re-measurement.
 */
import {
  mutation,
  internalMutation,
  internalQuery,
  query,
  action,
} from "./_generated/server";
import { v } from "convex/values";
import { canTransition, slotExpired } from "./lib/compliance";
import { requireWorkspace } from "./lib/auth";
import { api, internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { runMeasurementSweep, pagesToCandidatePool, type SweepSummary } from "./measure";

const engineValidator = v.union(
  v.literal("openai"),
  v.literal("perplexity"),
  v.literal("gemini"),
);
type EngineName = "openai" | "perplexity" | "gemini";

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
    // P2 event-driven loop: the publish event fires the post-window re-measurement,
    // which in turn finalizes the causal estimate (remeasure -> finalizeExperiment).
    // In production POST_WINDOW_DELAY_MS is the post_window duration (days) so the
    // treatment has time to propagate into AI answers; for the demo it's immediate.
    await ctx.scheduler.runAfter(POST_WINDOW_DELAY_MS, api.experiments.remeasure, {
      experimentId,
      thenFinalize: true,
    });
    return ts;
  },
});

/** Demo: re-measure immediately on publish. Production: set to the post_window
 *  length so the shipped treatment has time to land in AI answers before we measure. */
const POST_WINDOW_DELAY_MS = 0;

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
 * Cron target: monthly baseline re-measurement trigger. Schedules a real
 * `measureWorkspace` sweep per workspace (P2 executes). Monthly cadence ONLY —
 * never weekly multi-engine (cost guard; see ./lib/compliance isAllowedCadence).
 * Scheduled (not awaited) so the cron returns promptly; each sweep runs as its
 * own action.
 */
export const monthlyBaseline = internalMutation({
  args: {},
  handler: async (ctx) => {
    const workspaces = await ctx.db.query("workspaces").collect();
    for (const ws of workspaces) {
      await ctx.scheduler.runAfter(0, api.measure.measureWorkspace, {
        workspaceId: ws._id,
      });
    }
    return { scheduled: workspaces.length };
  },
});

/**
 * Read one experiment + its workspace for the post-window re-measure. INTERNAL by
 * design: it returns the full experiment doc including `control_page`, which the
 * customer-facing `consoleFeed` deliberately strips (Hawthorne). Only the
 * server-side `remeasure` action may see it — never the client.
 */
export const getExperiment = internalQuery({
  args: { experimentId: v.id("experiments") },
  handler: async (
    ctx,
    { experimentId },
  ): Promise<{ experiment: Doc<"experiments">; workspace: Doc<"workspaces"> } | null> => {
    const experiment = await ctx.db.get(experimentId);
    if (!experiment) return null;
    const workspace = await requireWorkspace(ctx, experiment.workspaceId);
    return { experiment, workspace };
  },
});

/**
 * Post-window re-measurement (Card A · re-measure loop). Runs the SAME OpenAI
 * sweep as the baseline, but over the experiment's treatment + control pages and
 * stamped `window_tag: "post"` with the `experiment_id` — the rows Card C's DiD
 * differences against the baseline window to estimate causal lift.
 */
export const remeasure = action({
  args: {
    experimentId: v.id("experiments"),
    // When true, tail-schedule finalizeExperiment once the post-window rows are
    // written — closing the causal loop (DiD -> lift_result -> intervention). The
    // standalone / monthly-baseline callers leave this off.
    thenFinalize: v.optional(v.boolean()),
  },
  handler: async (ctx, { experimentId, thenFinalize }): Promise<SweepSummary> => {
    const data = await ctx.runQuery(internal.experiments.getExperiment, {
      experimentId,
    });
    if (!data) throw new Error("experiment not found");
    const { experiment, workspace } = data;

    // Candidate pool = every page in the experiment (treatment + control), so the
    // post-window measures the same pages the experiment shipped.
    const urls: string[] = [];
    for (const p of experiment.pairs) {
      urls.push(p.treatment_page, p.control_page);
    }
    const pool = pagesToCandidatePool(urls);

    const summary = await runMeasurementSweep(ctx, {
      workspaceId: experiment.workspaceId,
      vertical: workspace.vertical,
      candidatePool: pool,
      windowTag: "post",
      experimentId,
    });

    // Post-window rows are now committed; schedule the causal estimate as its own
    // action so it gets a fresh execution budget for the Python DiD round-trip.
    if (thenFinalize) {
      await ctx.scheduler.runAfter(0, api.experiments.finalizeExperiment, {
        experimentId,
      });
    }

    return summary;
  },
});

/**
 * Gather the DiD panel for an experiment: every measurement row on the
 * experiment's pages (treatment + control) in the baseline and post windows.
 *
 * INTERNAL + keyed on PAGE URL, not experiment_id, on purpose: the baseline rows
 * were written by the workspace baseline sweep BEFORE this experiment existed, so
 * they carry no experiment_id. Filtering by experiment_id would silently drop the
 * entire pre-period and make every DiD degenerate. We scope by workspace, then keep
 * rows whose page is in the experiment and whose window is baseline/post.
 */
export const measurementsForExperiment = internalQuery({
  args: { experimentId: v.id("experiments") },
  handler: async (ctx, { experimentId }) => {
    const exp = await ctx.db.get(experimentId);
    if (!exp) return [];
    const pages = new Set<string>();
    for (const p of exp.pairs) {
      pages.add(p.treatment_page);
      pages.add(p.control_page);
    }
    const rows = await ctx.db
      .query("measurements")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", exp.workspaceId))
      .collect();
    return rows.filter(
      (r) =>
        pages.has(r.page_url) &&
        (r.window_tag === "baseline" || r.window_tag === "post"),
    );
  },
});

/** Most-recent lift_result for an experiment (read back after runLift writes it). */
export const latestLiftForExperiment = internalQuery({
  args: { experimentId: v.id("experiments") },
  handler: async (ctx, { experimentId }) => {
    const lifts = await ctx.db
      .query("lift_results")
      .withIndex("by_experiment", (q) => q.eq("experiment_id", experimentId))
      .collect();
    if (lifts.length === 0) return null;
    return lifts.reduce((a, b) => (b.computed_at > a.computed_at ? b : a));
  },
});

/**
 * Close the causal loop (the moat write). Gathers the experiment's baseline+post
 * panel, runs the Python DiD round-trip (runLift -> lift_result), reads the verdict
 * back, and — when decisive (worked / no_effect) — records the
 * feature_changed -> measured_lift fact as an `intervention` (the compounding
 * dataset). Always transitions the experiment to complete. Idempotency is the
 * caller's concern (scheduled once per publish event).
 */
export const finalizeExperiment = action({
  args: {
    experimentId: v.id("experiments"),
    engine: v.optional(engineValidator),
  },
  handler: async (
    ctx,
    { experimentId, engine },
  ): Promise<{
    verdict: string;
    recordedMoat: boolean;
    estimate: number | null;
  }> => {
    const eng: EngineName = engine ?? "openai";
    const data = await ctx.runQuery(internal.experiments.getExperiment, {
      experimentId,
    });
    if (!data) throw new Error("experiment not found");
    const { experiment, workspace } = data;

    const measurements = await ctx.runQuery(
      internal.experiments.measurementsForExperiment,
      { experimentId },
    );

    // Python DiD round-trip — writes the lift_result (claim_rung=2) itself.
    const lift: { jobId: string; liftId: string | null; verdict: string } =
      await ctx.runAction(api.analysis.runLift, {
        workspaceId: experiment.workspaceId,
        experiment_id: experimentId,
        experiment: {
          id: experimentId.toString(),
          customer_id: experiment.customer_id.toString(),
          pairs: experiment.pairs.map((p) => ({
            treatment_page: p.treatment_page,
            control_page: p.control_page,
          })),
          baseline_window: experiment.baseline_window ?? "baseline",
          post_window: experiment.post_window ?? "post",
          status: experiment.status,
          ...(experiment.publish_event_ts !== undefined
            ? { publish_event_ts: new Date(experiment.publish_event_ts).toISOString() }
            : {}),
        },
        measurements,
        engine: eng,
      });

    // Read the persisted lift_result back for the estimate + CI (runLift returns
    // only the verdict + ids).
    const lr = await ctx.runQuery(
      internal.experiments.latestLiftForExperiment,
      { experimentId },
    );

    // Moat write: record the feature -> measured lift fact, but only on a decisive
    // verdict. An `inconclusive` run taught us nothing causal, so it earns no
    // intervention row (honesty: the moat holds only facts we can stand behind).
    let recordedMoat = false;
    if (lr && (lr.verdict === "worked" || lr.verdict === "no_effect")) {
      await ctx.runMutation(api.records.insertIntervention, {
        workspaceId: experiment.workspaceId,
        feature_changed: experiment.feature_changed ?? "unspecified",
        category: experiment.category ?? workspace.vertical,
        engine: eng,
        measured_lift: lr.estimate,
        ci_low: lr.ci_low,
        ci_high: lr.ci_high,
        experiment_id: experimentId,
        recorded_at: Date.now(),
      });
      recordedMoat = true;
    }

    // Close out the experiment (running -> complete).
    if (experiment.status === "running") {
      await ctx.runMutation(api.experiments.completeExperiment, { experimentId });
    }

    return {
      verdict: lift.verdict,
      recordedMoat,
      estimate: lr ? lr.estimate : null,
    };
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
