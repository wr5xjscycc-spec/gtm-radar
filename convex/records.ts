/**
 * The sanctioned cross-lane WRITE path (owner: P1).
 *
 * P2/P3/P4 write their records through these mutations rather than inventing
 * their own insert logic. Why centralize: domain/URL keys are normalized HERE,
 * at the mutation boundary, so a non-normalized key (the #1 silent-join-failure
 * mode) is structurally impossible — not a convention a downstream lane can
 * forget. Each mutation maps 1:1 to a contract record; the epistemic layering
 * (measurement vs model_fit vs lift_result) is preserved by keeping them
 * separate functions with separate validators.
 *
 * These are reference write helpers for Phase 0's thin slice; owning lanes may
 * extend the args (with §4 sign-off) as their phases land.
 */
import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { normalizeDomain, normalizeUrl } from "./lib/domain";
import { requireWorkspace } from "./lib/auth";

const engine = v.union(
  v.literal("openai"),
  v.literal("perplexity"),
  v.literal("gemini"),
);

// --- company (P3) — upsert keyed on normalized domain ------------------------
export const upsertCompany = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    domain: v.string(),
    name: v.optional(v.string()),
    role: v.union(
      v.literal("customer"),
      v.literal("competitor"),
      v.literal("battlefield"),
    ),
    firmographics: v.optional(v.any()),
    offpage: v.optional(v.any()),
    understanding: v.optional(v.any()),
    coverage_flags: v.optional(v.array(v.string())),
    source_versions: v.optional(v.record(v.string(), v.string())),
  },
  handler: async (ctx, args) => {
    await requireWorkspace(ctx, args.workspaceId);
    const domain = normalizeDomain(args.domain);
    if (!domain) throw new Error("company.domain did not normalize to a key");
    const existing = await ctx.db
      .query("companies")
      .withIndex("by_domain", (q) => q.eq("domain", domain))
      .filter((q) => q.eq(q.field("workspaceId"), args.workspaceId))
      .first();
    const doc = { ...args, domain };
    if (existing) {
      await ctx.db.patch(existing._id, doc);
      return existing._id;
    }
    return await ctx.db.insert("companies", doc);
  },
});

// --- page (P3) — upsert keyed on normalized url ------------------------------
export const upsertPage = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    company_domain: v.string(),
    url: v.string(),
    role: v.union(
      v.literal("candidate"),
      v.literal("customer"),
      v.literal("competitor"),
    ),
    content_features: v.optional(v.any()),
    extractor_version: v.string(),
    scraped_at: v.optional(v.number()),
    cache_key: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireWorkspace(ctx, args.workspaceId);
    const url = normalizeUrl(args.url);
    const company_domain = normalizeDomain(args.company_domain);
    if (!url) throw new Error("page.url did not normalize to a key");
    const existing = await ctx.db
      .query("pages")
      .withIndex("by_url", (q) => q.eq("url", url))
      .filter((q) => q.eq(q.field("workspaceId"), args.workspaceId))
      .first();
    const doc = { ...args, url, company_domain };
    if (existing) {
      await ctx.db.patch(existing._id, doc);
      return existing._id;
    }
    return await ctx.db.insert("pages", doc);
  },
});

// --- query (P3) --------------------------------------------------------------
export const insertQuery = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    customer_id: v.id("workspaces"),
    vertical: v.string(),
    text: v.string(),
    seed_source: v.union(
      v.literal("paa"),
      v.literal("keyword"),
      v.literal("reddit"),
      v.literal("analytics"),
      v.literal("llm_expand"),
    ),
    target_engines: v.array(engine),
  },
  handler: async (ctx, args) => {
    await requireWorkspace(ctx, args.workspaceId);
    return await ctx.db.insert("queries", args);
  },
});

// --- measurement (P2) — descriptive truth; normalize page_url + source_urls --
export const insertMeasurement = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    query_id: v.id("queries"),
    page_url: v.string(),
    engine,
    model_version: v.string(),
    run_idx: v.number(),
    appeared: v.boolean(),
    cited: v.boolean(),
    position: v.union(v.number(), v.null()),
    source_urls: v.array(v.string()),
    ts: v.number(),
    window_tag: v.union(
      v.literal("baseline"),
      v.literal("post"),
      v.literal("adhoc"),
    ),
    experiment_id: v.optional(v.id("experiments")),
    P_cited: v.optional(v.number()),
    ci_low: v.optional(v.number()),
    ci_high: v.optional(v.number()),
    position_weight: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireWorkspace(ctx, args.workspaceId);
    return await ctx.db.insert("measurements", {
      ...args,
      page_url: normalizeUrl(args.page_url),
      source_urls: args.source_urls.map(normalizeDomain).filter(Boolean),
    });
  },
});

// --- model_fit (P4) — hypotheses with uncertainty (never causal) -------------
export const insertModelFit = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    customer_id: v.id("workspaces"),
    category: v.string(),
    engine,
    coefficients: v.array(
      v.object({
        feature: v.string(),
        posterior_median: v.number(),
        ci_low: v.number(),
        ci_high: v.number(),
        noise_flag: v.boolean(),
      }),
    ),
    prior_version: v.string(),
    top_hypotheses: v.array(v.string()),
    n_companies: v.number(),
    n_rows: v.number(),
  },
  handler: async (ctx, args) => {
    await requireWorkspace(ctx, args.workspaceId);
    return await ctx.db.insert("model_fits", args);
  },
});

// --- experiment (P4 design / P1 console) — normalize pair page urls ----------
export const upsertExperiment = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    customer_id: v.id("workspaces"),
    pairs: v.array(
      v.object({
        treatment_page: v.string(),
        control_page: v.string(),
        match_covars: v.optional(v.record(v.string(), v.number())),
      }),
    ),
    baseline_window: v.optional(v.string()),
    post_window: v.optional(v.string()),
    feature_changed: v.optional(v.string()),
    category: v.optional(v.string()),
    status: v.union(
      v.literal("designing"),
      v.literal("awaiting_publish"),
      v.literal("running"),
      v.literal("complete"),
      v.literal("expired"),
    ),
    publish_event_ts: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireWorkspace(ctx, args.workspaceId);
    return await ctx.db.insert("experiments", {
      ...args,
      pairs: args.pairs.map((p) => ({
        ...p,
        treatment_page: normalizeUrl(p.treatment_page),
        control_page: normalizeUrl(p.control_page),
      })),
    });
  },
});

// --- lift_result (P4) — the ONLY record that licenses causal language --------
export const insertLiftResult = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    experiment_id: v.id("experiments"),
    estimate: v.number(),
    ci_low: v.number(),
    ci_high: v.number(),
    p_value: v.number(),
    verdict: v.union(
      v.literal("worked"),
      v.literal("no_effect"),
      v.literal("inconclusive"),
    ),
    claim_rung: v.number(),
    computed_at: v.number(),
  },
  handler: async (ctx, args) => {
    await requireWorkspace(ctx, args.workspaceId);
    return await ctx.db.insert("lift_results", args);
  },
});

// --- run_record (P1 obs; P2 writes spend) ------------------------------------
export const recordCycle = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    cycle_id: v.string(),
    queries_issued: v.number(),
    calls_made: v.number(),
    spend_usd: v.number(),
    per_engine: v.record(
      v.string(),
      v.object({ calls: v.number(), errors: v.number() }),
    ),
    ts: v.number(),
  },
  handler: async (ctx, args) => {
    await requireWorkspace(ctx, args.workspaceId);
    return await ctx.db.insert("run_records", args);
  },
});

// --- intervention (P4) — the moat store --------------------------------------
export const insertIntervention = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    feature_changed: v.string(),
    category: v.string(),
    engine,
    measured_lift: v.number(),
    ci_low: v.number(),
    ci_high: v.number(),
    experiment_id: v.id("experiments"),
    recorded_at: v.number(),
  },
  handler: async (ctx, args) => {
    await requireWorkspace(ctx, args.workspaceId);
    return await ctx.db.insert("interventions", args);
  },
});
