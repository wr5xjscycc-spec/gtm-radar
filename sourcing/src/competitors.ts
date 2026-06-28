// Real competitor identification (owner: P3).
//
// Fiber's `find-similar-companies` ranks by FIRMOGRAPHIC similarity (same industry
// tag + employee-size band), so a small dev-tools startup gets matched with other
// small startups in restaurants/crypto/hotels — "similar company" is not
// "competitor". This pass asks the chat model for the company's ACTUAL direct
// competitors (the ones a buyer would genuinely evaluate as alternatives), grounded
// in the understanding we already extracted from the site. Anti-hallucination is
// load-bearing: the prompt says "omit if unsure — fewer is better than wrong", and
// the caller falls back to Fiber discovery only when this names nothing.
//
// Pure + injectable (same ChatModel port as understanding.ts), so tests stay
// deterministic and free; the Convex action wires the real OpenAI client.

import type { ChatModel } from "./understanding";

/** Stable version tag (stamped by the caller into source_versions when desired). */
export const COMPETITORS_MODEL_VERSION = "gpt-5-mini/competitors@v1";

export interface CompetitorInput {
  /** Normalized customer domain (identity / self-exclusion). */
  domain: string;
  /** Customer name, if known. */
  name?: string;
  /** Category from the understanding pass (e.g. "serverless reactive database"). */
  category?: string;
  /** A short description of what the company does (positioning + card text). */
  description: string;
}

export interface DiscoveredCompetitor {
  name: string;
  domain: string;
}

export interface CompetitorsResult {
  competitors: DiscoveredCompetitor[];
}

const SYSTEM_PROMPT =
  "You are a B2B market analyst. Given a company, return its REAL direct competitors: " +
  "companies a buyer in the same category would genuinely evaluate as alternatives. " +
  'Reply with STRICT JSON ONLY: {"competitors":[{"name":string,"domain":string}]}. ' +
  "Rules: only well-known, real companies you are confident exist; use each company's " +
  'PRIMARY website domain (e.g. "supabase.com", "firebase.google.com"), lowercase, no ' +
  "paths or http; 4 to 8 competitors; never include the company itself; if you are not " +
  "confident a company is a real direct competitor, OMIT it (fewer is better than wrong). " +
  "No prose, no markdown, JSON only.";

function userPrompt(input: CompetitorInput): string {
  const id = input.name ? `${input.name} (${input.domain})` : input.domain;
  return [
    `Company: ${id}`,
    input.category ? `Category: ${input.category}` : "",
    `What they do: ${input.description}`,
    "",
    "Return their direct competitors as JSON.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Slice out the first balanced top-level JSON object from a possibly chatty reply. */
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

/** Normalize a model-supplied domain to a bare registrable host (best-effort). */
function cleanDomain(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .replace(/\s+/g, "");
}

/**
 * Ask the chat model for the company's direct competitors. Fully defensive: empty
 * output, non-JSON, or a malformed array all yield an empty list (the caller then
 * falls back to Fiber discovery). De-duplicates by domain and caps at 8.
 */
export async function extractCompetitors(
  chat: ChatModel,
  input: CompetitorInput,
): Promise<CompetitorsResult> {
  const out = await chat.complete({
    system: SYSTEM_PROMPT,
    user: userPrompt(input),
  });
  if (!out || !out.trim()) return { competitors: [] };

  const json = firstJsonObject(out);
  if (!json) return { competitors: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { competitors: [] };
  }

  const arr =
    parsed && typeof parsed === "object" && Array.isArray((parsed as { competitors?: unknown }).competitors)
      ? ((parsed as { competitors: unknown[] }).competitors)
      : [];

  const self = cleanDomain(input.domain);
  const seen = new Set<string>();
  const competitors: DiscoveredCompetitor[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as { name?: unknown; domain?: unknown };
    const domain = cleanDomain(rec.domain);
    if (!domain || domain === self || seen.has(domain)) continue;
    if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(domain)) continue;
    seen.add(domain);
    const name = typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : domain;
    competitors.push({ name, domain });
    if (competitors.length >= 8) break;
  }
  return { competitors };
}
