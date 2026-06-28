/**
 * Live citation measurement (owner: P2 / Card A).
 *
 * The action that turns onboarding into a REAL gut-punch: it runs templated buyer
 * questions against the OpenAI Responses API (`web_search` tool) and labels each
 * candidate page (you + competitors) as cited / not-cited, then writes one
 * `measurement` row per (query × page) through the sanctioned mutation boundary.
 *
 * Architecture rule (see actions.example.ts): the ACTION is the only place external
 * I/O happens; it never touches `ctx.db` — it reads via `ctx.runQuery` and writes via
 * `ctx.runMutation`, so domain/URL keys are still normalized at the mutation boundary
 * even though the data came from an external engine.
 *
 * REUSE: the heavy lifting is the already-tested measurement lane —
 *   `runOpenAIQuery`  (measurement/src/engines/openai.ts) — pure `fetch`, injectable
 *   `buildLabeledRows`(measurement/src/pipeline.ts)       — case-control labeling
 * imported here by relative path (pure TS, no Node builtins → bundles in the V8 action).
 *
 * RESILIENCE: queries run in PARALLEL via `Promise.allSettled` with a 45s
 * `AbortSignal.timeout` per call. A single failed/timed-out query is isolated — it
 * can never blank the board (the demo's emotional core).
 *
 * Secrets: `OPENAI_API_KEY` is read from the Convex deploy env (`npx convex env set`),
 * never from the client.
 */
import { action } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { api } from "./_generated/api";
import { v } from "convex/values";

import { runOpenAIQuery } from "../measurement/src/engines/openai";
import { createChatOpenAI } from "../sourcing/src/chat-openai";
import { generateBuyerQueries } from "../sourcing/src/queryGen";
import { buildLabeledRows } from "../measurement/src/pipeline";
import { normalizeDomain } from "../measurement/src/normalize";
import type { CandidatePage, SeedSource } from "../measurement/src/contract-records";
import type { Engine, WindowTag } from "../measurement/src/types";

/** gpt-5-mini: works with web_search, fastest measurement-volume tier (~31s/query). */
const DEFAULT_MODEL = "gpt-5-mini";
/** A hung query would otherwise burn the whole action — bound every call. */
const QUERY_TIMEOUT_MS = 90_000; // gpt-5-mini + web_search can take 30-90s; parallel, so wall-clock ~= slowest
// Max reach by default: 16 distinct buyer queries → ~60 unique cited domains live
// (verified). ~$0.02/query ≈ $0.32/sweep, ~60-70s parallel. Dial down via nQueries.
const DEFAULT_N_QUERIES = 16;
const MAX_N_QUERIES = 16;
/** "high" web_search depth surfaces more sources per query (more citations). */
const SEARCH_CONTEXT_SIZE = "high" as const;

/** OpenAI-only in v1 (cross-engine overlap is ~11%; never merge engines). */
const OPENAI_ENGINES: Engine[] = ["openai"];

// ---------------------------------------------------------------------------
// PURE, UNIT-TESTABLE HELPERS (no Convex, no I/O) — exported for tests.
// ---------------------------------------------------------------------------

/**
 * Templated buyer questions for a vertical. These are the "would a buyer ask this?"
 * seeds whose answers reveal whether YOU get cited vs your competitors. Keyword-sourced
 * (`seed_source: "keyword"`). Default 6, hard cap 8 (cost guard), floor 1.
 */
const SEED_TEMPLATES: ReadonlyArray<(vertical: string) => string> = [
  (v) => `best ${v} tools 2026`,
  (v) => `top ${v} software compared`,
  (v) => `which ${v} platform should I choose`,
  (v) => `${v} vendors for B2B teams`,
  (v) => `most recommended ${v} solutions`,
  (v) => `${v} alternatives worth evaluating`,
  (v) => `enterprise ${v} buyers guide`,
  (v) => `${v} tools with the best reviews`,
  (v) => `${v} software for startups`,
  (v) => `affordable ${v} tools`,
  (v) => `${v} platforms with the best integrations`,
  (v) => `leading ${v} companies`,
  (v) => `${v} tools for small business`,
  (v) => `open source ${v} options`,
  (v) => `${v} software comparison and pricing`,
  (v) => `what is the best ${v} tool for B2B SaaS`,
];

export function buildSeedQueries(
  vertical: string,
  n: number = DEFAULT_N_QUERIES,
): Array<{ text: string; seed_source: SeedSource }> {
  const vert = (vertical ?? "").trim() || "software";
  const requested = Number.isFinite(n) ? Math.floor(n) : DEFAULT_N_QUERIES;
  const count = Math.max(1, Math.min(requested || DEFAULT_N_QUERIES, MAX_N_QUERIES));
  const out: Array<{ text: string; seed_source: SeedSource }> = [];
  for (let i = 0; i < count; i++) {
    const tmpl = SEED_TEMPLATES[i % SEED_TEMPLATES.length];
    out.push({ text: tmpl(vert), seed_source: "keyword" });
  }
  return out;
}

/**
 * The case-control candidate pool for a baseline sweep: YOUR domain (the "case" we
 * care about) plus every competitor domain (the "controls"). A loser is a pool page
 * that wasn't cited — never an arbitrary uncited page.
 */
export function buildCandidatePool(
  ownDomain: string,
  competitorDomains: ReadonlyArray<string>,
): CandidatePage[] {
  const pool: CandidatePage[] = [];
  if (ownDomain) pool.push({ company_domain: ownDomain, url: ownDomain, role: "customer" });
  for (const d of competitorDomains) {
    if (d) pool.push({ company_domain: d, url: d, role: "competitor" });
  }
  return pool;
}

/** Max Fiber-discovered battlefield companies to fold into a measurement pool. */
const BATTLEFIELD_POOL_CAP = 20;

/**
 * Candidate pool for a sweep, PREFERRING the discovered battlefield when present.
 * The customer + typed competitors are always in (the precision core); every
 * Fiber-discovered `battlefield` company is added on top (deduped, capped) so the
 * gut-punch ranks the customer against the REAL competitive set — that's where the
 * Fiber integration shows on the board. Falls back to the own+typed thin slice when
 * no companies have been sourced yet (preserves the key-free seed/test behavior).
 */
export function buildPoolFromCompanies(
  ownDomain: string,
  competitorDomains: ReadonlyArray<string>,
  companies: ReadonlyArray<{ domain: string; role: string }>,
  cap: number = BATTLEFIELD_POOL_CAP,
): CandidatePage[] {
  const base = buildCandidatePool(ownDomain, competitorDomains);
  if (companies.length === 0) return base;
  const seen = new Set(base.map((p) => p.company_domain));
  const pool = [...base];
  let added = 0;
  for (const c of companies) {
    // Measure BOTH Fiber-discovered battlefield rows AND named/typed competitor
    // rows. Competitors identified from the customer's description are written to
    // the companies table with role "competitor" (not into ws.competitor_domains),
    // so a battlefield-only filter would leave them discovered-but-never-measured —
    // the gut-punch then shows "TOP COMPETITOR · 0 out of —" with an empty board.
    if (
      (c.role !== "battlefield" && c.role !== "competitor") ||
      !c.domain ||
      seen.has(c.domain)
    )
      continue;
    seen.add(c.domain);
    pool.push({ company_domain: c.domain, url: c.domain, role: "candidate" });
    if (++added >= cap) break;
  }
  return pool;
}

/**
 * Candidate pool from a set of page URLs (used by the post-window re-measure: the
 * experiment's treatment/control pages). De-dupes; keys company_domain on the
 * normalized registrable domain so it matches engine citation domains.
 */
export function pagesToCandidatePool(urls: ReadonlyArray<string>): CandidatePage[] {
  const seen = new Set<string>();
  const pool: CandidatePage[] = [];
  for (const url of urls) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    pool.push({ company_domain: normalizeDomain(url), url, role: "candidate" });
  }
  return pool;
}

// ---------------------------------------------------------------------------
// FETCH WRAPPER — per-call timeout, resolves the GLOBAL fetch at call time so
// test stubs (vi.stubGlobal("fetch", …)) apply.
// ---------------------------------------------------------------------------

/** AbortSignal.timeout, guarded so a runtime/lib without it degrades to "no timeout". */
function timeoutSignal(ms: number): AbortSignal | undefined {
  try {
    const ctor = AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal };
    if (typeof ctor.timeout === "function") return ctor.timeout(ms);
  } catch {
    /* fall through — no signal */
  }
  return undefined;
}

const fetchWithTimeout = ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
  fetch(input, { ...init, signal: timeoutSignal(QUERY_TIMEOUT_MS) })) as typeof fetch;

// ---------------------------------------------------------------------------
// SHARED SWEEP CORE — used by both measureWorkspace (baseline) and remeasure (post).
// ---------------------------------------------------------------------------

export interface SweepSummary {
  /** Queries persisted (always inserted, even if their engine call later fails). */
  queries: number;
  /** Queries whose engine call succeeded and whose rows were written. */
  measured: number;
  /** Queries whose engine call failed/timed out (isolated by allSettled). */
  failed: number;
  /** Total measurement rows written across all succeeded queries. */
  rows: number;
}

/**
 * Run one measurement sweep: persist N seed queries, fan them out to OpenAI in
 * parallel, label each candidate page, and write the `measurement` rows. Pure
 * orchestration over the records mutations — never touches the DB directly.
 */
export async function runMeasurementSweep(
  ctx: ActionCtx,
  opts: {
    workspaceId: Id<"workspaces">;
    vertical: string;
    candidatePool: CandidatePage[];
    windowTag: WindowTag;
    nQueries?: number;
    experimentId?: Id<"experiments">;
    /** Pre-built seed queries (e.g. LLM-generated). Falls back to the templates. */
    seeds?: Array<{ text: string; seed_source: SeedSource }>;
  },
): Promise<SweepSummary> {
  const apiKey =
    (typeof process !== "undefined" && process.env
      ? process.env.OPENAI_API_KEY
      : undefined) ?? "";

  const seeds =
    opts.seeds && opts.seeds.length > 0
      ? opts.seeds
      : buildSeedQueries(opts.vertical, opts.nQueries);

  // 1) Persist every seed query FIRST, so the query-review view fills regardless of
  //    whether a later engine call fails. Capture the real Convex queryIds.
  const inserted: Array<{
    queryId: Id<"queries">;
    text: string;
    seed_source: SeedSource;
  }> = [];
  for (const seed of seeds) {
    const queryId = await ctx.runMutation(api.records.insertQuery, {
      workspaceId: opts.workspaceId,
      customer_id: opts.workspaceId,
      vertical: opts.vertical,
      text: seed.text,
      seed_source: seed.seed_source,
      target_engines: OPENAI_ENGINES,
    });
    inserted.push({ queryId, text: seed.text, seed_source: seed.seed_source });
  }

  // 2) Fan out to OpenAI IN PARALLEL. allSettled isolates a single failed/timed-out
  //    query — one bad call can NEVER blank the board.
  const settled = await Promise.allSettled(
    inserted.map(async (q) => {
      const engineResult = await runOpenAIQuery({
        query: q.text,
        apiKey,
        model: DEFAULT_MODEL,
        fetchImpl: fetchWithTimeout,
        searchContextSize: SEARCH_CONTEXT_SIZE,
      });

      const rows = buildLabeledRows({
        query: {
          id: q.queryId,
          customer_id: opts.workspaceId,
          vertical: opts.vertical,
          text: q.text,
          seed_source: q.seed_source,
          target_engines: OPENAI_ENGINES,
        },
        engineResult,
        candidatePool: opts.candidatePool,
        ts: Date.now(),
        windowTag: opts.windowTag,
      });

      for (const row of rows) {
        await ctx.runMutation(api.records.insertMeasurement, {
          workspaceId: opts.workspaceId,
          query_id: q.queryId,
          page_url: row.page_url,
          engine: row.engine,
          model_version: row.model_version,
          run_idx: row.run_idx,
          appeared: row.appeared,
          cited: row.cited,
          position: row.position,
          source_urls: row.source_urls,
          ts: row.ts,
          window_tag: row.window_tag,
          ...(opts.experimentId !== undefined
            ? { experiment_id: opts.experimentId }
            : {}),
        });
      }
      return rows.length;
    }),
  );

  let measured = 0;
  let failed = 0;
  let rows = 0;
  for (const r of settled) {
    if (r.status === "fulfilled") {
      measured += 1;
      rows += r.value;
    } else {
      failed += 1;
    }
  }
  return { queries: inserted.length, measured, failed, rows };
}

// ---------------------------------------------------------------------------
// PUBLIC ACTION — onboarding trigger target.
// ---------------------------------------------------------------------------

/**
 * Measure a workspace's citation footprint live: you vs competitors, OpenAI only,
 * `window_tag: "baseline"`. Scheduled from `createWorkspace` when measure_on_create.
 */
export const measureWorkspace = action({
  args: {
    workspaceId: v.id("workspaces"),
    nQueries: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<SweepSummary> => {
    const ws = await ctx.runQuery(api.customers.getWorkspace, {
      workspaceId: args.workspaceId,
    });
    if (!ws) throw new Error("workspace not found");

    // Rank against the DISCOVERED battlefield when it exists (Fiber sourcing ran
    // first); otherwise the own+typed thin slice. board.battlefield returns the
    // workspace's company rows.
    const companies = await ctx.runQuery(api.board.battlefield, {
      workspaceId: args.workspaceId,
    });
    const pool = buildPoolFromCompanies(ws.own_domain, ws.competitor_domains, companies);

    // Query generation must be about the founder's ACTUAL space. The wizard creates
    // the workspace with an empty `vertical` (only the URL is known up front), so the
    // old code fell back to the generic literal "software" — producing useless seeds
    // like "best software tools 2026" / "top software software compared" that the
    // customer is never cited for. Prefer the category our site analysis already
    // extracted (e.g. "serverless state platform") so the seeds are on-topic.
    const customer = companies.find((c) => c.role === "customer");
    const u = customer?.understanding;
    const analyzedCategory = u?.category?.trim();
    const vertical = (ws.vertical?.trim() || analyzedCategory || "software").toLowerCase();

    // Generate NATURAL buyer questions for the company's real category instead of the
    // rigid B2B-SaaS templates ("best <category> tools for B2B teams"), which produce
    // nonsense for non-SaaS companies (e.g. Apple → "best consumer electronics tools").
    // Best-effort: on any failure the sweep falls back to the templates.
    const nQueries = args.nQueries ?? DEFAULT_N_QUERIES;
    let seeds: Array<{ text: string; seed_source: SeedSource }> | undefined;
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey && (analyzedCategory || ws.vertical)) {
      try {
        const chat = createChatOpenAI({ apiKey: openaiKey });
        const competitor = companies.find((c) => c.role !== "customer")?.domain;
        const texts = await generateBuyerQueries(chat, {
          ownName: ws.name || ws.own_domain,
          category: analyzedCategory ?? ws.vertical,
          icp: u?.icp,
          positioning: u?.positioning,
          competitorName: competitor,
          n: nQueries,
        });
        if (texts.length > 0) {
          seeds = texts.map((text) => ({ text, seed_source: "keyword" as const }));
        }
      } catch {
        /* fall back to template seeds */
      }
    }

    const summary = await runMeasurementSweep(ctx, {
      workspaceId: args.workspaceId,
      vertical,
      candidatePool: pool,
      windowTag: "baseline",
      nQueries: args.nQueries,
      seeds,
    });

    // Close stages 7-9: the descriptive baseline now exists, so schedule the
    // aggregation + Bayesian fit (which in turn tail-schedules the experiment
    // designer). Scheduled as its own action so the Python fit round-trip gets a
    // fresh execution budget and a single failed query can't block the fit.
    await ctx.scheduler.runAfter(0, api.diagnose.runFitForWorkspace, {
      workspaceId: args.workspaceId,
    });

    // The sweep just revealed the top-cited competitor, so generate the
    // company-specific comparison-page brief now (the wizard + asset page render it
    // instead of static copy). Scheduled as its own action — best-effort, never
    // blocks the measurement return.
    await ctx.scheduler.runAfter(0, api.asset.generateBrief, {
      workspaceId: args.workspaceId,
    });

    return summary;
  },
});
