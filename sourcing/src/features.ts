// Subjective content-feature extraction (P3 · Phase 2, task #4 — subjective family).
//
// The GEO-paper tactics (direct-answer-first, stats/citation/quote density,
// listicle-vs-prose) are SUBJECTIVE and measurement-error-laden, so they live
// behind the same gpt-4o-mini PORT (`ChatModel`, defined in understanding.ts)
// the rest of the lane uses — unit tests inject a mock and CI never makes a live
// vendor call. This module imports no SDK and touches no network.
//
// Discipline: keep the prompt CHEAP (cap the text we feed), demand STRICT JSON,
// parse it tolerantly (code fences / leading prose), and FAIL LOUD on output we
// can't validate — a hollow subjective vector is worse than an absent one (the
// deterministic family still stands without it; see types.ts ContentFeatures).

import type { ChatModel } from "./understanding";
import type { ListicleVsProse, SubjectiveContentFeatures } from "./types";

/** Stable version tag stamped into `page.extractor_version`. */
export const CONTENT_EXTRACTOR_VERSION = "content-features@v1";

/** Keep the prompt cheap: cap how much page text we feed gpt-4o-mini. */
const MAX_TEXT_CHARS = 4000;

const SYSTEM_PROMPT =
  "You are a precise content analyst. Read the page text and return STRICT JSON " +
  "only (no prose, no code fences) with EXACTLY these keys: " +
  '"direct_answer_first" (boolean: does the page answer the implied question in its ' +
  'first paragraph?), "stats_density" (number: statistics/numbers per 1000 words), ' +
  '"citation_density" (number: outbound citations/references per 1000 words), ' +
  '"quote_density" (number: direct quotations per 1000 words), "listicle_vs_prose" ' +
  '(one of "listicle", "prose", "mixed"). Numbers may be decimals. Be terse.';

function buildUserPrompt(input: { url: string; text: string }): string {
  const text = (input.text ?? "").trim().slice(0, MAX_TEXT_CHARS);
  return `URL: ${input.url}\nPage text:\n${text}`;
}

/** First `{`..last `}` — tolerate code fences / leading-trailing prose. */
function extractJsonBlock(raw: string): string | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return raw.slice(start, end + 1);
}

function asFiniteNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  // gpt-4o-mini sometimes returns numeric strings; accept those, reject the rest.
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

const VALID_LISTICLE: ReadonlySet<string> = new Set<ListicleVsProse>([
  "listicle",
  "prose",
  "mixed",
]);

/**
 * Extract the subjective `content_features` via gpt-4o-mini (through the port).
 * Validates every field's type; throws loud on unparseable / wrong-typed output
 * so a bad model reply surfaces instead of silently writing a hollow vector.
 */
export async function extractSubjectiveFeatures(
  model: ChatModel,
  input: { url: string; text: string },
): Promise<SubjectiveContentFeatures> {
  const raw = await model.complete({ system: SYSTEM_PROMPT, user: buildUserPrompt(input) });
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("extractSubjectiveFeatures: model returned empty output");
  }

  const block = extractJsonBlock(raw);
  if (block === null) {
    throw new Error(
      `extractSubjectiveFeatures: no JSON object found in model output: ${raw.slice(0, 120)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch {
    throw new Error(
      `extractSubjectiveFeatures: model output was not valid JSON: ${block.slice(0, 120)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("extractSubjectiveFeatures: parsed JSON was not an object");
  }
  const obj = parsed as Record<string, unknown>;

  if (typeof obj.direct_answer_first !== "boolean") {
    throw new Error("extractSubjectiveFeatures: direct_answer_first must be a boolean");
  }
  const stats = asFiniteNumber(obj.stats_density);
  const citation = asFiniteNumber(obj.citation_density);
  const quote = asFiniteNumber(obj.quote_density);
  if (stats === null || citation === null || quote === null) {
    throw new Error(
      "extractSubjectiveFeatures: stats_density/citation_density/quote_density must be finite numbers",
    );
  }
  if (typeof obj.listicle_vs_prose !== "string" || !VALID_LISTICLE.has(obj.listicle_vs_prose)) {
    throw new Error(
      'extractSubjectiveFeatures: listicle_vs_prose must be "listicle" | "prose" | "mixed"',
    );
  }

  return {
    direct_answer_first: obj.direct_answer_first,
    stats_density: stats,
    citation_density: citation,
    quote_density: quote,
    listicle_vs_prose: obj.listicle_vs_prose as ListicleVsProse,
  };
}
