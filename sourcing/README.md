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

**Phase 3 — Candidate pool & extractor hardening ✅** (`p3/phase-3-candidate-pool`)
Makes P2's labels and P4's features trustworthy. Reads `query`/`page`; writes the candidate-pool table + agreement metrics.

- `src/candidates.ts` — `buildCandidatePool()` via a SERP classic-search **port**: for each query, the ranked "could-have-been-cited" set = the **case-control loser pool** (cited→winner, in-pool-but-not-cited→loser; NOT "all uncited pages"). Normalized url keys, within-query best-rank dedupe, no cross-query dedupe, honest top-N cap, all-or-nothing rank policy.
- `src/agreement.ts` — `computeAgreement()` / `evaluateExtractor()`: inter-rater/LLM agreement on the subjective features. Cohen's κ (categoricals) + within-tolerance (numerics). **Honesty:** every feature reported even when mediocre; negative κ disclosed as-is (never floored); attrition surfaced (`attempted`/`skipped`). Agreement is descriptive **measurement**, never a causal claim.
- New artifacts in `types.ts` (`CandidatePoolEntry`, `AgreementReport`) are a **contract-extension proposal** beyond the 9 records — freeze with P2/P4 sign-off before they build against them.
- Tests: `tests/candidates.test.ts`, `tests/agreement.test.ts` (SERP + LLM mocked). Independent review (anchor-bias) → verdict ship; fixed the agreement-range doc (κ ∈ [-1,1], not [0,1]), added attrition counts, made rank policy all-or-nothing.

**Phase 4 — Join integrity for the model ✅** (`p3/phase-4-join-integrity`)
Guarantees P4 gets correctly-joined, coverage-honest context. Reads `company`/`page`; writes the joined feature set + coverage flags.

- `src/join.ts` — `joinPagesToCompanies()`: joins every `page` to its `company` on the normalized domain and inherits the company-level context (offpage/firmographics/understanding) to EVERY page. The join is **audited, not trusted** — a www/subdomain miss (orphan), a childless company, a **key collision** (first-wins, loser surfaced — never mis-attribute the dominant off-page signal), and an unjoinable company are all **surfaced** in `JoinReport`, never silently dropped. Inherited context is per-row copies (no cross-row/source corruption).
- `src/coverage.ts` — `assessCompanyCoverage()` / `assessPageCoverage()` / `buildCoverageReport()` / `reconcileCompanyFlags()`: coverage judged from **actual data presence** (reconciles stale `coverage_flags` toward reality; a measured `0` counts as present). Low-coverage entities are **flagged and kept** in the report (never dropped) — the transparency guarantee.
- Tests: `tests/join.test.ts`, `tests/coverage.test.ts`. Independent review (anchor-bias) caught a **Critical** (silent company-key collision mis-attributing off-page) + a **Major** (unjoinable companies vanishing) — both fixed before commit with new `duplicate_domains` / `unjoinable_companies` audit surfaces and tests.

**Phase 5 — Category-level caching ✅ (cost lever)** (`p3/phase-5-caching`)
Cuts per-customer cost by reusing competitor scrapes/features across customers in the same vertical (the #1 unit-economics risk). P3-internal; reads/writes `page` via the cache.

- `src/cache.ts` — `PageCache` over a `CacheStore` port, keyed by `cache_key`. Cross-customer reuse via a **query-term-scoped reuse index** (`url + queryTermsHash + extractorVersion`) so a 2nd customer skips the expensive scrape + gpt-4o-mini extraction; hit/miss/reuse stats back the "measured cost drop." A different query pack can **never** resolve to another customer's feature vector.
- `src/invalidation.ts` — pure validity policy: an entry is reusable only when **within the freshness window** (default 30d) **and** from the **current `extractor_version`**. Fail-safe: unparseable `scraped_at` → stale; future date → fresh (clamped). A stale / old-extractor entry is never served.
- `src/caching.ts` — wires the real policy as the cache's default validator; `cacheContext(now, {extractorVersion, queryTerms})` hashes query terms exactly as `cache_key` does.
- Tests: `tests/cache.test.ts`, `tests/invalidation.test.ts`, `tests/caching.integration.test.ts`. Independent review (anchor-bias) caught a **Critical** — the URL reuse path dropped the query-terms dimension and could serve customer B customer A's `query_term_coverage`. Fixed before commit (query-term-scoped reuse key + a dedicated cross-query-pack test).
- Deferred (Minor): implausible far-future timestamps treated as fresh; lenient ISO parse; `expectedExtractorVersion` must be the effective (`+subj`) version or the cache silently no-ops (documented at `cacheContext`).

**Phase 6 — Vertical pack finalization & coverage QA ✅ (lane complete)** (`p3/phase-6-vertical-pack`)
Makes the launch vertical real and honest — the vertical-first wedge.

- `src/vertical-pack.ts` — `buildVerticalPack()`: curates the grounded query set down to **one** vertical (the anti-horizontal gate — cross-vertical queries are excluded **and** surfaced as issues, never silently absorbed), dedupes, attaches the vertical's CMS targets, and runs transparent validation gates (single-vertical, min size, healthy real-seed ratio, ≥1 CMS target). An invalid pack is still **returned** with its `issues` populated. Vertical slugs are matched case-insensitively so a casing variant can't misfire a false contamination signal.
- `src/coverage-qa.ts` — `sweepVerticalCoverage()`: runs the Phase-4 coverage sweep over the vertical, collects every low-coverage entity into `surfaced_low_coverage` for P1's UI, and reconciles final company flags. `passed` is a **transparency** assertion (nothing dropped), **not** a completeness gate — a low-coverage vertical still passes as long as its gaps are visible.
- Tests: `tests/vertical-pack.test.ts`, `tests/coverage-qa.test.ts`. Independent review (anchor-bias) → verdict ship; hardened the vertical-slug match (case-insensitive) and silenced a `0/0` ratio issue, with boundary tests added.

Run: `npm test --workspace sourcing`.

---

**Lane status: all 7 phases (0–6) complete — 244 sourcing tests green.** Every phase was built by parallel agents on disjoint files, independently reviewed (anchor-bias rule), with findings fixed before commit.
