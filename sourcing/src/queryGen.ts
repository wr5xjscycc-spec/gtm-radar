// LLM buyer-query generation (owner: P2/P3 seam).
//
// The old seed queries were rigid B2B-SaaS templates ("best <category> tools 2026",
// "<category> vendors for B2B teams"). They produce nonsense for any company whose
// category isn't a clean SaaS noun — e.g. for Apple ("consumer electronics &
// software") you get "best consumer electronics & software tools for B2B teams",
// which no real buyer asks, so the company is never cited. This pass asks the chat
// model for NATURAL questions real buyers type into AI assistants for the company's
// actual category, mixing category-discovery, comparison, and use-case shapes.
//
// Pure + injectable (same ChatModel port as understanding.ts), so tests stay
// deterministic and free; the Convex action wires the real OpenAI client.

import type { ChatModel } from "./understanding";

export const QUERY_GEN_MODEL_VERSION = "gpt-5-mini/query-gen@v1";

export interface QueryGenInput {
  ownName: string;
  category?: string;
  icp?: string;
  positioning?: string;
  /** A competitor domain/name, for "X vs Y" comparison questions. */
  competitorName?: string;
  /** How many queries to produce. */
  n: number;
}

const SYSTEM_PROMPT =
  "You generate the real questions buyers type into AI assistants (ChatGPT, " +
  "Perplexity, Gemini) when researching or comparing products, so we can measure " +
  "whether a company gets cited. Reply with STRICT JSON ONLY: {\"queries\":[string]}. " +
  "Produce exactly N short, natural questions a real buyer would ask — questions where " +
  "a vendor in this category could plausibly be cited as a source. Use a MIX of shapes: " +
  "(1) category discovery ('best <real category words> for <use/audience>', 'top <category> " +
  "2026'), (2) direct comparison ('<company> vs <competitor>', '<competitor> alternatives'), " +
  "(3) specific buying / use-case questions the target customer would actually ask. " +
  "Use the REAL words buyers use for this category, NOT the literal category label " +
  "(e.g. for 'consumer electronics' write 'best smartphone', 'best laptop for students', " +
  "not 'best consumer electronics tools'). Lowercase, no surrounding quotes, no numbering. " +
  "Do NOT output generic 'best software tools' filler. No prose, no markdown, JSON only.";

function userPrompt(input: QueryGenInput): string {
  return [
    `Company: ${input.ownName}`,
    input.category ? `Category: ${input.category}` : "",
    input.icp ? `Sells to: ${input.icp}` : "",
    input.positioning ? `What they do: ${input.positioning}` : "",
    input.competitorName ? `A competitor: ${input.competitorName}` : "",
    `N = ${input.n}`,
    "",
    "Return the buyer questions as JSON.",
  ]
    .filter(Boolean)
    .join("\n");
}

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

function clean(q: unknown): string {
  return typeof q === "string"
    ? q
        .trim()
        .replace(/^["'\d.\-)\s]+/, "") // strip leading numbering / quotes
        .replace(/["']+$/, "")
        .trim()
        .toLowerCase()
    : "";
}

/**
 * Generate natural buyer queries. Fully defensive: empty output, non-JSON, or a
 * malformed array all yield [] (the caller then falls back to the templates).
 * De-duplicates and caps at n.
 */
export async function generateBuyerQueries(
  chat: ChatModel,
  input: QueryGenInput,
): Promise<string[]> {
  const out = await chat.complete({
    system: SYSTEM_PROMPT,
    user: userPrompt(input),
  });
  if (!out || !out.trim()) return [];

  const json = firstJsonObject(out);
  if (!json) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const arr =
    parsed && typeof parsed === "object" && Array.isArray((parsed as { queries?: unknown }).queries)
      ? (parsed as { queries: unknown[] }).queries
      : [];

  const seen = new Set<string>();
  const queries: string[] = [];
  for (const raw of arr) {
    const q = clean(raw);
    if (q.length < 5 || seen.has(q)) continue;
    seen.add(q);
    queries.push(q);
    if (queries.length >= input.n) break;
  }
  return queries;
}
