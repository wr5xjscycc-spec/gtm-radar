# Scale path — beyond cold-start (P4 Phase 6, tasks 1 & 4)

This documents how the intelligence layer graduates past small-N, and which
capture path we deliberately defer. It is a roadmap with one real, tested gate
(`ready_for_hierarchical`) and one honest stub (`fit_hierarchical_model`) in
`src/scale.py` — nothing here claims to be built.

## 1. The cold-start reality (today)

The day-1 generator (`src/bayes.py`) fits a **pooled regularized-horseshoe
Bayesian logistic** independently per `(category, engine)`:

- **Effective N = number of companies (~20–40), not the row count.** Company-level
  features are inherited across a company's page rows (pseudo-replication), so the
  row count overstates information. The prior's global scale is calibrated to
  `n_companies`, not `n_rows`.
- **EPV ≈ 1–3.** ~15 features over ~20–40 effective units. Without aggressive
  shrinkage the coefficients separate and blow up.
- **So we shrink hard now.** The horseshoe pins the whole coefficient vector toward
  zero and the slab tames the heavy tail; we **expect 80–90% of coefficients to be
  flagged noise** and that is the honest answer at this data density. Coefficients
  are *hypotheses to test* (Phase 5 experiment), never causal claims.

This is correct for cold start, but each `(category, engine)` model is an island:
it cannot borrow strength from other categories, and it cannot separate
within-company from between-company variation beyond an SE correction.

## 2. The hierarchical graduation (the plan)

When the data is wide enough, replace the independent pooled fits with a single
**mixed-effects (hierarchical) model** across all tables:

- **Random effects for company, category, and engine**, plus a shared
  fixed-effects core.
- **Partial pooling:** thin categories are pulled toward the global mean; rich
  categories keep their specificity. Strength is shared without pretending every
  category is identical (full pooling) or fully independent (no pooling).
- **The company stays the effective-N cluster.** The company random effect makes
  the clustering explicit; it does not manufacture information the company count
  lacks.

### Thresholds (gate)

Graduation is gated on **cluster counts**, not calendar time:

| Constant | Value | Why |
|---|---|---|
| `MIN_CATEGORIES` | 15 | enough category clusters to identify between-category variance |
| `MIN_COMPANIES` | 300 | effective N (companies) for the company random effect |

`ready_for_hierarchical(n_categories=, n_companies=)` returns
`{"ready": bool, "reasons": [...]}` and is True only when **both** are met.

### The tension (why it's gated)

Partial pooling **shrinks per-category specificity** — that is its purpose and its
risk. Identifying the between-group variance components (the random-effect
variances) needs **enough clusters**. With too few categories or companies the
variance parameters are unidentified and the model collapses to either full
pooling (everything is the global mean) or no pooling (the cold-start model, but
noisier). A hierarchical fit run below threshold reports between-group structure it
cannot actually identify — strictly worse than honest cold-start shrinkage. That is
why `fit_hierarchical_model` raises `NotImplementedError` rather than faking a fit.

## 3. Deferred: AI-Overviews capture (Browserbase / Playwright) — OUT of v1

Capturing **Google AI Overviews** via a headless browser (Browserbase / Playwright)
is explicitly **out of scope for v1** (P4 Phase 6, task 4):

- **No public/stable API** for AI Overviews — capture means scraping rendered SERPs.
- **Brittle:** the surface changes shape and triggering is query/region/account
  dependent; a scraper is a maintenance treadmill with low signal reliability.
- **ToS risk:** automated SERP scraping runs against Google's terms; not a base to
  build a measurement product's credibility on.

We ship measurement on the engines we can read honestly (OpenAI, Perplexity) and
revisit AI-Overviews capture only if a compliant, stable access path appears. Until
then it is a documented non-goal, not a hidden gap.
