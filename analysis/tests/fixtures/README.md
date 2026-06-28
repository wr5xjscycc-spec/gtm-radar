# P4-local seed fixtures

These JSON files are **P4-local seed fixtures** standing in for upstream records
that other lanes have not produced yet, so P4's Phase-1 row assembly can build
and test against fixtures (the documented repo workflow).

Standing in for:

- **P2** — `measurement.json` (record #5, aggregate per query×page×engine)
- **P3** — `company.json` (#2), `page.json` (#3), `query.json` (#4)

## Conventions

- Shapes/field names follow `docs/CONTRACT.md` (the 9-record contract). Field
  names must match exactly or joins break silently.
- **Domains and URLs are pre-normalized** (lowercase, no scheme on domains, no
  `www`). `page.company_domain` is the FK into `company.domain`;
  `measurement.page_url` is the FK into `page.url`; `measurement.query_id` is the
  FK into `query.id`.
- Three companies (`acme.example` customer, `globex.example` /
  `initech.example` competitors), all in category `ai-sales-tools`.
- Two pages per company (one winner, one loser) and two engines per page
  (`openai` + `perplexity`, kept separate — not pooled).

## Winner/loser spread

Pages with strong `content_features` (schema markup, comparison table, high word
count, fresh) carry high `P_cited` (winners, ~0.55–0.71); thin/stale pages carry
low `P_cited` (losers, ~0.04–0.18), so the spread is distinguishable per engine.
