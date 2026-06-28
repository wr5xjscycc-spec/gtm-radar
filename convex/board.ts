/**
 * Reactive read queries powering the live board (owner: P1).
 *
 * Convex queries are reactive: the board re-renders automatically as P2/P3/P4
 * write rows — no polling. These queries are read-only and workspace-scoped.
 * Phase-0 scope: enough for "write any record, see it on the board." The
 * gut-punch citation view sharpens in Phase 3.
 */
import { query } from "./_generated/server";
import { v } from "convex/values";
import { requireWorkspace } from "./lib/auth";
import { normalizeDomain } from "./lib/domain";

/** The battlefield (companies) filling in for a workspace. */
export const battlefield = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    await requireWorkspace(ctx, workspaceId);
    return await ctx.db
      .query("companies")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();
  },
});

/** Raw measurement rows for a workspace (descriptive truth). */
export const measurements = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    await requireWorkspace(ctx, workspaceId);
    return await ctx.db
      .query("measurements")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();
  },
});

/**
 * The "0 of N" citation board, per engine — the demo's emotional core (sharpens
 * in P1·3). Counts distinct cited pages per engine. Always labels the per-engine
 * split explicitly; cross-engine overlap is low (~11%), so we never collapse to
 * one number without saying it's an aggregate.
 */
export const citationBoard = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    await requireWorkspace(ctx, workspaceId);
    const rows = await ctx.db
      .query("measurements")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();
    const perEngine: Record<
      string,
      { cited: number; total: number; sources: string[] }
    > = {};
    for (const r of rows) {
      const e = (perEngine[r.engine] ??= { cited: 0, total: 0, sources: [] });
      e.total += 1;
      if (r.cited) {
        e.cited += 1;
        for (const s of r.source_urls) if (!e.sources.includes(s)) e.sources.push(s);
      }
    }
    return {
      perEngine,
      // Aggregate is explicitly labeled as such — see ORCHESTRATION.md §6.
      note: "Per-engine; combined view is an aggregate of independent engines.",
    };
  },
});

/**
 * The gut-punch (P1·3): per engine, YOU vs competitors. Classifies each
 * measurement's page by normalized domain against the workspace's own/competitor
 * domains, counts cited/total, finds the top competitor, and surfaces the domains
 * the engine actually cited ("cited from these sources"). Per-engine — never a
 * single blended number (v1 has one engine; the structure stays per-engine).
 */
export const gutPunch = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const ws = await requireWorkspace(ctx, workspaceId);
    const own = normalizeDomain(ws.own_domain);
    const competitors = new Set(ws.competitor_domains);
    const rows = await ctx.db
      .query("measurements")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();

    type Side = { cited: number; total: number };
    const engines: Record<
      string,
      {
        you: Side;
        competitors: Record<string, Side>;
        citedSources: string[];
      }
    > = {};

    for (const r of rows) {
      const e = (engines[r.engine] ??= {
        you: { cited: 0, total: 0 },
        competitors: {},
        citedSources: [],
      });
      const dom = normalizeDomain(r.page_url);
      const bump = (s: Side) => {
        s.total += 1;
        if (r.cited) s.cited += 1;
      };
      if (dom === own) bump(e.you);
      else if (competitors.has(dom)) bump((e.competitors[dom] ??= { cited: 0, total: 0 }));
      for (const s of r.source_urls) {
        const sd = normalizeDomain(s);
        if (sd && !e.citedSources.includes(sd)) e.citedSources.push(sd);
      }
    }

    // Per engine, pick the top competitor by cited count.
    const perEngine = Object.fromEntries(
      Object.entries(engines).map(([engine, e]) => {
        const topCompetitor =
          Object.entries(e.competitors)
            .map(([domain, s]) => ({ domain, ...s }))
            .sort((a, b) => b.cited - a.cited)[0] ?? null;
        return [engine, { you: e.you, competitors: e.competitors, topCompetitor, citedSources: e.citedSources }];
      }),
    );

    return {
      own_domain: own,
      perEngine,
      note: "Per-engine; v1 measures OpenAI only. A combined number would be an aggregate of independent engines.",
    };
  },
});

/** Pages + their content_features (for the feature-vector inspector, P1·2). */
export const pages = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    await requireWorkspace(ctx, workspaceId);
    return await ctx.db
      .query("pages")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();
  },
});

/** Query set (for the query-review view with seed_source tags, P1·2). */
export const queries = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    await requireWorkspace(ctx, workspaceId);
    return await ctx.db
      .query("queries")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();
  },
});

/**
 * Diagnosis (P1·4): the day-1 product surface. Returns model_fit hypotheses
 * (Rung 1) and the licensed claim rung. The rung is CAUSAL (2) ONLY when a
 * lift_result exists for this workspace — otherwise it is capped at hypothesis
 * (1). This is the claim-ladder gate enforced at the DATA layer: no causal
 * payload is emitted without a lift_result, so the UI cannot render one.
 */
export const diagnosis = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    await requireWorkspace(ctx, workspaceId);
    const [fits, lifts] = await Promise.all([
      ctx.db.query("model_fits").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect(),
      ctx.db.query("lift_results").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect(),
    ]);
    const hasModelFit = fits.length > 0;
    const hasLiftResult = lifts.length > 0;
    const rung = hasLiftResult ? 2 : hasModelFit ? 1 : 0;
    return {
      modelFits: fits, // hypotheses w/ coefficients + noise_flags (Rung 1)
      hasLiftResult,
      // Causal payload is present ONLY when licensed — never fabricated.
      liftResults: hasLiftResult ? lifts : [],
      rung,
    };
  },
});

/** Hypotheses (model_fit) — rendered with uncertainty + noise flags, never causal. */
export const modelFits = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    await requireWorkspace(ctx, workspaceId);
    return await ctx.db
      .query("model_fits")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();
  },
});

/** Per-cycle run records for the ops/observability view (P1·6) — spend visible. */
export const runRecords = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    await requireWorkspace(ctx, workspaceId);
    return await ctx.db
      .query("run_records")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();
  },
});

/** Causal results — the only source that licenses Rung-2 causal language. */
export const liftResults = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    await requireWorkspace(ctx, workspaceId);
    return await ctx.db
      .query("lift_results")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();
  },
});

/** One-call board summary: counts across every record type. */
export const summary = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const ws = await requireWorkspace(ctx, workspaceId);
    const [companies, pages, queries, measurements, fits, experiments, lifts] =
      await Promise.all([
        ctx.db.query("companies").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect(),
        ctx.db.query("pages").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect(),
        ctx.db.query("queries").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect(),
        ctx.db.query("measurements").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect(),
        ctx.db.query("model_fits").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect(),
        ctx.db.query("experiments").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect(),
        ctx.db.query("lift_results").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect(),
      ]);
    return {
      workspace: ws,
      counts: {
        companies: companies.length,
        pages: pages.length,
        queries: queries.length,
        measurements: measurements.length,
        model_fits: fits.length,
        experiments: experiments.length,
        lift_results: lifts.length,
      },
    };
  },
});
