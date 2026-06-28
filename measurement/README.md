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
  normalize.ts          # TEMP in-lane domain normalizer (see "P1 dependency" below)
  engines/openai.ts     # OpenAI Responses API + web_search adapter + url_citation parser
  measurement.ts        # deriveEngineResult() + buildMeasurementRow() (contract-shaped rows)
scripts/
  p0-smoke.ts           # live "one engine, one citation" run (NOT in CI)
tests/
  normalize.test.ts
  measurement.test.ts
  engines/openai.test.ts
  fixtures/openai-responses-web_search.json   # a REAL captured Responses+web_search response
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
