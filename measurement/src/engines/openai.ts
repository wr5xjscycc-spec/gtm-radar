// P2 (Measurement) — OpenAI Responses API + `web_search` engine adapter.
//
// Captures one grounded answer-engine query and parses it into the engine-agnostic
// EngineQueryResult shape (see types.ts). The `web_search` tool returns its sources as
// `url_citation` annotations on the message's `output_text`; we flatten, de-duplicate, and
// rank them. Rank is load-bearing downstream (#1 ≫ #3 — clicks concentrate on the first),
// so we preserve first-appearance order exactly.
//
// HTTP is injected via `fetchImpl` so tests can mock it — this module never imports a real
// HTTP client and never calls the network on its own.

import { normalizeDomain } from "../normalize";
import type { Citation, EngineQueryResult } from "../types";

const RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";
// 5th-gen default. gpt-5-mini is the sweet spot for measurement-sweep volume: it
// works with the web_search tool and was the fastest tier measured live (~31s/query
// vs ~83s nano, ~113s gpt-5) at equal citation coverage (11 sources). gpt-5 / gpt-5.5
// give higher fidelity but are far slower; callers override per query via params.model.
const DEFAULT_MODEL = "gpt-5-mini";
/** Cap the error-body snippet so a huge HTML error page can't blow up the thrown message. */
const ERROR_SNIPPET_LIMIT = 500;

/** Narrow `unknown` to a plain object so we can safely read string-keyed properties. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Walk a Responses payload, yielding each `output_text` content block from every `message`
 * item. Defensive throughout: anything missing or mis-shaped is skipped, never thrown on.
 */
function* outputTextBlocks(response: unknown): Generator<Record<string, unknown>> {
  if (!isRecord(response)) return;
  const output = response.output;
  if (!Array.isArray(output)) return;

  for (const item of output) {
    if (!isRecord(item) || item.type !== "message") continue;
    const content = item.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!isRecord(block) || block.type !== "output_text") continue;
      yield block;
    }
  }
}

/**
 * Parse the `url_citation` annotations from an OpenAI Responses payload into ranked Citations.
 *
 * Order = first appearance across all `output_text` blocks. De-duplicated by RAW url (first
 * occurrence wins); `rank` then numbers the de-duplicated list 1, 2, 3, … with no gaps. The
 * raw url is preserved verbatim (query strings, `utm_*`, etc.); only `domain` is normalized.
 *
 * Fully defensive: a missing `output`/`content`/`annotations`, a non-`url_citation`
 * annotation, or an annotation without a usable `url` is silently skipped.
 */
export function parseResponsesCitations(response: unknown): Citation[] {
  const citations: Citation[] = [];
  const seenUrls = new Set<string>();

  for (const block of outputTextBlocks(response)) {
    const annotations = block.annotations;
    if (!Array.isArray(annotations)) continue;

    for (const annotation of annotations) {
      if (!isRecord(annotation) || annotation.type !== "url_citation") continue;

      const url = annotation.url;
      if (typeof url !== "string" || url.length === 0) continue;
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);

      const citation: Citation = {
        url,
        domain: normalizeDomain(url),
        rank: citations.length + 1,
      };

      const title = annotation.title;
      if (typeof title === "string" && title.length > 0) citation.title = title;

      citations.push(citation);
    }
  }

  return citations;
}

/**
 * Concatenate the text of every `output_text` block in a Responses payload — the answer the
 * model surfaced to the user. Used downstream for `appeared` (mention) detection.
 */
function extractAnswerText(response: unknown): string {
  let text = "";
  for (const block of outputTextBlocks(response)) {
    if (typeof block.text === "string") text += block.text;
  }
  return text;
}

/**
 * Run ONE grounded query against the OpenAI Responses API with the `web_search` tool and
 * return the parsed, engine-agnostic result.
 *
 * @param params.query     The user query (sent as `input`).
 * @param params.apiKey    OpenAI API key (sent as a Bearer token).
 * @param params.model     Model id; defaults to "gpt-4o".
 * @param params.fetchImpl Injectable fetch (defaults to the global `fetch`) — mock it in tests.
 * @throws on any non-2xx response, with an Error carrying the status and a short body snippet.
 */
export async function runOpenAIQuery(params: {
  query: string;
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
  /** Depth of the web_search retrieval. "high" surfaces more sources (more citations)
   *  at modestly higher latency; omit for the API default (medium). */
  searchContextSize?: "low" | "medium" | "high";
}): Promise<EngineQueryResult> {
  const doFetch = params.fetchImpl ?? fetch;

  const webSearch = params.searchContextSize
    ? { type: "web_search", search_context_size: params.searchContextSize }
    : { type: "web_search" };
  const body = JSON.stringify({
    model: params.model ?? DEFAULT_MODEL,
    input: params.query,
    tools: [webSearch],
  });

  const response = await doFetch(RESPONSES_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
    },
    body,
  });

  if (!response.ok) {
    let snippet = "";
    try {
      snippet = (await response.text()).slice(0, ERROR_SNIPPET_LIMIT);
    } catch {
      snippet = "<unreadable response body>";
    }
    throw new Error(`OpenAI Responses API error ${response.status}: ${snippet}`);
  }

  const json: unknown = await response.json();
  const modelVersion =
    isRecord(json) && typeof json.model === "string" ? json.model : "";

  return {
    engine: "openai",
    model_version: modelVersion,
    answer_text: extractAnswerText(json),
    citations: parseResponsesCitations(json),
  };
}
