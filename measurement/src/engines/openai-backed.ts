// P2 (Measurement) — one-key three-engine backing.
//
// We have ONE OpenAI key but the pipeline is per-engine (cross-engine citation overlap is
// ~11% — engines must never be merged). To run the full 3-engine pipeline end-to-end before
// real Perplexity/Gemini keys arrive, we back the `perplexity` and `gemini` engine SLOTS with
// OpenAI models — a DIFFERENT model per slot, so the numbers genuinely diverge instead of being
// three copies of one engine's output.
//
// The real adapter `runOpenAIQuery` (engines/openai.ts) hardcodes `engine: "openai"` and
// already accepts a `model`. We DO NOT edit it — we wrap it here: bind the slot's model and
// OVERRIDE the engine label so per-engine separation works downstream. Crucially we keep
// `model_version` as the REAL OpenAI model the API returned (not the bound id), so the stand-in
// is self-evident in the stored data and drift detection stays honest.

import { runOpenAIQuery } from "./openai";
import type { EngineAdapter, EngineRegistry } from "../dispatch";
import type { Engine } from "../types";

/**
 * The OpenAI model bound to each engine slot. Distinct models on purpose: identical models would
 * make `perplexity` and `gemini` mere duplicates of `openai`, collapsing the per-engine signal.
 *
 * `perplexity` / `gemini` are STAND-INS until a real key for each arrives; when that happens the
 * only change is to register the real adapter — this constant and the wrapper go away.
 */
export const ENGINE_MODELS: Record<Engine, string> = {
  openai: "gpt-5",
  perplexity: "gpt-5-mini", // OpenAI-backed STAND-IN until a real Perplexity key arrives
  gemini: "gpt-5-nano", // OpenAI-backed STAND-IN until a real Gemini key arrives
};

/**
 * Build an EngineAdapter that runs the query through `runOpenAIQuery` with a BOUND model, then
 * OVERRIDES the engine label to `opts.engine`.
 *
 * What is and isn't overridden is the whole contract:
 *  - `engine`        → overridden to the slot (perplexity/gemini/openai) so per-engine grouping
 *                      keeps the slots separate.
 *  - `model_version` → LEFT as the real value `runOpenAIQuery` read off the API response. We do
 *                      NOT stamp `opts.model` over it: the genuine model id makes the stand-in
 *                      auditable in the data and keeps drift detection real.
 *
 * Everything else (citations, answer_text) flows through the SAME parser as the direct adapter,
 * unchanged. `apiKey` and `fetchImpl` are forwarded verbatim so tests inject a fake fetch and CI
 * never touches the network.
 */
export function makeOpenAIBackedAdapter(opts: { engine: Engine; model: string }): EngineAdapter {
  return async (params) => {
    const result = await runOpenAIQuery({
      query: params.query,
      apiKey: params.apiKey,
      model: opts.model, // bind the slot's model (caller's `params.model` is intentionally ignored)
      fetchImpl: params.fetchImpl,
    });

    // Spread first, then override ONLY the engine label — model_version et al. stay as returned.
    return { ...result, engine: opts.engine };
  };
}

/**
 * Wire all three engine slots to OpenAI-backed adapters using {@link ENGINE_MODELS}. The returned
 * registry is a drop-in for dispatch/adaptive: every slot is present and callable, each stamping
 * its own engine label while sharing one OpenAI key.
 */
export function buildOpenAIBackedRegistry(): EngineRegistry {
  return {
    openai: makeOpenAIBackedAdapter({ engine: "openai", model: ENGINE_MODELS.openai }),
    perplexity: makeOpenAIBackedAdapter({ engine: "perplexity", model: ENGINE_MODELS.perplexity }),
    gemini: makeOpenAIBackedAdapter({ engine: "gemini", model: ENGINE_MODELS.gemini }),
  };
}

/**
 * Spread one OpenAI key across all three engine slots, shaped for dispatch/adaptive `apiKeys`.
 * Since every slot is OpenAI-backed, the same key authenticates all of them.
 */
export function spreadOpenAIKey(key: string): Partial<Record<Engine, string>> {
  return { openai: key, perplexity: key, gemini: key };
}
