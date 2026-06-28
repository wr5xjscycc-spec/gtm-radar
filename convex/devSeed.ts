/**
 * DEV-ONLY seed helpers — throwaway scaffolding for bring-up validation.
 *
 * `seedAndLift` stands up a clean 4-pair experiment + windowed measurement rows
 * (baseline/post) and calls the real `runLift` round-trip inline, so we can prove
 * the Convex → Python(DiD) → `lift_result` path end-to-end against the live
 * analysis service. Not part of the product surface; safe to delete once the
 * causal chain (recordPublish → remeasure → finalize) is wired and tested.
 */
import { action } from "./_generated/server";
import { api } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";

// Four matched pairs (8 synthetic pages) so the DiD clears min_pairs_for_power=4.
// Treatment pages jump baseline→post; control pages stay flat → a clear +lift.
const PAIRS = [
  { t: "https://acme.com/feat/alpha", c: "https://acme.com/ctrl/alpha" },
  { t: "https://acme.com/feat/beta", c: "https://acme.com/ctrl/beta" },
  { t: "https://acme.com/feat/gamma", c: "https://acme.com/ctrl/gamma" },
  { t: "https://acme.com/feat/delta", c: "https://acme.com/ctrl/delta" },
];

// Per-(arm,window) P_cited samples (3 runs each) — within-cell variation so the
// page-clustered fit is non-singular. DiD ≈ (0.42-0.08) - (0.20-0.20) ≈ +0.34.
const TREAT_BASE = [0.05, 0.1, 0.08];
const TREAT_POST = [0.4, 0.45, 0.42];
const CTRL_BASE = [0.18, 0.22, 0.2];
const CTRL_POST = [0.19, 0.21, 0.2];

export const seedAndLift = action({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    // 1) Create the experiment (4 pairs, running, windows baseline/post).
    const experimentId: Id<"experiments"> = await ctx.runMutation(
      api.records.upsertExperiment,
      {
        workspaceId,
        customer_id: workspaceId,
        pairs: PAIRS.map((p) => ({ treatment_page: p.t, control_page: p.c })),
        baseline_window: "baseline",
        post_window: "post",
        feature_changed: "comparison_table",
        category: "gtm-analytics",
        status: "running",
        publish_event_ts: Date.now(),
      },
    );

    // 2) One query row to satisfy the measurement FK.
    const queryId: Id<"queries"> = await ctx.runMutation(api.records.insertQuery, {
      workspaceId,
      customer_id: workspaceId,
      vertical: "gtm-analytics",
      text: "dev seed query — lift demo",
      seed_source: "llm_expand",
      target_engines: ["openai"],
    });

    // 3) Seed windowed measurement rows and collect the DiD-shaped panel.
    const now = Date.now();
    const measurements: Array<Record<string, unknown>> = [];
    const emit = async (
      page: string,
      window: "baseline" | "post",
      pcited: number,
      runIdx: number,
    ) => {
      await ctx.runMutation(api.records.insertMeasurement, {
        workspaceId,
        query_id: queryId,
        page_url: page,
        engine: "openai",
        model_version: "dev-seed-v0",
        run_idx: runIdx,
        appeared: pcited > 0,
        cited: pcited >= 0.5,
        position: null,
        source_urls: [],
        ts: now,
        window_tag: window,
        experiment_id: experimentId,
        P_cited: pcited,
      });
      measurements.push({
        engine: "openai",
        page_url: page,
        window_tag: window,
        P_cited: pcited,
        run_idx: runIdx,
        ts: now,
      });
    };

    for (const p of PAIRS) {
      for (let i = 0; i < 3; i++) {
        await emit(p.t, "baseline", TREAT_BASE[i], i);
        await emit(p.t, "post", TREAT_POST[i], i);
        await emit(p.c, "baseline", CTRL_BASE[i], i);
        await emit(p.c, "post", CTRL_POST[i], i);
      }
    }

    // 4) The real round-trip: Convex → Python /estimate-lift → lift_result.
    const lift: { jobId: string; liftId: string | null; verdict: string } =
      await ctx.runAction(api.analysis.runLift, {
      workspaceId,
      experiment_id: experimentId,
      experiment: {
        id: experimentId.toString(),
        customer_id: workspaceId.toString(),
        pairs: PAIRS.map((p) => ({ treatment_page: p.t, control_page: p.c })),
        baseline_window: "baseline",
        post_window: "post",
        status: "running",
      },
      measurements,
      engine: "openai",
    });

    return { experimentId, nMeasurements: measurements.length, lift };
  },
});
