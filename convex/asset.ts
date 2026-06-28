/**
 * Asset-brief generation (owner: P3 generation step).
 *
 * After the baseline sweep, we know which competitor AI actually cites most for the
 * customer's buyer questions (the gut-punch top competitor). This action asks the
 * chat model to write a SHORT, company-specific comparison-page brief — headline,
 * one-line angle, three concrete points — grounded ONLY in the understanding we
 * extracted from the customer's own site, and persists it on the workspace. The
 * wizard's "what we'll build" card and the asset page render it instead of static
 * template copy. Best-effort: any failure leaves the generic fallback in place.
 *
 * Default V8 action: it only reaches the pure `generateAssetBrief` (over the
 * injectable ChatModel port) and writes through sanctioned mutations.
 */
import { action } from "./_generated/server";
import { api } from "./_generated/api";
import { v } from "convex/values";
import { createChatOpenAI } from "../sourcing/src/chat-openai";
import {
  generateAssetBrief,
  ASSET_BRIEF_MODEL_VERSION,
} from "../sourcing/src/assetBrief";

export const generateBrief = action({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }): Promise<{ generated: boolean }> => {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) return { generated: false };

    const ws = await ctx.runQuery(api.customers.getWorkspace, { workspaceId });
    if (!ws) return { generated: false };

    const companies = await ctx.runQuery(api.board.battlefield, { workspaceId });
    const customer = companies.find((c) => c.role === "customer");
    const u = customer?.understanding;

    // Top competitor = the one AI cites most across engines (the real gut-punch
    // rival). Fall back to any known competitor if nothing is cited yet.
    const gut = await ctx.runQuery(api.board.gutPunch, { workspaceId });
    let topDomain: string | undefined;
    let topCited = -1;
    for (const e of Object.values(gut.perEngine) as Array<{
      topCompetitor: { domain: string; cited: number } | null;
    }>) {
      const tc = e.topCompetitor;
      if (tc && tc.cited > topCited) {
        topCited = tc.cited;
        topDomain = tc.domain;
      }
    }
    if (!topDomain) {
      topDomain = companies.find((c) => c.role !== "customer")?.domain;
    }
    if (!topDomain) return { generated: false };

    // COMPOUND: pull the proprietary measured lifts for this category (pooled across
    // customers) so recommendations LEAD with proven changes, not just LLM guesses.
    // Empty until experiments complete — the brief degrades to LLM hypotheses then.
    const provenLifts = u?.category
      ? await ctx.runQuery(api.moat.provenLiftsByCategory, {
          workspaceId,
          category: u.category,
        })
      : [];

    const chat = createChatOpenAI({ apiKey: openaiKey });
    const brief = await generateAssetBrief(chat, {
      ownName: ws.name || ws.own_domain,
      ownDomain: ws.own_domain,
      competitorName: topDomain,
      category: u?.category,
      icp: u?.icp,
      positioning: u?.positioning,
      whatYouAre: u?.what_you_are,
      provenLifts,
    });
    if (!brief) return { generated: false };

    await ctx.runMutation(api.customers.setAssetBrief, {
      workspaceId,
      brief: {
        ...brief,
        competitor_domain: topDomain,
        model_version: ASSET_BRIEF_MODEL_VERSION,
        generated_at: Date.now(),
      },
    });
    return { generated: true };
  },
});
