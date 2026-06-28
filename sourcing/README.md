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

Run: `npm test --workspace sourcing`.
