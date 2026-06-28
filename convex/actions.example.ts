/**
 * THE CONVEX ACTION PATTERN — reference exemplar (owner: P1). NOT shipped logic.
 *
 * Every lane copies this shape for external side-effects. The rule:
 *
 *   queries  = pure reads (reactive, no I/O, no randomness)
 *   mutations = pure writes (transactional, no I/O) — normalize keys HERE
 *   actions  = the ONLY place external I/O happens (engine calls, scraping,
 *              the Python analysis service, CMS publish). Actions cannot touch
 *              the DB directly — they call queries/mutations via ctx.run*.
 *
 * Flow (this example = P2's Phase-0 "one engine, one citation"):
 *   1. action does the network call (OpenAI Responses API + web_search)
 *   2. action resolves redirects / extracts citation source URLs
 *   3. action calls a MUTATION to persist — the mutation normalizes keys
 *      (so even an action can't smuggle a raw domain into the store)
 *
 * Secrets live in Convex env config (`npx convex env set OPENAI_API_KEY ...`),
 * never in the client and never in a query/mutation.
 */
import { action } from "./_generated/server";
import { api } from "./_generated/api";
import { v } from "convex/values";

export const measureOneCitationExample = action({
  args: {
    workspaceId: v.id("workspaces"),
    queryId: v.id("queries"),
    queryText: v.string(),
    pageUrl: v.string(),
  },
  handler: async (ctx, args) => {
    // 1) External I/O — allowed ONLY in an action. (Stubbed; P2 implements the
    //    real OpenAI Responses API + web_search call and reads url_citation
    //    annotations. Do NOT use chat-completions — no citations there.)
    //
    //    const res = await fetch("https://api.openai.com/v1/responses", {
    //      method: "POST",
    //      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    //      body: JSON.stringify({ model: "...", input: args.queryText,
    //        tools: [{ type: "web_search" }] }),
    //    });
    const sourceUrls: string[] = []; // <- url_citation annotations go here
    const cited = false;

    // 2) Persist via a MUTATION — normalization happens at that boundary, so
    //    page_url and source_urls land as canonical keys no matter what.
    await ctx.runMutation(api.records.insertMeasurement, {
      workspaceId: args.workspaceId,
      query_id: args.queryId,
      page_url: args.pageUrl,
      engine: "openai",
      model_version: "responses-2025-XX", // stamp for drift/reproducibility
      run_idx: 0,
      appeared: cited,
      cited,
      position: null,
      source_urls: sourceUrls,
      ts: Date.now(),
      window_tag: "baseline",
    });
  },
});
