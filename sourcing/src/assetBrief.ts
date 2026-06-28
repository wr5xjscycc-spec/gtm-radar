// AI-generated comparison-page brief (owner: P3/P4 seam).
//
// The wizard's "what we'll build" card and the asset page were static templates.
// This pass writes a SHORT, company-specific brief — a headline, a one-line angle,
// and three concrete points — for "{you} vs {your top competitor}", grounded ONLY
// in the understanding we extracted from the customer's own site. Anti-fabrication
// is load-bearing: the prompt forbids inventing pricing/features it wasn't given,
// so the copy is specific to the real company without making up facts.
//
// Pure + injectable (same ChatModel port as understanding.ts / competitors.ts), so
// tests stay deterministic and free; the Convex action wires the real OpenAI client.

import type { ChatModel } from "./understanding";

export const ASSET_BRIEF_MODEL_VERSION = "gpt-5-mini/asset-brief@v1";

export interface AssetBriefInput {
  ownName: string;
  ownDomain: string;
  competitorName: string;
  category?: string;
  icp?: string;
  positioning?: string;
  whatYouAre?: string;
  /**
   * Measured lifts from the proprietary interventional dataset for this category.
   * When present, these become "measured" recommendations (built in code, not by
   * the LLM) and the LLM is told to AVOID re-suggesting them, so its slots add net
   * new "to test" ideas rather than duplicating what we've already proven.
   */
  provenLifts?: ProvenLift[];
}

export interface AssetRecommendation {
  /** Short imperative title, e.g. "Publish a GetSphere vs Hugging Face page". */
  title: string;
  /** One specific sentence on what to do, grounded in the company's space. */
  detail: string;
  /**
   * Provenance — the honesty layer. "measured" recommendations are backed by the
   * proprietary interventional dataset (real causal lift from completed experiments
   * in this category); "hypothesis" recommendations are LLM-suggested changes to
   * test. The UI surfaces this so we never present advice as if it were measured.
   */
  kind: "measured" | "hypothesis";
  /** For measured recs: the exact measured-lift sentence (verbatim, not LLM). */
  evidence?: string;
}

/** One pooled measured lift from the interventional dataset (cross-customer). */
export interface ProvenLift {
  feature: string;
  engine: string;
  n: number;
  mean_lift: number;
  ci_low: number;
  ci_high: number;
}

/** Internal feature key → plain English (mirrors the frontend FEATURE_LABELS). */
const FEATURE_LABELS: Record<string, string> = {
  comparison_table: "a comparison page",
  direct_answer_first: "leading with a direct answer",
  entity_cooccurrence: "being mentioned alongside competitors online",
  schema_markup: "structured data markup",
  stats_density: "using data and statistics",
  citation_density: "citing sources",
  heading_structure: "well-structured headings",
  freshness_days: "recently updating content",
  query_term_coverage: "covering buyer keywords",
  word_count: "content length",
};

/**
 * Build MEASURED recommendations from the proprietary interventional dataset. These
 * are NOT LLM-generated: the numbers come straight from completed experiments, so an
 * LLM cannot fabricate them. Only positive, decisive lifts (CI above zero) become
 * recommendations — a measured null is honest signal but not something to "do".
 */
export function buildMeasuredRecommendations(
  provenLifts: ProvenLift[],
): AssetRecommendation[] {
  return provenLifts
    .filter((p) => p.ci_low > 0) // decisive positive measured effect only
    .slice(0, 3)
    .map((p) => {
      const label = FEATURE_LABELS[p.feature] ?? p.feature.replace(/_/g, " ");
      const pct = (x: number) => `${x >= 0 ? "+" : ""}${Math.round(x * 100)}%`;
      return {
        kind: "measured" as const,
        title: `Add ${label}`,
        detail: `Companies in your category that changed ${label} saw a measured citation lift of ${pct(
          p.mean_lift,
        )} (90% CI ${pct(p.ci_low)}–${pct(p.ci_high)}, n=${p.n} experiment${
          p.n === 1 ? "" : "s"
        }).`,
        evidence: `${pct(p.mean_lift)} measured lift · n=${p.n}`,
      };
    });
}

export interface AssetBrief {
  /** A specific comparison-page title a buyer would actually ask AI. */
  headline: string;
  /** One specific sentence on the customer's real angle vs the competitor. */
  subhead: string;
  /** Three concrete, honest reasons a buyer would choose the customer. */
  points: string[];
  /** Actionable changes to TEST to get cited (hypotheses, never guarantees). */
  recommendations: AssetRecommendation[];
}

const SYSTEM_PROMPT =
  "You are a B2B AEO (AI-engine optimization) strategist. A company wants AI answer " +
  "engines (ChatGPT, Perplexity, Gemini) to cite IT instead of its top competitor. " +
  "Reply with STRICT JSON ONLY: " +
  '{"headline":string,"subhead":string,"points":[string,string,string],' +
  '"recommendations":[{"title":string,"detail":string}]}. ' +
  "headline = a specific comparison-page title a real buyer would type into AI, in the " +
  "form '<Company> vs <Competitor>: which <category thing> is right for <who they sell to>?' " +
  "using the ACTUAL category and customer given. " +
  "subhead = ONE specific sentence naming the company's real differentiator versus the " +
  "competitor, grounded ONLY in the positioning provided. " +
  "points = exactly 3 short, specific, honest reasons a buyer in this category would " +
  "choose this company — each a concrete phrase drawn from its positioning / who it sells to. " +
  "recommendations = 3 to 4 SPECIFIC, actionable changes this company should TEST to get " +
  "cited by AI for its buyer questions (e.g. publish a named comparison page, lead a page " +
  "with a direct one-sentence answer, get listed on the review/comparison sites in its " +
  "category, add data/stats its competitor has). Each: title = short imperative; detail = " +
  "one specific sentence grounded in THIS company's category and positioning. " +
  "These are hypotheses to TEST that correlate with getting cited — NOT guarantees: never " +
  "use 'will', 'guarantee', 'proven', or promise a result. " +
  "Be specific to the company's actual product. Do NOT invent pricing, integration counts, " +
  "or features you were not given. No prose, no markdown, JSON only.";

function userPrompt(input: AssetBriefInput): string {
  const proven = (input.provenLifts ?? [])
    .filter((p) => p.ci_low > 0)
    .map((p) => p.feature.replace(/_/g, " "));
  return [
    `Company: ${input.ownName} (${input.ownDomain})`,
    input.category ? `Category: ${input.category}` : "",
    input.icp ? `Sells to: ${input.icp}` : "",
    input.positioning ? `Positioning: ${input.positioning}` : "",
    input.whatYouAre ? `What they are: ${input.whatYouAre}` : "",
    `Top competitor (the company AI cites most for this company's buyer questions): ${input.competitorName}`,
    proven.length > 0
      ? `Already covered by measured data (do NOT re-suggest these; propose DIFFERENT changes): ${proven.join(", ")}`
      : "",
    "",
    "Write the comparison-page brief as JSON.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** First balanced top-level JSON object from a possibly chatty reply. */
function firstJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

function asCleanString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Generate the comparison-page brief. Fully defensive: empty output, non-JSON, or a
 * malformed object all yield null (the caller then keeps the generic fallback copy).
 */
export async function generateAssetBrief(
  chat: ChatModel,
  input: AssetBriefInput,
): Promise<AssetBrief | null> {
  const out = await chat.complete({
    system: SYSTEM_PROMPT,
    user: userPrompt(input),
  });
  if (!out || !out.trim()) return null;

  const json = firstJsonObject(out);
  if (!json) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const rec = parsed as {
    headline?: unknown;
    subhead?: unknown;
    points?: unknown;
    recommendations?: unknown;
  };
  const headline = asCleanString(rec.headline);
  const subhead = asCleanString(rec.subhead);
  const points = Array.isArray(rec.points)
    ? rec.points.map(asCleanString).filter(Boolean).slice(0, 3)
    : [];
  const llmRecs: AssetRecommendation[] = Array.isArray(rec.recommendations)
    ? rec.recommendations
        .map((r): AssetRecommendation | null => {
          if (!r || typeof r !== "object") return null;
          const rr = r as { title?: unknown; detail?: unknown };
          const title = asCleanString(rr.title);
          const detail = asCleanString(rr.detail);
          return title && detail
            ? { title, detail, kind: "hypothesis" as const }
            : null;
        })
        .filter((r): r is AssetRecommendation => r !== null)
    : [];

  if (!headline || !subhead) return null;

  // MEASURED recommendations (from the proprietary interventional dataset) lead;
  // LLM hypotheses fill the remaining slots. Cap the combined list at 4.
  const measured = buildMeasuredRecommendations(input.provenLifts ?? []);
  const recommendations = [...measured, ...llmRecs].slice(0, 4);

  return { headline, subhead, points, recommendations };
}
