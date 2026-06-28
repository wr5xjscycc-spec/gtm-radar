// Company-understanding pass (P3 · Phase 1, task #2).
//
// Goal: a CHEAP "what you are" pass over the already-scraped site text. gpt-4o-mini
// reads the site and returns a tight JSON object — understanding{category, icp,
// positioning} plus a 4-line "what you are" card for the demo. This is explicitly
// NOT a big report: the prompt is kept small (token budget matters) and the output
// is strict JSON we can parse and stamp onto the `company` record.
//
// Lane discipline (mirrors fiber.ts): the LLM is reached through a PORT
// (`ChatModel`) so unit tests inject a mock and CI never makes a live vendor call.
// The real gpt-4o-mini-backed client is a thin wrapper supplied at the app edge
// (P1 wiring); this module imports no SDK and touches no network.

import type { Company, Understanding } from "./types";
import { toggleFlag } from "./battlefield";

/**
 * The chat-model port. The real implementation calls OpenAI gpt-4o-mini and
 * returns the model's text; tests pass a mock returning a recorded string.
 * Keeping this an interface is what keeps tests deterministic and free.
 */
export interface ChatModel {
  complete(args: { system: string; user: string }): Promise<string>;
}

/** Stable version tag stamped into `company.source_versions.understanding`. */
export const UNDERSTANDING_MODEL_VERSION = "gpt-5-mini/understanding@v1";

/** Inputs to the understanding pass: the scraped site plus identity hints. */
export interface UnderstandingInput {
  /** Normalized company domain (identity / context for the model). */
  domain: string;
  /** Company name, if known. */
  name?: string;
  /** Scraped site text (already fetched upstream — we do NOT scrape here). */
  siteText: string;
}

/** What the pass returns: the contract `understanding` + the demo card text. */
export interface UnderstandingResult {
  understanding: Understanding;
  /** Exactly 4 short newline-separated lines for the demo "what you are" card. NOT a contract field. */
  whatYouAre: string;
}

/** Keep the prompt cheap: cap how much site text we feed gpt-4o-mini. */
const MAX_SITE_TEXT_CHARS = 1200;

const SYSTEM_PROMPT =
  "You are a concise B2B analyst. Read the company's website text and return STRICT " +
  "JSON only (no prose, no code fences) with exactly these keys: " +
  '"category" (one short phrase), "icp" (one short phrase: who they sell to), ' +
  '"positioning" (one short sentence), "whatYouAre" (exactly 4 short lines, ' +
  "newline-separated, for a 'what you are' card). Be terse.";

/** Build the small, tight user prompt. Deliberately short — this is not a report. */
function buildUserPrompt(input: UnderstandingInput): string {
  const site = (input.siteText ?? "").trim().slice(0, MAX_SITE_TEXT_CHARS);
  const id = input.name ? `${input.name} (${input.domain})` : input.domain;
  return `Company: ${id}\nSite text:\n${site}`;
}

/**
 * Pull the first balanced-looking JSON object out of a model reply, tolerating
 * code fences and leading/trailing prose. Returns the substring or null.
 */
function extractJsonBlock(raw: string): string | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return raw.slice(start, end + 1);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Coerce the model's card text into exactly 4 non-empty lines for the demo card.
 *
 * The 4-line card is a cosmetic demo artifact, NOT a contract field — so a model
 * that returns 3 or 5 lines (gpt-4o-mini routinely does) must NOT cause us to
 * discard the validated, contract-critical `understanding`. We degrade instead:
 * keep the model's lines when present, then top up from the understanding we
 * already have (identity, category, icp, positioning), and truncate to 4.
 */
function toFourLineCard(
  rawCard: unknown,
  understanding: Understanding,
  input: UnderstandingInput,
): string {
  const modelLines =
    typeof rawCard === "string"
      ? rawCard.split("\n").map((l) => l.trim()).filter((l) => l.length > 0)
      : [];

  const id = input.name ? `${input.name} (${input.domain})` : input.domain;
  const fallback = [id, understanding.category, understanding.icp, understanding.positioning]
    .map((s) => (s ?? "").trim())
    .filter((s) => s.length > 0);

  const lines = [...modelLines];
  for (const f of fallback) {
    if (lines.length >= 4) break;
    if (!lines.includes(f)) lines.push(f);
  }
  return lines.slice(0, 4).join("\n");
}

/**
 * Run the cheap understanding pass: prompt gpt-4o-mini (via the port) over the
 * scraped site, parse its strict-JSON reply, and return the contract
 * `understanding{category, icp, positioning}` plus the 4-line card text.
 *
 * Fails loud: throws if the reply can't be parsed into the required shape, so a
 * bad/empty model output surfaces instead of silently writing a hollow record.
 */
export async function extractUnderstanding(
  model: ChatModel,
  input: UnderstandingInput,
): Promise<UnderstandingResult> {
  const system = SYSTEM_PROMPT;
  const user = buildUserPrompt(input);

  const raw = await model.complete({ system, user });
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("extractUnderstanding: model returned empty output");
  }

  const block = extractJsonBlock(raw);
  if (block === null) {
    throw new Error(`extractUnderstanding: no JSON object found in model output: ${raw.slice(0, 120)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch {
    throw new Error(`extractUnderstanding: model output was not valid JSON: ${block.slice(0, 120)}`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("extractUnderstanding: parsed JSON was not an object");
  }
  const obj = parsed as Record<string, unknown>;

  // The contract-critical fields fail loud — a hollow understanding record is worse
  // than none (it would silently feed the model empty context).
  if (!isNonEmptyString(obj.category) || !isNonEmptyString(obj.icp) || !isNonEmptyString(obj.positioning)) {
    throw new Error(
      "extractUnderstanding: missing required field(s) category/icp/positioning in model output",
    );
  }

  const understanding: Understanding = {
    category: obj.category.trim(),
    icp: obj.icp.trim(),
    positioning: obj.positioning.trim(),
  };

  // The 4-line card is cosmetic (not a contract field): degrade gracefully rather
  // than throw away the validated understanding when the model miscounts lines.
  return {
    understanding,
    whatYouAre: toFourLineCard(obj.whatYouAre, understanding, input),
  };
}

/**
 * Stamp an understanding result onto a `company` record: sets `understanding`,
 * flips `coverage_flags.understanding_missing` to false, and records the model
 * version in `source_versions.understanding`. Returns a COPY — never mutates the
 * input (callers may hold the original). The 4-line card text is NOT stored here:
 * it's a demo-render artifact returned by extractUnderstanding, not a contract field.
 */
export function applyUnderstanding(company: Company, result: UnderstandingResult): Company {
  return {
    ...company,
    understanding: { ...result.understanding },
    coverage_flags: toggleFlag(company.coverage_flags, "understanding_missing", false),
    source_versions: {
      ...company.source_versions,
      understanding: UNDERSTANDING_MODEL_VERSION,
    },
  };
}
