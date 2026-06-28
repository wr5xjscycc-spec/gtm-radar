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

Run: `npm test --workspace sourcing`.
