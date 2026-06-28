# Seed fixtures — the Phase-0 thin slice

**Contract-reference seeds.** One small, internally-consistent example per record
type (`docs/CONTRACT.md`), so each lane can build and test against the records it
*reads* before the upstream lane *writes* them. Owning lanes may replace/extend
their own fixtures (with §4 sign-off if the shape changes).

**Everything keys on normalized domains/URLs** (via `convex/lib/domain.ts`), so
the joins are demonstrably correct end-to-end:

- workspace `own_domain` = `acme.com`; competitors `competitor.com`, `rival.io`
- `companies[].domain` ⟶ `pages[].company_domain` ⟶ `measurements[].source_urls`
- `pages[].url` = `measurements[].page_url` (the citation join)

The thin slice tells one story: **Acme is cited 0/1 by OpenAI; Competitor 1/1.**
That is the "0 of N" gut-punch in miniature — descriptive `measurement` only, no
causal claim (there is a `lift_result` fixture for the *later* phases, clearly a
separate epistemic layer).

## Files
| File | Record | Owner |
|---|---|---|
| `workspace.json` | customer/workspace | P1 |
| `companies.json` | company | P3 |
| `pages.json` | page | P3 |
| `queries.json` | query | P3 |
| `measurements.json` | measurement | P2 |
| `model_fits.json` | model_fit | P4 |
| `experiments.json` | experiment | P4 |
| `lift_results.json` | lift_result | P4 |
| `interventions.json` | intervention | P4 |

`workspaceId` / `_id` / Convex FK ids are placeholder strings here; resolve them
to real ids when you insert via the `convex/records.ts` mutations.
