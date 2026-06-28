// Concrete ChatModel adapter — OpenAI gpt-5-mini via PURE fetch (Card B, task #2).
//
// The lane reaches the LLM through the `ChatModel` PORT (defined in
// understanding.ts: `complete({system, user}) -> Promise<string>`). The understanding
// pass (understanding.ts) and the subjective content-feature pass (features.ts) both
// consume that port; this module is the real, app-edge implementation that backs it
// with OpenAI's Chat Completions API.
//
// Design rules:
//  - PURE fetch (no SDK) so it runs anywhere (Node edge runner OR a default V8
//    Convex action — no `"use node"` needed). `fetch` is injectable so unit tests
//    pass a fake and CI NEVER makes a live vendor call (docs/TESTING.md rule 1).
//  - The API key is read from an injected `apiKey` or `process.env.OPENAI_API_KEY`;
//    it is only ever sent in the Authorization header (never logged, never returned).
//  - Returns the model's raw text. Parsing (strict-JSON extraction / validation) is
//    the consumer's job (extractUnderstanding / extractSubjectiveFeatures) — this
//    adapter stays a dumb transport so those validators remain the single source of
//    shape truth.

import type { ChatModel } from "./understanding";

/** Default model for the cheap understanding / subjective-feature passes. */
export const DEFAULT_CHAT_MODEL = "gpt-5-mini";

/** OpenAI Chat Completions base URL (overridable for tests / proxies). */
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export interface CreateChatOpenAIOpts {
  /** API key. Falls back to `process.env.OPENAI_API_KEY` when omitted. */
  apiKey?: string;
  /** Model id (default `gpt-5-mini`). */
  model?: string;
  /** API base URL (default `https://api.openai.com/v1`). */
  baseUrl?: string;
  /**
   * INJECTED fetch. Defaults to the global `fetch` (Node 20+ / V8). Tests pass a
   * fake that returns a canned OpenAI response — this is what keeps CI offline.
   */
  fetchImpl?: typeof fetch;
  /**
   * Optional sampling temperature. OMITTED by default: gpt-5-mini only supports the
   * default temperature, so we don't send the field unless a caller explicitly asks
   * (e.g. for a model that does accept it).
   */
  temperature?: number;
  /** Optional cap on completion tokens (sent as `max_completion_tokens`). */
  maxCompletionTokens?: number;
  /** Optional per-request timeout (ms) — guards a hung action from burning. */
  timeoutMs?: number;
}

/** Minimal shape we read out of an OpenAI Chat Completions response. */
interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
}

/**
 * Build a concrete {@link ChatModel} backed by OpenAI gpt-5-mini.
 *
 * The returned object satisfies the `ChatModel` port, so it drops straight into
 * `extractUnderstanding` (understanding.ts) and `extractSubjectiveFeatures`
 * (features.ts). It performs ONE `fetch` POST to `/chat/completions`, asserts a 2xx,
 * and returns `choices[0].message.content`. Fails loud on a missing key, a non-2xx
 * response, or an empty completion so a bad call surfaces instead of silently
 * feeding the validators an empty string.
 */
export function createChatOpenAI(opts: CreateChatOpenAIOpts = {}): ChatModel {
  const model = opts.model ?? DEFAULT_CHAT_MODEL;
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  return {
    async complete({ system, user }): Promise<string> {
      // Resolve the key lazily (env may be set after construction in scripts).
      const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error(
          "createChatOpenAI: no API key — pass { apiKey } or set OPENAI_API_KEY",
        );
      }
      if (typeof fetchImpl !== "function") {
        throw new Error("createChatOpenAI: no fetch available (pass { fetchImpl })");
      }

      const body = {
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.maxCompletionTokens !== undefined
          ? { max_completion_tokens: opts.maxCompletionTokens }
          : {}),
      };

      const res = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        ...(opts.timeoutMs !== undefined
          ? { signal: AbortSignal.timeout(opts.timeoutMs) }
          : {}),
      });

      if (!res.ok) {
        let detail = "";
        try {
          detail = await res.text();
        } catch {
          /* ignore — the status alone is enough to fail loud */
        }
        throw new Error(
          `createChatOpenAI: OpenAI /chat/completions ${res.status}: ${detail.slice(0, 200)}`,
        );
      }

      const json = (await res.json()) as ChatCompletionResponse;
      const content = json?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.trim() === "") {
        throw new Error("createChatOpenAI: OpenAI returned an empty completion");
      }
      return content;
    },
  };
}
