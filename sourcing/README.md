# sourcing/ — Lane P3 (Sourcing & Enrichment)

The data supply: battlefield builder (Fiber `find-similar-companies`), company-understanding, firmographics, Orange Slice content scrape, **off-page/entity enrichment** (third-party mentions, Reddit/G2/Wikipedia/review presence, brand search, backlinks), query seeding + generation, feature extraction, category caching, the launch vertical pack.

- Brief: [`../docs/phase-cards/P3-Sourcing-and-Enrichment.md`](../docs/phase-cards/P3-Sourcing-and-Enrichment.md)
- Writes `company`, `page`, `query` records (see `../docs/CONTRACT.md`).
- Tests: `npm test` (vitest). Mock vendors; fixtures for integration.
- Non-negotiable: off-page/earned/entity signals dominate AI citation — supply BOTH families, not just on-page.

## Phase status

**Phase 0 — One battlefield ✅** (`p3/phase-0-battlefield`)
Proves company sourcing through Fiber: `find-similar-companies` → normalized, deduped `company` records (`role=battlefield`).

- `src/domain.ts` — `normalizeDomain()` **lane-local placeholder** for P1's shared helper (deterministic subset: scheme/www/path/port/case). ASSUMPTION: swap to P1's helper once P1·0 ships suffix-aware subdomain stripping + redirect resolution.
- `src/types.ts` — the `company` record shape (TS form of `docs/CONTRACT.md` #2).
- `src/fiber.ts` — `FiberClient` **port** (real impl calls the Fiber MCP tool; tests inject a mock) + response parsing.
- `src/battlefield.ts` — `buildBattlefield()` + `CompanyWriter` port (real impl = P1's Convex `company` upsert; tests use in-memory). Normalizes keys, drops the echoed seed, dedupes apex/www, flags missing enrichment in `coverage_flags`.
- Tests: `tests/domain.test.ts`, `tests/fiber.smoke.test.ts` (vendor mocked via `tests/fixtures/fiber-find-similar.json`).

**Phase 1 — Full battlefield, understanding & firmographics ✅** (`p3/phase-1-company-layer`)
The complete company layer: who's in the category, what the customer is, and the small context-feature family.

- `src/battlefield.ts` — `buildCompanyLayer()` + `roleFor()`: expands to 20–40 real companies and tags roles with explicit precedence **customer > competitor > battlefield** (a domain that's both a known competitor and a Fiber hit resolves to `competitor`). Dedup on normalized domain; provenance stamped only on Fiber-discovered battlefield rows.
- `src/understanding.ts` — cheap gpt-4o-mini pass behind a `ChatModel` **port**: `extractUnderstanding()` → `understanding{category, icp, positioning}` + a 4-line "what you are" card. The contract fields fail loud if absent; the cosmetic card **degrades gracefully** (never discards valid understanding).
- `src/firmographics.ts` — `mapFirmographics()` / `enrichFirmographics()` via a Fiber firmographics **port**. The context family stays **small** (only the 5 contract fields; extras dropped — effective-N discipline). Coverage honesty: `firmographics_missing` flips to false **only** when Fiber returns usable data.
- Tests: `tests/battlefield.test.ts`, `tests/understanding.test.ts`, `tests/firmographics.test.ts` (LLM + Fiber mocked). Reviewed by an independent agent (anchor-bias rule); two coverage-honesty findings fixed before commit.

**Phase 2 — Content + off-page enrichment, queries & features ✅ (heavy phase)** (`p3/phase-2-enrichment`)
Everything the model consumes: both feature families + the grounded query set. Writes `page` + `content_features`, `company.offpage`, `query`.

- `src/parsers.ts` — **deterministic** content-feature parsers (dependency-free, no DOM): schema/JSON-LD (incl. parameterized media types), comparison-table heuristic, word count, heading structure, freshness, query-term coverage (single tokens match on **word boundaries** so "ai" ≠ "email").
- `src/features.ts` — **subjective** features (direct-answer-first, stats/citation/quote density, listicle-vs-prose) via the gpt-4o-mini `ChatModel` port. Fails loud on bad output — one bad field drops the whole subjective vector (never a hollow partial).
- `src/content.ts` — Orange Slice **port** → `page` records. Deterministic family always present; subjective merged when a model is supplied. `extractor_version` encodes the subjective state (`none` / `+subj` / `+subj-err`) and `cache_key` folds in the query-term set — so the Phase-5 category cache can't serve a mismatched feature vector.
- `src/offpage.ts` — **off-page = first-class** (the dominant citation drivers): three vendor ports (Fiber/SERP/Reddit) → `company.offpage`. Each of the 8 fields is single-sourced (no double-sourcing); one vendor failing degrades gracefully; coverage honesty mirrors firmographics.
- `src/queries.ts` — grounded query gen: real seeds (PAA/keyword/Reddit/analytics) → LLM-**expand**, every query `seed_source`-tagged. Real seeds win over `llm_expand` on dedupe; a **ratio guard** caps `llm_expand` so it can't dominate (never fabricates real seeds). Deterministic ids.
- Tests: `tests/parsers.test.ts`, `tests/features.test.ts`, `tests/content.test.ts`, `tests/offpage.test.ts`, `tests/queries.test.ts` (all vendors + LLM mocked). Independent review (anchor-bias) fixed the cache-key completeness gap + subjective-honesty + parser-heuristic findings before commit.
- Known deferred (Minor, by design): `normalizeUrl` preserves path case (case-sensitive paths exist) and doesn't sort query params — revisit for join integrity in Phase 4.

Run: `npm test --workspace sourcing`.
