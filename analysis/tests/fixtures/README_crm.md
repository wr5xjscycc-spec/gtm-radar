# P4-local seed fixtures — second category (`crm-software`)

These files (`company_crm.json`, `page_crm.json`, `query_crm.json`,
`measurement_crm.json`) add a **second product category** alongside the original
`ai-sales-tools` seed set. They exist so Phase-3 **per-category, per-engine row
construction** is testable: with only one category, "per-category" grouping
cannot be exercised.

They follow the same shapes/field names as the original fixtures
(`docs/CONTRACT.md` records #2 company, #3 page, #4 query, #5 measurement) and
the conventions in `README.md`. The original files are **not modified** — the
existing integration tests load them by exact filename and assert exact counts,
so this category lives in new, separately-named files.

## Records

- **Companies** (all `understanding.category` = `crm-software`):
  `nimbus.example` (customer), `vortex.example` (competitor),
  `summit.example` (competitor).
- **Pages**: 6 (2 per company). Winners carry strong `content_features` (schema
  markup, comparison table, high word count, fresh); losers are thin/stale.
- **Queries**: `qry_crm_001` and `qry_crm_002`, both `vertical` = `crm-software`,
  forming two topical clusters (a page is cite-tested against exactly one query,
  so clusters are derivable from the measurement→query grouping — no page bridges
  two queries).

## Case-control labeling via `appeared` / `cited`

Each page is measured per engine (`openai` + `perplexity`, kept separate). The
`appeared`/`cited` pair encodes the case-control label used to build the
winner/loser pool:

- **winner** = `appeared=true`, `cited=true` (high `P_cited`, ~0.55–0.70).
- **loser (considered-but-not-cited)** = `appeared=true`, `cited=false`
  (moderate-low `P_cited`, ~0.10–0.30) — the case-control controls.
- **not-considered** = `appeared=false`, `cited=false` (very low `P_cited`,
  ~0.02–0.03) — **excluded** from the winner/loser pool. Included specifically so
  the exclusion path is exercised.

Invariants kept (same as the original set): `ci_low <= P_cited <= ci_high`;
`cited == (P_cited > 0.5)`; every `page_url` resolves to a page and every
`query_id` to a query.

## Pool composition (per engine)

Across each engine the **considered** pool (`appeared=true`) has **3 winners**
(`nimbus/compare`, `vortex/platform`, `summit/features`) and **2 losers**
(`nimbus/blog/tips`, `summit/docs`), so a per-(category, engine) model has both
classes. `vortex/changelog` (`appeared=false`) is the **excluded** not-considered
page.

Topical clusters:

- **q1 `qry_crm_001` (sales-team CRM):** nimbus/compare (win),
  summit/features (win), nimbus/blog/tips (lose).
- **q2 `qry_crm_002` (enterprise CRM):** vortex/platform (win),
  summit/docs (lose), vortex/changelog (excluded / not-considered).
