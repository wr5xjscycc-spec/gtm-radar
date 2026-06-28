/**
 * The two connective links that close the §7 pipeline loop (owner: P4 wiring).
 *
 * These are the joins between the three epistemic layers that were previously
 * only reachable by hand:
 *
 *   measurement ──(A)──▶ model_fit ──(B)──▶ experiment ──▶ lift_result
 *
 *   (A) runFitForWorkspace  — stages 7-9. Take the descriptive baseline
 *       `measurement` rows, aggregate the K repeats per (query, page, engine)
 *       into a citation rate + Wilson CI, join them to the candidate pool to
 *       recover company_domain/role + page content_features, and hand that
 *       model-ready label table to the Python Bayes fit (`api.analysis.runFit`)
 *       which writes the `model_fit` hypotheses. NEVER causal — Rung 1.
 *
 *   (B) designExperiment    — stage 11. Read the top non-noise hypothesis off
 *       the latest `model_fit`, pick the customer's own pages, and pair them
 *       into treatment/control matched pairs with that feature as the planned
 *       change. Writes a `designing` experiment via `api.records.upsertExperiment`.
 *       The publish itself stays a gated human ship event (recordPublish), which
 *       is already wired through remeasure → finalize → runLift → intervention.
 *
 * Both reuse the already-tested PURE measurement helpers (aggregateRuns,
 * buildLabelTable, buildPoolFromCompanies) by relative import — no Node builtins,
 * so they bundle cleanly into the V8 action. The action is the only place I/O
 * happens; it never touches ctx.db, reading via ctx.runQuery and writing via
 * ctx.runAction / ctx.runMutation so keys stay normalized at the boundary.
 */
import { action } from "./_generated/server";
import { api } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";

import { aggregateRuns } from "../measurement/src/stats/aggregate";
import { buildLabelTable } from "../measurement/src/quality/label-table";
import type { MeasurementRow } from "../measurement/src/types";
import { normalizeDomain } from "../measurement/src/normalize";
import { normalizeUrl } from "./lib/domain";
import { buildPoolFromCompanies } from "./measure";

const engineValidator = v.union(
  v.literal("openai"),
  v.literal("perplexity"),
  v.literal("gemini"),
);
type EngineName = "openai" | "perplexity" | "gemini";

// ---------------------------------------------------------------------------
// PURE HELPERS — feature flattening + hypothesis selection (no I/O).
// ---------------------------------------------------------------------------

/** Boolean content-features become 0/1; numeric ones pass through. Undefined drops out. */
function featuresToNumeric(
  cf: Record<string, unknown> | undefined | null,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!cf) return out;
  const boolKeys = ["schema_markup", "comparison_table", "direct_answer_first"];
  const numKeys = [
    "word_count",
    "heading_structure",
    "freshness_days",
    "query_term_coverage",
    "stats_density",
    "citation_density",
    "quote_density",
    "listicle_vs_prose",
  ];
  for (const k of boolKeys) {
    const val = (cf as Record<string, unknown>)[k];
    if (typeof val === "boolean") out[k] = val ? 1 : 0;
  }
  for (const k of numKeys) {
    const val = (cf as Record<string, unknown>)[k];
    if (typeof val === "number" && Number.isFinite(val)) out[k] = val;
  }
  return out;
}

/**
 * One numeric feature vector per company_domain. The measurement layer is
 * domain-keyed (a pool page's url IS the registrable domain), while
 * content_features live on the scraped sub-pages, so the join is by domain:
 * the first scraped page that carries any feature represents the domain.
 */
function featuresByDomain(
  pages: ReadonlyArray<{ company_domain: string; content_features?: unknown }>,
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const p of pages) {
    const dom = normalizeDomain(p.company_domain);
    if (!dom || out[dom]) continue;
    const feats = featuresToNumeric(p.content_features as Record<string, unknown>);
    if (Object.keys(feats).length > 0) out[dom] = feats;
  }
  return out;
}

/**
 * The feature a designed experiment should change: the highest posterior-median,
 * non-noise coefficient on the most recent fit. Falls back to the fit's first
 * top_hypothesis, then null (caller supplies a default).
 */
export function pickFeatureToChange(
  fits: ReadonlyArray<{
    coefficients?: Array<{
      feature: string;
      posterior_median: number;
      noise_flag: boolean;
    }>;
    top_hypotheses?: string[];
  }>,
): string | null {
  if (fits.length === 0) return null;
  const latest = fits[fits.length - 1];
  const coeffs = (latest.coefficients ?? [])
    .filter((c) => !c.noise_flag)
    .sort((a, b) => b.posterior_median - a.posterior_median);
  if (coeffs.length > 0 && coeffs[0].posterior_median > 0) return coeffs[0].feature;
  if (latest.top_hypotheses && latest.top_hypotheses.length > 0) {
    return latest.top_hypotheses[0];
  }
  return null;
}

// ---------------------------------------------------------------------------
// LINK A — measurement → model_fit  (stages 7-9).
// ---------------------------------------------------------------------------

/**
 * Aggregate a workspace's baseline measurements into a model-ready label table
 * and run the Bayesian fit, writing `model_fit` hypotheses. Scheduled right after
 * `measureWorkspace` so the diagnosis surface fills the moment a sweep lands.
 *
 * Idempotent-friendly: a no-op (returns `{ skipped }`) when there are no baseline
 * rows yet rather than throwing, so the chained scheduler never dead-letters.
 */
export const runFitForWorkspace = action({
  args: {
    workspaceId: v.id("workspaces"),
    engine: v.optional(engineValidator),
    category: v.optional(v.string()),
    thenDesign: v.optional(v.boolean()),
  },
  // Explicit return annotation breaks the api-type inference cycle introduced by
  // scheduling api.diagnose.* from inside this same module (Convex TS7022 guard).
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    const eng: EngineName = args.engine ?? "openai";
    const ws = await ctx.runQuery(api.customers.getWorkspace, {
      workspaceId: args.workspaceId,
    });
    if (!ws) throw new Error("workspace not found");

    // Rebuild the EXACT pool the sweep ranked against, so page_url join keys line
    // up (own + typed competitors + discovered battlefield, deduped/capped).
    const companies = await ctx.runQuery(api.board.battlefield, {
      workspaceId: args.workspaceId,
    });
    // The label-table join is an EXACT page_url match, so the pool's urls must be
    // canonicalized through the SAME normalizeUrl the mutation boundary applied to
    // the stored measurement page_url (which carries the https:// scheme). Without
    // this, bare-domain pool urls miss every aggregate and the table is empty.
    const pool = buildPoolFromCompanies(
      ws.own_domain,
      ws.competitor_domains,
      companies,
    ).map((p) => ({ ...p, url: normalizeUrl(p.url) }));

    const measurements = await ctx.runQuery(api.board.measurements, {
      workspaceId: args.workspaceId,
    });
    const baseRows = measurements.filter(
      (m: { window_tag: string; engine: string }) =>
        m.window_tag === "baseline" && m.engine === eng,
    );
    if (baseRows.length === 0) {
      return { skipped: "no baseline measurements", nRows: 0 };
    }

    // K-run aggregation → label table (joins domain/role onto each aggregate).
    const aggregates = aggregateRuns(baseRows as unknown as MeasurementRow[]);
    const { rows: labelRows, unmatched } = buildLabelTable(aggregates, pool);
    if (labelRows.length === 0) {
      return { skipped: "no label rows after join", unmatched: unmatched.length };
    }

    // Attach numeric content_features per domain (best-effort — fit runs without).
    const pages = await ctx.runQuery(api.board.pages, {
      workspaceId: args.workspaceId,
    });
    const featMap = featuresByDomain(pages);

    const fitRows = labelRows.map((r) => {
      const feats = featMap[r.company_domain];
      return {
        page_url: r.page_url,
        company_domain: r.company_domain,
        p_cited: r.p_cited,
        ci_width: Math.max(0, r.ci_high - r.ci_low),
        label: r.label,
        ...(feats && Object.keys(feats).length > 0 ? { features: feats } : {}),
      };
    });

    // Union of feature names actually present, so the fit knows its design matrix.
    const featureNames = Array.from(
      new Set(fitRows.flatMap((r) => Object.keys(r.features ?? {}))),
    );

    const fit = await ctx.runAction(api.analysis.runFit, {
      workspaceId: args.workspaceId,
      customer_id: args.workspaceId,
      category: args.category ?? ws.vertical,
      engine: eng,
      rows: fitRows,
      ...(featureNames.length > 0 ? { features: featureNames } : {}),
    });

    // Chain stage 11: design an experiment off the freshly-written hypotheses,
    // unless an active one already exists. Default ON (the natural loop).
    if (args.thenDesign !== false) {
      await ctx.scheduler.runAfter(0, api.diagnose.designExperiment, {
        workspaceId: args.workspaceId,
      });
    }

    return {
      ...fit,
      nRows: fitRows.length,
      unmatched: unmatched.length,
      features: featureNames,
    };
  },
});

// ---------------------------------------------------------------------------
// LINK B — model_fit → experiment design  (stage 11).
// ---------------------------------------------------------------------------

/**
 * Design (but do NOT publish) a matched-pair experiment for a workspace. Picks the
 * feature to change from the top hypothesis, pairs the customer's own pages into
 * treatment/control, and writes a `designing` experiment. Publishing stays a gated
 * human ship event (`recordPublish`) — which is already wired to remeasure →
 * finalize → runLift → intervention, closing the causal loop.
 *
 * Skips (no throw) when there is already an active experiment or too few own pages.
 */
export const designExperiment = action({
  args: {
    workspaceId: v.id("workspaces"),
    feature: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    const ws = await ctx.runQuery(api.customers.getWorkspace, {
      workspaceId: args.workspaceId,
    });
    if (!ws) throw new Error("workspace not found");

    // Don't pile up experiments: one active (designing/awaiting_publish/running)
    // experiment at a time keeps the auto-chain idempotent across re-sweeps.
    const feed = await ctx.runQuery(api.experiments.consoleFeed, {
      workspaceId: args.workspaceId,
    });
    const active = feed.find(
      (e: { status: string }) =>
        e.status === "designing" ||
        e.status === "awaiting_publish" ||
        e.status === "running",
    );
    if (active) {
      return { skipped: "active experiment exists", experimentId: active._id };
    }

    // Treatment/control come from the customer's OWN scraped pages.
    const own = normalizeDomain(ws.own_domain);
    const pages = await ctx.runQuery(api.board.pages, {
      workspaceId: args.workspaceId,
    });
    const ownUrls: string[] = pages
      .filter((p: { company_domain: string }) => normalizeDomain(p.company_domain) === own)
      .map((p: { url: string }) => p.url);
    if (ownUrls.length < 2) {
      return { skipped: "need >=2 own pages to form a pair", ownPages: ownUrls.length };
    }

    // feature_changed: explicit arg → top hypothesis → safe default.
    const fits = await ctx.runQuery(api.board.modelFits, {
      workspaceId: args.workspaceId,
    });
    const feature_changed =
      args.feature ?? pickFeatureToChange(fits) ?? "comparison_table";

    // Pair adjacent own pages into treatment/control matched pairs.
    const pairs: Array<{ treatment_page: string; control_page: string }> = [];
    for (let i = 0; i + 1 < ownUrls.length; i += 2) {
      pairs.push({ treatment_page: ownUrls[i], control_page: ownUrls[i + 1] });
    }

    const experimentId: Id<"experiments"> = await ctx.runMutation(
      api.records.upsertExperiment,
      {
        workspaceId: args.workspaceId,
        customer_id: args.workspaceId,
        pairs,
        baseline_window: "baseline",
        post_window: "post",
        feature_changed,
        category: ws.vertical,
        status: "designing",
      },
    );

    return { experimentId, nPairs: pairs.length, feature_changed };
  },
});
