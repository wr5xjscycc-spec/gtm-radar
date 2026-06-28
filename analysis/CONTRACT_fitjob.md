# Fit-Job Contract — Convex ⇄ Python (P4)

The Convex action `analysis.runFit` sends a `FitJobRequest` via `POST /fit`; the Python service runs a baseline logistic regression and returns a `FitJobResponse`. The action writes the response as a `model_fit` record (`records.insertModelFit`).

## FitJobRequest

```json
{
  "customer_id": "ws_acme",
  "category": "GTM analytics",
  "engine": "openai",
  "rows": [
    {
      "page_url": "https://acme.com/pricing",
      "cluster_id": "acme.com",
      "P_cited": 0.0,
      "features": {
        "comparison_table": 1.0,
        "word_count": 0.75,
        "offpage.thirdparty_mentions": 0.3
      }
    }
  ]
}
```

| Field | Type | Description |
|---|---|---|
| `customer_id` | string | Workspace / customer identifier |
| `category` | string | Content category for this fit run |
| `engine` | string | Answer engine: `openai` / `perplexity` / `gemini` |
| `rows` | FitRow[] | Page-level feature rows |
| `rows[].page_url` | string | Normalized page URL |
| `rows[].cluster_id` | string | **Company cluster id** — every row MUST carry this for effective-N computation. This is the `company_domain` from the `page` record. |
| `rows[].P_cited` | float or null | Outcome variable — citation probability from measurement aggregate (0–1). Omit or set null for unsupervised / exploratory fits. |
| `rows[].features` | {string: float} | Feature-name → value map (standardized predictors). Includes both page content features and company off-page features (prefixed `offpage.*`). |

### Row assembly (Convex action side)

The Convex action assembles rows by joining three record types:

```
measurement.page_url  ──→  page.url
                              │
                    page.company_domain  ──→  company.domain
```

The action should:
1. Query `measurement` records filtered by `workspaceId`, `engine`, `window_tag: "baseline"`
2. For each measurement, look up the `page` record by `page_url`
3. From the page, get `company_domain` — this becomes the row's `cluster_id`
4. Look up the `company` record by `domain`
5. Set `features` = page `content_features` ∪ company `offpage` (prefixed `offpage.*`)
6. Set `P_cited` = measurement aggregate `P_cited`
7. Group rows by `(customer_id, company.understanding.category, engine)` into separate fit requests

## FitJobResponse

```json
{
  "coefficients": [
    {
      "feature": "comparison_table",
      "posterior_median": 0.82,
      "ci_low": 0.21,
      "ci_high": 1.44,
      "noise_flag": false
    }
  ],
  "prior_version": "baseline-ridge-0.1.0",
  "top_hypotheses": [
    "comparison_table correlates with citation in this category (coefficient=0.82)"
  ],
  "n_companies": 24,
  "n_rows": 312
}
```

| Field | Type | Description |
|---|---|---|
| `coefficients` | Coefficient[] | Per-feature posterior estimates |
| `coefficients[].feature` | string | Feature name |
| `coefficients[].posterior_median` | float | Coefficient (Ridge regression weight, standardized scale in Phase 1; posterior median in Phase 4) |
| `coefficients[].ci_low` | float | Lower bound of 90% credible interval (approximate in Phase 1) |
| `coefficients[].ci_high` | float | Upper bound of 90% credible interval |
| `coefficients[].noise_flag` | bool | `true` if the coefficient is near zero (80–90% expected at cold-start) |
| `prior_version` | string | Prior/model recipe identifier for reproducibility |
| `top_hypotheses` | string[] | 1–3 highest-signal hypotheses (not causal claims) |
| `n_companies` | int | **Effective N** — number of distinct `cluster_id` values. Always reported; never use row count as N for company-level features. |
| `n_rows` | int | Total page-level row count |

## Async path (planned)

Bayesian fits (Phase 4) can take 30–300s. The production path will be:

1. Convex action calls `POST /fit/start` → returns `{job_id, status: "queued"}`
2. Python background worker processes the job
3. Convex polls `GET /fit/status/{job_id}` → `{status: "running" | "complete", result?: FitJobResponse}`
4. On `"complete"`, Convex writes `result` as a `model_fit` record

For Phase 0–1 the synchronous `POST /fit` is sufficient — the Ridge baseline fits instantly.
