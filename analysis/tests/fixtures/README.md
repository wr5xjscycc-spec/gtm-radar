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
- Eight pages across the three companies, each measured on two engines
  (`openai` + `perplexity`, kept separate — not pooled).

## Winner/loser spread

Pages with strong `content_features` (schema markup, comparison table, high word
count, fresh) carry high `P_cited` (winners, ~0.55–0.71); thin/stale pages carry
low `P_cited` (losers, ~0.04–0.18), so the spread is distinguishable per engine.

## Topical clusters (for P4 Phase 2 matching)

A page's **topical cluster** is the query group it is cite-tested against
(`measurement.query_id` → `query`). No page bridges two queries, so clusters are
unambiguous and **derivable without NLP** — Phase 2 should NOT assume a
`topical_cluster` field on the records (none exists in `docs/CONTRACT.md`); derive
it from the measurement→query grouping.

Two clean clusters, each with winners and losers across multiple companies, so
Phase-2 matching can form **cross-cluster, cross-company** pairs (the spillover
guard — never pair two pages competing for the same query):

- **q1 `qry_seed_001` (sdr-tools):** acme/compare (win), initech/features (win),
  acme/blog/guide (lose), globex/blog (lose)
- **q2 `qry_seed_002` (engagement):** globex/product (win), acme/integrations
  (win), globex/news/update (lose), initech/docs (lose)

Comparable-rate cross-cluster pair examples: winners acme/compare(q1,~0.71) ↔
globex/product(q2,~0.66); losers acme/blog(q1,~0.08) ↔ initech/docs(q2,~0.04).
