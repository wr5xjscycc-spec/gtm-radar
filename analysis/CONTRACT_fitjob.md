# Fit-Job Contract — Convex ⇄ Python (P4)

The Convex action `analysis.runFit` sends a `FitJobRequest` via `POST /fit`; the Python service returns a `FitJobResponse`. The action writes the response as a `model_fit` record (`records.insertModelFit`).

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
| `rows[].cluster_id` | string | Company cluster id — every row MUST carry this for effective-N computation |
| `rows[].features` | {string: float} | Feature-name → value map (standardized predictors) |

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
  "prior_version": "r2d2-2026.06",
  "top_hypotheses": [
    "comparison_table correlates with citation in this category; test it"
  ],
  "n_companies": 24,
  "n_rows": 312
}
```

| Field | Type | Description |
|---|---|---|
| `coefficients` | Coefficient[] | Per-feature posterior estimates |
| `coefficients[].feature` | string | Feature name |
| `coefficients[].posterior_median` | float | Median of the posterior distribution |
| `coefficients[].ci_low` | float | Lower bound of 90% credible interval |
| `coefficients[].ci_high` | float | Upper bound of 90% credible interval |
| `coefficients[].noise_flag` | bool | `true` if the CI crosses zero (80–90% expected at cold-start) |
| `prior_version` | string | Prior recipe identifier for reproducibility |
| `top_hypotheses` | string[] | 1–3 highest-signal hypotheses (not causal claims) |
| `n_companies` | int | **Effective N** — number of distinct `cluster_id` values. Always reported; never use row count as N for company-level features. |
| `n_rows` | int | Total page-level row count |

## Async path (planned)

Bayesian fits can take 30–300s. The production path will be:

1. Convex action calls `POST /fit/start` → returns `{job_id, status: "queued"}`
2. Python background worker processes the job
3. Convex polls `GET /fit/status/{job_id}` → `{status: "running" | "complete", result?: FitJobResponse}`
4. On `"complete"`, Convex writes `result` as a `model_fit` record

For Phase 0 the synchronous `POST /fit` is sufficient — the dummy fit returns instantly.
