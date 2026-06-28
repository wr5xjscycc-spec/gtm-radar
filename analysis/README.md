# analysis/ — Lane P4 (Intelligence & Loop)

The protected core (separate Python service, called by a Convex action): the **Bayesian hypothesis generator** (honest, uncertainty-flagged), the **randomized matched-pair difference-in-differences experiment engine**, the **interventional dataset** (the moat), plus asset generation + 3-tier delivery + CMS publish.

- Brief: [`../docs/phase-cards/P4-Intelligence-and-Loop.md`](../docs/phase-cards/P4-Intelligence-and-Loop.md)
- Contract: [`CONTRACT_fitjob.md`](CONTRACT_fitjob.md) (Fit-job request/response)
- Writes `model_fit`, `experiment`, `lift_result`, `intervention` (see `../docs/CONTRACT.md`).
- Tests: `pip install -r requirements.txt && pytest` (run from repo root: `pytest analysis`).
- **Stats are tested on synthetic data with known ground truth** — that's how we prove honesty.
- Non-negotiables: correlation≠causation (no causal output without a `lift_result`); effective N = #companies.

## Starting the service

```bash
uvicorn src.service:app --reload --port 8000
```

## Client example (Convex action)

A Convex action calls the Python service over HTTP and writes the result as a `model_fit` record:

```typescript
// convex/analysis/runFit.ts
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";

const ANALYSIS_URL = process.env.ANALYSIS_URL ?? "http://127.0.0.1:8000";

export const runFit = internalAction({
  args: {
    customerId: v.string(),
    category: v.string(),
    engine: v.string(),
    rows: v.array(v.object({
      pageUrl: v.string(),
      clusterId: v.string(),
      features: v.record(v.string(), v.number()),
    })),
  },
  handler: async (ctx, args) => {
    const resp = await fetch(`${ANALYSIS_URL}/fit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customer_id: args.customerId,
        category: args.category,
        engine: args.engine,
        rows: args.rows.map(r => ({
          page_url: r.pageUrl,
          cluster_id: r.clusterId,
          features: r.features,
        })),
      }),
    });
    if (!resp.ok) throw new Error(`analysis service error: ${resp.status}`);
    const fitResult = await resp.json();

    // Write the model_fit record
    await ctx.runMutation(internal.records.insertModelFit, {
      customerId: args.customerId,
      category: args.category,
      engine: args.engine,
      coefficients: fitResult.coefficients,
      priorVersion: fitResult.prior_version,
      topHypotheses: fitResult.top_hypotheses,
      nCompanies: fitResult.n_companies,
      nRows: fitResult.n_rows,
    });
  },
});
```

For the async path (production), change to a two-step workflow:
1. `POST /fit` returns `{job_id, status: "queued"}` (or use a dedicated `POST /fit/start`)
2. Poll `GET /fit/status/{job_id}` until `status: "complete"`, then read and write the result.
