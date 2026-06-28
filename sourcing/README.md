# sourcing/ — Lane P3 (Sourcing & Enrichment)

The data supply: battlefield builder (Fiber `find-similar-companies`), company-understanding, firmographics, Orange Slice content scrape, **off-page/entity enrichment** (third-party mentions, Reddit/G2/Wikipedia/review presence, brand search, backlinks), query seeding + generation, feature extraction, category caching, the launch vertical pack.

- Brief: [`../docs/phase-cards/P3-Sourcing-and-Enrichment.md`](../docs/phase-cards/P3-Sourcing-and-Enrichment.md)
- Writes `company`, `page`, `query` records (see `../docs/CONTRACT.md`).
- Tests: `npm test` (vitest). Mock vendors; fixtures for integration.
- Non-negotiable: off-page/earned/entity signals dominate AI citation — supply BOTH families, not just on-page.
