/**
 * Sourcing action — build the live company "battlefield" for one workspace.
 *
 * Thin-slice (Card B, no live Fiber): the company layer is sourced ENTIRELY from
 * the workspace's own onboarding input — `own_domain` (role=customer) plus
 * `competitor_domains` (role=competitor). Fiber `find-similar-companies` is the
 * future battlefield expander; until that's wired we inject an EMPTY Fiber stub so
 * `buildCompanyLayer` writes exactly the customer + the known competitors (no
 * battlefield discovery rows). The seam is identical, so dropping a real
 * `createFiberClient` in later just adds the extra discovery rows.
 *
 * Lane discipline mirrors `convex/analysis.ts`: this is the ONLY place the sourcing
 * pure-logic (`sourcing/src/battlefield.ts`) is reached from Convex. It's a default
 * V8 action (NO `"use node"`): it touches no Node-only API — it only reuses the pure
 * `buildCompanyLayer` (its transitive deps — domain/fiber/types — are pure TS) and
 * writes through the sanctioned `api.records.upsertCompany` mutation. Actions can't
 * touch `ctx.db`, so the workspace read goes via `ctx.runQuery` and every company
 * write via `ctx.runMutation` (the CompanyWriter port adapter below).
 */
import { action } from "./_generated/server";
import { api } from "./_generated/api";
import { v } from "convex/values";

import {
  buildCompanyLayer,
  type CompanyWriter,
} from "../sourcing/src/battlefield";
import type { FiberClient } from "../sourcing/src/fiber";
import type { Company } from "../sourcing/src/types";
import { createFiberLive } from "../sourcing/src/fiber-live";
import { enrichFirmographics } from "../sourcing/src/firmographics";
import {
  extractUnderstanding,
  applyUnderstanding,
  type UnderstandingResult,
} from "../sourcing/src/understanding";
import { extractCompetitors } from "../sourcing/src/competitors";
import { createChatOpenAI } from "../sourcing/src/chat-openai";
import { normalizeDomain } from "./lib/domain";

/**
 * Empty Fiber stub for the thin slice: `find-similar-companies` returns nothing,
 * so `buildCompanyLayer` produces only the customer + known competitors (no
 * battlefield discovery rows). Swap this for `createFiberClient(...)` to go live.
 */
const EMPTY_FIBER: FiberClient = {
  async findSimilarCompanies() {
    return [];
  },
};

/** Mega-corp roots whose competing PRODUCT lives on a subdomain (Firebase →
 *  firebase.google.com). Registrable-domain normalization collapses them to the
 *  generic parent, which is useless as a labelled competitor, so we drop them. */
const GENERIC_PARENT_DOMAINS = new Set<string>([
  "google.com",
  "amazon.com",
  "microsoft.com",
  "apple.com",
  "facebook.com",
  "meta.com",
  "oracle.com",
  "ibm.com",
  "alibaba.com",
]);

/** Result of a battlefield build. Explicit so the handler's return type doesn't
 *  have to be inferred through the `api` cycle (buildBattlefield → measureWorkspace). */
export interface BattlefieldSummary {
  written: number;
  customer: number;
  competitors: number;
  battlefield: number;
  enriched: number;
  live: boolean;
  domains: string[];
}

export const buildBattlefield = action({
  args: {
    workspaceId: v.id("workspaces"),
    // When true, tail-schedule the live OpenAI measurement once the battlefield +
    // enrichment are written, so the gut-punch measures against the DISCOVERED set
    // (architecture rule: battlefield runs before measure). Default false so the
    // action stays reusable standalone.
    thenMeasure: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<BattlefieldSummary> => {
    // 1. Read the workspace (own_domain + competitor_domains) — already normalized
    //    at the customers mutation boundary.
    const workspace = await ctx.runQuery(api.customers.getWorkspace, {
      workspaceId: args.workspaceId,
    });
    if (!workspace) {
      throw new Error(`buildBattlefield: workspace ${args.workspaceId} not found`);
    }

    // LIVE GATE: with FIBER_API_KEY set, build the real battlefield (parallel
    // multi-angle company-search) + firmographics; without it, fall back to the
    // EMPTY_FIBER thin slice (customer + typed competitors only). Same seam, so the
    // gate is a one-line swap and tests/seed scripts stay key-free.
    const fiberKey = process.env.FIBER_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;
    const chat = openaiKey ? createChatOpenAI({ apiKey: openaiKey }) : null;

    // STEP A — read the customer's site ONCE and extract its understanding. Used both
    // to persist the category (the wizard creates the workspace with an empty
    // `vertical`, and measure.ts reads it so query generation is on-topic) and to
    // identify real competitors in Step B. Best-effort: any failure just falls back.
    let verticalHint = (workspace.vertical ?? "").trim();
    let customerUnderstanding: UnderstandingResult | undefined;
    if (fiberKey && chat) {
      try {
        const probe = createFiberLive({ apiKey: fiberKey });
        const siteText = await probe.describe(workspace.own_domain);
        if (siteText) {
          customerUnderstanding = await extractUnderstanding(chat, {
            domain: workspace.own_domain,
            name: workspace.name,
            siteText,
          });
          const cat = (customerUnderstanding.understanding.category ?? "").trim();
          if (!verticalHint && cat) {
            verticalHint = cat;
            await ctx.runMutation(api.customers.setVertical, {
              workspaceId: args.workspaceId,
              vertical: cat,
            });
          }
        }
      } catch {
        /* category derivation is best-effort */
      }
    }

    // STEP B — identify the customer's REAL direct competitors from its description.
    // Fiber's find-similar ranks by FIRMOGRAPHIC similarity (same size + industry
    // tag), which returns unrelated companies (atmosfy.io / cyzone.cn for a database
    // company). The model names the actual alternatives a buyer evaluates. We fall
    // back to Fiber's firmographic discovery ONLY when this plus the typed competitors
    // name nothing (obscure company, no input) — so the board is never empty.
    let namedCompetitors: string[] = [];
    if (chat && customerUnderstanding) {
      try {
        const u = customerUnderstanding.understanding;
        const res = await extractCompetitors(chat, {
          domain: workspace.own_domain,
          name: workspace.name,
          category: u.category,
          description: [u.positioning, customerUnderstanding.whatYouAre]
            .filter(Boolean)
            .join(". "),
        });
        // Drop mega-corp roots: a product like Firebase / AWS Amplify lives on a
        // subdomain (firebase.google.com), but registrable-domain normalization
        // collapses it to "google.com" / "amazon.com" — too generic to display or
        // measure cleanly. The model's product-specific picks (supabase.com,
        // hasura.io) survive; only the ambiguous parent roots are dropped.
        namedCompetitors = res.competitors
          .map((c) => normalizeDomain(c.domain))
          .filter(
            (d) => d && d !== workspace.own_domain && !GENERIC_PARENT_DOMAINS.has(d),
          );
      } catch {
        /* competitor identification is best-effort */
      }
    }

    const competitorDomains = Array.from(
      new Set([...workspace.competitor_domains, ...namedCompetitors]),
    ).filter((d) => d && d !== workspace.own_domain);

    // Keep a live Fiber client for firmographics enrichment regardless. Only let its
    // firmographic find-similar BUILD the battlefield when we have no real competitor
    // to anchor on; otherwise the battlefield is exactly the named/typed competitors.
    const live = fiberKey
      ? createFiberLive({ apiKey: fiberKey, verticalHint })
      : null;
    const fiber: FiberClient =
      competitorDomains.length === 0 ? live?.client ?? EMPTY_FIBER : EMPTY_FIBER;

    // 2. CompanyWriter port -> the sanctioned `api.records.upsertCompany` mutation.
    //    Pass only the optional enrichment families that are actually present so we
    //    never push `undefined`s through the mutation validator. Upsert is keyed on
    //    normalized domain, so re-runs are idempotent.
    const writer: CompanyWriter = {
      async upsertCompany(company: Company) {
        await ctx.runMutation(api.records.upsertCompany, {
          workspaceId: args.workspaceId,
          domain: company.domain,
          name: company.name,
          role: company.role,
          coverage_flags: company.coverage_flags,
          source_versions: company.source_versions as Record<string, string>,
          ...(company.firmographics !== undefined
            ? { firmographics: company.firmographics }
            : {}),
          ...(company.offpage !== undefined ? { offpage: company.offpage } : {}),
          ...(company.understanding !== undefined
            ? { understanding: company.understanding }
            : {}),
        });
      },
    };

    // 3. Build the company layer (customer + competitors + Fiber-discovered
    //    battlefield). buildCompanyLayer writes the base rows immediately so the
    //    board renders the battlefield fast; enrichment below updates them in place.
    const companies = await buildCompanyLayer(fiber, writer, {
      customerDomain: workspace.own_domain,
      customerName: workspace.name,
      competitorDomains,
    });

    // 4. ENRICH (live only): firmographics for every company (free from the sweep
    //    cache for battlefield rows; a kitchen-sink lookup for customer/competitors),
    //    plus an understanding pass for the CUSTOMER using Fiber's own description
    //    text as siteText (no scrape needed). Parallel + isolated (allSettled): one
    //    failed enrichment never blanks the board, and coverage flags stay honest.
    let enriched = 0;
    if (live) {
      const results = await Promise.allSettled(
        companies.map(async (company) => {
          let c = await enrichFirmographics(live.firmographics, company);
          if (chat && c.role === "customer") {
            try {
              // Reuse the understanding we already extracted to seed the vertical;
              // only extract here if we didn't (e.g. the workspace had a preset
              // vertical, so the pre-discovery derivation was skipped).
              let result = customerUnderstanding;
              if (!result) {
                const siteText = await live.describe(c.domain);
                if (siteText) {
                  result = await extractUnderstanding(chat, {
                    domain: c.domain,
                    name: c.name,
                    siteText,
                  });
                }
              }
              if (result) c = applyUnderstanding(c, result);
            } catch {
              /* understanding is best-effort — never fail the company on it */
            }
          }
          await writer.upsertCompany(c);
          return c;
        }),
      );
      enriched = results.filter((r) => r.status === "fulfilled").length;
    }

    // 5. Chain the measurement sweep so it ranks the customer against the DISCOVERED
    //    battlefield, not just the typed competitors.
    if (args.thenMeasure) {
      await ctx.scheduler.runAfter(0, api.measure.measureWorkspace, {
        workspaceId: args.workspaceId,
      });
    }

    return {
      written: companies.length,
      customer: companies.filter((c) => c.role === "customer").length,
      competitors: companies.filter((c) => c.role === "competitor").length,
      battlefield: companies.filter((c) => c.role === "battlefield").length,
      enriched,
      live: live !== null,
      domains: companies.map((c) => c.domain),
    };
  },
});
