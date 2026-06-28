// Grounded query generation (P3 · Phase 2, task #3).
//
// SHARED-CONTEXT non-negotiable supply fact #2: "Don't invent queries. Seed from
// real data (SERP People-Also-Ask + keyword volume, Reddit/forum mining, customer
// analytics), then LLM-EXPAND. Tag every query's seed_source." This module owns the
// `query` record (docs/CONTRACT.md #4) and the assembly of the vertical query pack.
//
// Lane discipline (mirrors fiber.ts / understanding.ts): every real source is reached
// through a PORT (`SerpSeedClient`, `RedditSeedClient`) and the LLM-expand step goes
// through the EXISTING `ChatModel` port. Unit tests inject mocks; CI makes no live
// vendor calls and this module imports no SDK and touches no network.
//
// Red-team Theme E (the gotcha the card calls out): "don't let llm_expand dominate
// the query set — keep a healthy ratio of real-seeded queries (P1 surfaces this
// ratio)." Two mechanisms enforce that here:
//   1. PRECEDENCE — a query that appears from BOTH a real seed and llm_expand keeps
//      the REAL seed_source. Real seeds win; llm_expand never downgrades a real one.
//   2. HEALTHY-RATIO GUARD — `minRealSeededRatio` is a floor on the real-vs-total
//      ratio. If keeping all expansion would push the real ratio below the floor, we
//      CAP the number of llm_expand queries kept (we never fabricate real seeds).

import type { Engine, Query, SeedSource } from "./types";
import type { ChatModel } from "./understanding";

/** Stable version tag for the assembled vertical query pack. */
export const QUERY_PACK_VERSION = "query-pack@v1";

/** Default multiplier the production pack uses to size LLM expansion (300–500 queries). */
const DEFAULT_EXPANSION_FACTOR = 5;

/** Default floor on the real-seeded ratio — keep a healthy majority-ish of real seeds. */
const DEFAULT_MIN_REAL_SEEDED_RATIO = 0.4;

// ─────────────────────────────────────────────────────────────────────────────
// Seed-source ports — mirror FiberClient. Real impls call SERP/DataForSEO/Reddit;
// tests pass mocks. An analytics seed is passed directly as `analyticsQueries`.
// ─────────────────────────────────────────────────────────────────────────────

/** Common args for a seed lookup: the vertical plus the customer's seed terms. */
export interface SeedQueryArgs {
  vertical: string;
  seedTerms: string[];
}

/**
 * SERP seed port. `peopleAlsoAsk` returns real "People Also Ask" questions (tagged
 * `paa`); `keywordQueries` returns real keyword-volume queries (tagged `keyword`).
 */
export interface SerpSeedClient {
  peopleAlsoAsk(args: SeedQueryArgs): Promise<string[]>;
  keywordQueries(args: SeedQueryArgs): Promise<string[]>;
}

/** Reddit/forum mining port — real questions mined from threads (tagged `reddit`). */
export interface RedditSeedClient {
  mineQuestions(args: SeedQueryArgs): Promise<string[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic id / normalization. Ids MUST be reproducible across runs (no
// Date.now / Math.random) so re-running the pack yields the same keys and so
// dedupe is stable. Normalization folds case + whitespace before hashing, which
// is what makes case/whitespace variants of the same query collapse to one id.
// ─────────────────────────────────────────────────────────────────────────────

/** Fold a query to its canonical comparison form: trimmed, lowercased, single-spaced. */
function normalizeText(text: string): string {
  return String(text ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** FNV-1a (32-bit) — a tiny deterministic, dependency-free string hash. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Deterministic, reproducible id for a query: a readable slug of the normalized
 * text plus a stable hash suffix (the hash guarantees uniqueness even when the
 * slug is truncated/empty). Case- and whitespace-variants share an id because the
 * id is derived from `normalizeText`.
 */
export function queryId(text: string): string {
  const norm = normalizeText(text);
  const hash = fnv1a(norm);
  const slug = norm.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return slug ? `q-${slug}-${hash}` : `q-${hash}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM-expand — uses the EXISTING ChatModel port. We hand it the real seeds and ask
// for more queries in the same vertical; the reply (a JSON array or a newline list)
// is parsed into candidate strings, all tagged `llm_expand` downstream.
// ─────────────────────────────────────────────────────────────────────────────

const EXPAND_SYSTEM_PROMPT =
  "You expand a list of real search queries into more queries a buyer in the same " +
  "vertical would ask. Return STRICT JSON only: a flat array of short query strings " +
  "(no prose, no code fences, no numbering). Stay on-topic and avoid duplicates.";

function buildExpandPrompt(vertical: string, seeds: string[], want: number): string {
  return (
    `Vertical: ${vertical}\n` +
    `Want about ${want} additional queries.\n` +
    `Real seed queries:\n${seeds.map((s) => `- ${s}`).join("\n")}`
  );
}

/** Parse the model reply into query strings — tolerant of JSON arrays or bulleted lists. */
function parseExpandedQueries(raw: string): string[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  const trimmed = raw.trim();

  // Preferred path: a strict JSON array of strings (possibly fenced).
  const fenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(fenced);
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
    }
  } catch {
    // fall through to line parsing
  }

  // Fallback: one query per line, stripping leading list markers ("1. ", "- ", "* ", "• ").
  return trimmed
    .split("\n")
    .map((line) => line.replace(/^[\s>]*(?:[-*•]|\d+[.)])\s+/, "").trim())
    .filter((l) => l.length > 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// generateQueries — the pipeline.
// ─────────────────────────────────────────────────────────────────────────────

export interface GenerateQueriesArgs {
  customerId: string;
  vertical: string;
  seedTerms: string[];
  analyticsQueries?: string[];
  targetEngines: Engine[];
  serp: SerpSeedClient;
  reddit: RedditSeedClient;
  model: ChatModel;
  /** How aggressively to expand (production targets 300–500 via this factor). */
  expansionFactor?: number;
  /** Floor on the real-seeded ratio; llm_expand is capped to hold this floor. */
  minRealSeededRatio?: number;
}

/** A candidate query with its provenance, before assembly into a Query record. */
interface TaggedText {
  text: string;
  seed_source: SeedSource;
}

/**
 * Grounded query generation: gather REAL seeds (paa / keyword / reddit / analytics),
 * LLM-EXPAND from them, normalize + DEDUPE with real-seeds-win precedence, enforce the
 * healthy-ratio floor by capping llm_expand, then assemble contract `query` records.
 */
export async function generateQueries(args: GenerateQueriesArgs): Promise<Query[]> {
  const {
    customerId,
    vertical,
    seedTerms,
    analyticsQueries = [],
    targetEngines,
    serp,
    reddit,
    model,
    expansionFactor = DEFAULT_EXPANSION_FACTOR,
    minRealSeededRatio = DEFAULT_MIN_REAL_SEEDED_RATIO,
  } = args;

  const seedArgs: SeedQueryArgs = { vertical, seedTerms };

  // 1. Gather REAL-seeded queries, each tagged with its true source. The three
  //    network sources run concurrently; analytics is supplied directly.
  const [paa, keyword, redditQs] = await Promise.all([
    serp.peopleAlsoAsk(seedArgs),
    serp.keywordQueries(seedArgs),
    reddit.mineQuestions(seedArgs),
  ]);

  // Source order defines precedence among real sources (first occurrence keeps the id).
  const realTagged: TaggedText[] = [
    ...paa.map((text) => ({ text, seed_source: "paa" as SeedSource })),
    ...keyword.map((text) => ({ text, seed_source: "keyword" as SeedSource })),
    ...redditQs.map((text) => ({ text, seed_source: "reddit" as SeedSource })),
    ...analyticsQueries.map((text) => ({ text, seed_source: "analytics" as SeedSource })),
  ];

  // Dedupe real seeds by id; first-seen wins (real-vs-real precedence by source order).
  const byId = new Map<string, TaggedText>();
  for (const t of realTagged) {
    if (typeof t.text !== "string" || t.text.trim() === "") continue;
    const id = queryId(t.text);
    if (!byId.has(id)) byId.set(id, t);
  }
  const realCount = byId.size;

  // 2. LLM-EXPAND from the real seeds. We seed the model with the real-seed texts so
  //    expansion stays grounded (we do NOT invent queries from nothing).
  const realSeedTexts = [...byId.values()].map((t) => t.text);
  const want = Math.max(0, realSeedTexts.length * Math.max(1, expansionFactor));
  let expanded: string[] = [];
  if (want > 0 && realSeedTexts.length > 0) {
    const raw = await model.complete({
      system: EXPAND_SYSTEM_PROMPT,
      user: buildExpandPrompt(vertical, realSeedTexts, want),
    });
    expanded = parseExpandedQueries(raw);
  }

  // 3a. Dedupe llm_expand against itself AND against real seeds — PRECEDENCE: any text
  //     already present as a real seed is dropped here, so it keeps its real seed_source
  //     and is never downgraded to llm_expand.
  const llmTagged: TaggedText[] = [];
  const seenLlm = new Set<string>();
  for (const text of expanded) {
    if (typeof text !== "string" || text.trim() === "") continue;
    const id = queryId(text);
    if (byId.has(id) || seenLlm.has(id)) continue; // real wins; skip llm dupes
    seenLlm.add(id);
    llmTagged.push({ text, seed_source: "llm_expand" });
  }

  // 3b. HEALTHY-RATIO GUARD. We want real / (real + keptLlm) >= floor. Solving for the
  //     cap: keptLlm <= real * (1 - floor) / floor. We CAP llm_expand to that many — we
  //     never fabricate real seeds to hit the floor. floor <= 0 disables the cap.
  const floor = minRealSeededRatio;
  let keptLlm = llmTagged;
  if (floor > 0) {
    // +epsilon before flooring so exact ratios (e.g. 2*0.6/0.4 = 3) aren't lost to
    // binary float error (which would yield 2.9999… -> 2 and cap one query too tight).
    const maxLlm = floor >= 1 ? 0 : Math.floor((realCount * (1 - floor)) / floor + 1e-9);
    if (llmTagged.length > maxLlm) keptLlm = llmTagged.slice(0, maxLlm);
  }

  // 4. Assemble contract `query` records (real seeds first, then capped llm_expand).
  const ordered = [...byId.values(), ...keptLlm];
  return ordered.map((t) => ({
    id: queryId(t.text),
    customer_id: customerId,
    vertical,
    text: t.text,
    seed_source: t.seed_source,
    target_engines: [...targetEngines],
  }));
}

/**
 * The real-vs-llm_expand breakdown P1 surfaces. `real` is every NON-llm_expand query
 * (paa | keyword | reddit | analytics); `realRatio` is real / total (0 when empty).
 */
export function seedSourceRatio(queries: Query[]): {
  total: number;
  real: number;
  llm_expand: number;
  realRatio: number;
} {
  const total = queries.length;
  const llm_expand = queries.filter((q) => q.seed_source === "llm_expand").length;
  const real = total - llm_expand;
  return { total, real, llm_expand, realRatio: total === 0 ? 0 : real / total };
}
