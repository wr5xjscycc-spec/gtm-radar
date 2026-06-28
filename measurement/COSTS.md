# Engine costs, rate limits & gotchas

> Phase-1 documentation to guard Phase-6 cost/budget design. All numbers are
> approximate and should be re-validated before any budget cap is set.

---

## OpenAI — Responses API (`web_search`)

| Item | Value |
|---|---|
| API endpoint | `POST https://api.openai.com/v1/responses` |
| Model | `gpt-4o` |
| Cost per 1k calls (base) | ~$10 |
| Web-search sub-search multiplier | ~2–3× (each call triggers sub-searches) |
| Tokens per call (avg) | ~45 in / ~340 out |
| Effective cost per call (est.) | ~$0.025–0.035 |
| Rate limit | Tier-dependent; T1 ~5k RPM |
| Key needed | `OPENAI_API_KEY` (set in `.env`) |

**Where citations vanish:**
- JSON structured-output mode (`response_format: { type: "json_object" }`) strips `url_citation` annotations.
- System-prompt guidelines that say "do not cite" suppress them.
- Short or vague queries may return zero citations (the model did not need to ground).

**Recommendation:** omit `response_format` entirely; inject a system instruction like
*"Cite your sources inline using bracketed numbers matching the source list."*

---

## Perplexity — Sonar / Sonar Pro

| Item | Value |
|---|---|
| API endpoint | `POST https://api.perplexity.ai/chat/completions` |
| Model | `sonar` (Sonar Pro: `sonar-pro`) |
| Cost per 1M input tokens | $3 (Sonar) / $15 (Sonar Pro) |
| Cost per 1M output tokens | $15 (Sonar) / $60 (Sonar Pro) |
| Cost per 1k requests | ~$6–14 (varies with output length) |
| Effective cost per call (est.) | ~$0.006–0.014 |
| Rate limit | Tier-dependent; T1 ~400 RPM (Sonar) |
| Key needed | `PERPLEXITY_API_KEY` **(not set — needs provisioning)** |

**Citation path:** `response.citations` — a top-level array of URL strings. No
per-annotation index/cursor; the URLs are ordered to match the response text.

**Where citations vanish:**
- `stream: true` does not return `citations` in every chunk (only the final).
- Prompt phrasing that does not request sources may return an empty array.
- Very short answers (<1 sentence) often lack citations.

---

## Gemini — Grounded (`googleSearch`)

| Item | Value |
|---|---|
| API endpoint | `POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent` |
| Model | `gemini-2.0-flash` |
| Free tier | 15 RPM, 1M tokens/min (generous for dev/testing) |
| Paid tier cost per call (est.) | ~$0.005–0.019 |
| Rate limit (free) | 15 RPM; paid tiers scale |
| Key needed | `GEMINI_API_KEY` **(not set — needs provisioning)** |

**Citation path:** `candidates[0].groundingMetadata.groundingChunks[].web.uri` —
the URI field on each chunk's `web` or `retrievedContext` object.

**Where citations vanish:**
- The `googleSearch` tool must be present in the request `tools` array.
- If the answer is entirely within the model's training data (no search needed),
  `groundingMetadata` may be absent.
- The free tier's search quality can be noticeably worse than paid.

---

## Comparison summary

| Engine | Citation source | Cost/call (est.) | Key status |
|---|---|---|---|
| OpenAI Responses + web_search | `output[].content[].annotations[].url_citation` | ~$0.025–0.035 | ✅ Set |
| Perplexity Sonar | `citations[]` (top-level array) | ~$0.006–0.014 | ❌ Needs key |
| Gemini 2.0 Flash grounded | `groundingMetadata.groundingChunks[].web.uri` | ~$0.005–0.019 | ❌ Needs key |

**Budget projection (Phase 3 — 3 engines × K=3 × 400 queries):**

| | OpenAI | Perplexity | Gemini | Total |
|---|---|---|---|---|
| Per call | $0.030 | $0.010 | $0.012 | — |
| 3 engines × 3 repeats × 400 queries (3,600 calls) | $108 | $36 | $43 | **~$187** |

Cost can be halved via adaptive sampling (~−40–50%), landing at **~$94–112/cycle**.
K=3 baseline is ~$187; adaptive sampling brings it to target range.
