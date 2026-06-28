# Measurement row contract (frozen at P2·1)

> This is the normalized `measurement` record shape. Every engine adapter
> produces an `EngineResult` that maps directly into this row. P1 persists it
> via a Convex mutation; P4 consumes it for model fitting.
>
> See also `docs/CONTRACT.md` §5 for the authoritative cross-lane interface.

---

## Adapter output (`EngineResult`)

```typescript
interface EngineResult {
  engine: "openai" | "perplexity" | "gemini";
  appeared: boolean;       // engine returned at least one citation
  cited: boolean;          // target domain (normalized) found in citation list
  position: number | null; // 0-based index in citation list; null if not cited
  source_urls: string[];   // raw citation URLs from the engine response
  model_version: string;   // opaque model identifier (e.g. "gpt-4o-2024-08-06")
}
```

## Convex `measurement` record (from CONTRACT.md)

```typescript
interface ConvexMeasurement {
  id: string;              // Convex auto-generated
  query_id: Id<"queries">;
  page_url: string;        // normalized URL (via normalizeUrl)
  engine: "openai" | "perplexity" | "gemini";
  model_version: string;   // from EngineResult.model_version
  run_idx: number;         // K-repeat index (0, 1, 2…)
  appeared: boolean;       // from EngineResult.appeared
  cited: boolean;          // from EngineResult.cited
  position: number | null; // from EngineResult.position
  source_urls: string[];   // from EngineResult.source_urls
  ts: number;              // Date.now() at write time
  window_tag: "baseline" | "post" | "adhoc";
  experiment_id?: string;
}
```

## Mapping (`EngineResult` → `ConvexMeasurement`)

| Convex field | Source | Notes |
|---|---|---|
| `engine` | `EngineResult.engine` | — |
| `model_version` | `EngineResult.model_version` | Drift detection key |
| `appeared` | `EngineResult.appeared` | — |
| `cited` | `EngineResult.cited` | — |
| `position` | `EngineResult.position` | — |
| `source_urls` | `EngineResult.source_urls` | Raw URLs; normalization happens in the mutation |
| `query_id` | Provided by caller (P1 action) | From the `query` record |
| `page_url` | Provided by caller (P1 action) | Normalized via `normalizeUrl` |
| `run_idx` | Provided by dispatch harness | Incremented per K-repeat |
| `ts` | `Date.now()` at write | — |
| `window_tag` | Set by dispatch / experiment | `baseline` for standard measurement |
| `experiment_id` | Provided by experiment engine | Optional; null for ad-hoc |

## Aggregate fields (computed by P2·3+)

```typescript
interface MeasurementAggregate {
  P_cited: number;         // proportion of runs where cited=true
  ci_low: number;          // 95% Wilson CI lower bound
  ci_high: number;         // 95% Wilson CI upper bound
  position_weight: number; // inverse-rank weighted average position
}
```

These are stored alongside the per-run rows, keyed on `query_id + page_url + engine`.

## Key contract rules

1. **Domain normalization** uses P1's `normalizeDomain()` — every citation
   URL is reduced to eTLD+1 before matching. A non-normalized key is a
   silent join failure.
2. **Per-engine isolation**: never merge engines. Each engine gets its own
   rows and aggregates.
3. **Version stamping**: every row carries `model_version` so a mid-sweep
   model update is detectable.
4. **Run-level rows + aggregates**: both are written; P4 can choose its
   preferred granularity.
