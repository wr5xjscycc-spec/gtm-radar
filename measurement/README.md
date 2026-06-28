# measurement/ — Lane P2 (Measurement Engine)

The answer-engine layer: adapters for OpenAI (Responses API + `web_search`), Perplexity Sonar, and Gemini grounding; K-repeats → P(cited)+CI; adaptive sampling; citation parsing; case-control labeling; version stamping; drift detection; cost/budget guards.

- Brief: [`../docs/phase-cards/P2-Measurement-Engine.md`](../docs/phase-cards/P2-Measurement-Engine.md)
- Writes `measurement` records (see `../docs/CONTRACT.md`).
- Tests: `npm test` (vitest). **Mock engines in unit tests; recorded fixtures for integration; never live in CI.**
- Non-negotiable: use grounded engines (Responses API + web_search), never plain chat-completions.

## Layout

```
src/
  types.ts              # FROZEN shared types: Citation, EngineQueryResult, EngineResult, MeasurementRow
  contract-records.ts   # consumer projections of P1/P3 records P2 reads: QueryRecord, CandidatePage
  normalize.ts          # TEMP in-lane domain normalizer (see "P1 dependency" below)
  cost.ts               # OpenAI web_search cost/rate-limit model (P2·1; feeds P2·6 budget guards)
  engines/openai.ts     # OpenAI Responses API + web_search adapter + url_citation parser
  dispatch.ts           # query→engine dispatch harness (fans QueryRecord to adapters per target_engines)
  labeling.ts           # citation→page mapping + CASE-CONTROL labeling (losers come only from the pool)
  measurement.ts        # deriveEngineResult() + buildMeasurementRow() (contract-shaped rows)
scripts/
  p0-smoke.ts           # live "one engine, one citation" run (NOT in CI)
tests/
  normalize.test.ts  cost.test.ts  dispatch.test.ts  labeling.test.ts
  measurement.test.ts  engines/openai.test.ts
  fixtures/openai-responses-web_search.json   # a REAL captured Responses+web_search response
  fixtures/queries.json  fixtures/candidate-pool.json   # lane-local mirrors of P3/P1 contract shapes
```

## Commands

```
npm test --prefix measurement          # vitest (mocked/fixture-based, no keys, runs in CI)
npm run typecheck --prefix measurement # tsc --noEmit
npm run smoke --prefix measurement     # LIVE: fires one real query, captures a real citation
```

`smoke` reads `OPENAI_API_KEY` (and optional `OPENAI_MODEL`, default `gpt-4o`) from `gtm-radar/.env` (gitignored). It is **never** run in CI — it makes a paid, non-deterministic call. The adapter is fully covered by mocked unit tests replaying `tests/fixtures/openai-responses-web_search.json`.

## Phase 0 — "one engine, one citation" — DONE

What ships:
1. **OpenAI Responses API + `web_search` adapter** (`runOpenAIQuery`) — POSTs `{ model, input, tools:[{type:"web_search"}] }` to `/v1/responses`, injectable `fetch` for mocking. Confirmed (live) to return `url_citation` annotations under `output[].content[].annotations[]`; `model` is captured as the version stamp.
2. **Citation parser** (`parseResponsesCitations`) — flattens `url_citation` annotations, de-dups by raw url, ranks by first appearance, normalizes each url → domain. Raw url (incl. `utm_*`) preserved; only `domain` is normalized.
3. **Measurement row** (`deriveEngineResult` + `buildMeasurementRow`) — emits one `measurement` record in the frozen `docs/CONTRACT.md §5` shape (`{query_id, page_url, engine, model_version, run_idx, appeared, cited, position, source_urls[], ts, window_tag}`).

A live `npm run smoke` captured a real citation (e.g. top source at `position: 1`, `cited: true`, stamped `openai@gpt-4o-2024-08-06`).

### Assumptions noted (dependencies not yet built — per CONTRIBUTING.md)

- **P1·0 (`convex/`) is not built yet**, so there is no shared domain helper, no Convex schema, and no live board. Per the repo rules (stay in lane; code against the contract), this phase:
  - uses a **temporary in-lane `normalizeDomain`** (`src/normalize.ts`) that faithfully follows the `docs/CONTRACT.md` "Global rules" (lowercase, strip protocol/path/port, strip a leading `www.`). It is deliberately conservative (no arbitrary-subdomain stripping, no redirect resolution — both belong in P1's helper). **Replace every import of it with P1's helper when P1·0 lands** (marked `TODO(P1·0)`).
  - **emits the `measurement` row as a typed object** rather than persisting to Convex. Persisting + rendering on P1's board requires P1·0 + a Convex deployment.
- `query_id` in the smoke run is synthetic (`"p0-smoke-openai"`) — real `query` records are owned by P3.
- Retry/backoff and per-engine isolation are **out of scope for P0** (P2·6); the adapter throws on non-2xx by design.

## Phase 1 — engine accounts, limits & the contract — DONE (OpenAI-only)

Scoped to the OpenAI-only decision, so the multi-engine provisioning collapses into what P0 already proved:
- **Citation path confirmed** — OpenAI `url_citation` (verified live in P0). Perplexity/Gemini deferred.
- **Row contract frozen** — `src/types.ts` is the frozen `measurement` shape + common `{appeared, cited, position, sources[]}` adapter interface; an adapter-contract test (`tests/engines/openai.test.ts`) asserts OpenAI parses into it.
- **Cost/rate-limit posture** — `src/cost.ts` encodes the OpenAI web_search base rate ($10/1k calls), the ~2× hidden sub-search multiplier (≈$0.02/measured query), and `estimateOpenAIQueryCostUSD()`. This is what P2·6's budget caps will consume.

## Phase 2 — dispatch harness, citation parser & case-control labeling — DONE

- **Dispatch harness** (`src/dispatch.ts`) — `dispatchQuery(query, {apiKeys, registry, …})` fans a `QueryRecord` to its `target_engines` via an injectable engine registry (`DEFAULT_REGISTRY = { openai }`). Engines run concurrently with **per-engine isolation** (`Promise.allSettled`); outcomes partition into `results` / `skipped` (no adapter or no key) / `failures` (attempted, threw). Never throws on a per-engine failure.
- **Citation→page mapping** (`src/labeling.ts` `mapCitationsToPages`) — maps cited domains back to candidate pages (cited? at what position?), keyed on normalized domain.
- **Case-control labeling** (`src/labeling.ts` `labelCaseControl(citedDomains, candidatePool)`) — winners/losers are drawn **only** from the candidate pool: a loser is a pool page that wasn't cited, **never an arbitrary uncited page** (the selection-bias non-negotiable). A dedicated test asserts a page outside the pool is never labeled a loser.

### Assumptions noted (P2·2)
- The **candidate pool is an explicit parameter**, not assembled here — the query→pool mapping (retrieved/considered + classic-search rank) is **P3·3**'s job and isn't pinned in the contract yet. `tests/fixtures/{queries,candidate-pool}.json` are lane-local mirrors of P3/P1 contract shapes for development; swap in real P3 data when it lands.
- `src/contract-records.ts` holds minimal **read-only projections** of P1/P3's `query` / `page` records — not a contract change (no new fields).
