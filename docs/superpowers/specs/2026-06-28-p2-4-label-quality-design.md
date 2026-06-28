# P2·4 — Label-quality QA (design/spec)

**Date:** 2026-06-28 · **Lane:** P2 (Measurement) · **Branch:** `p2/phase-4-label-quality` (off `p2/phase-3-statistics`)
**Status:** approved direction; implementation contract for the build workflow.

## Goal

Phase card P2·4 "Label quality for the model": guarantee P4's hypothesis generator gets clean, correctly-keyed inputs, and **quantify + report** measurement noise honestly (don't bury the flip-rate). Three pure analyses over data P2·3 already produces. No network; all TDD; drop into `measurement/`.

Out of scope: P4 itself; real P3 pools/queries (we develop against synthetic + the existing fixtures; the functions key on the contract shapes so real data drops in unchanged).

## Non-negotiables carried from the lane

- **Per-engine, never merged** — every report is keyed/grouped with `engine` in the key.
- **Normalized domain is the join key** — use `normalizeDomain` (normalize.ts); never invent a key format.
- **Pure functions, defensive on bad input.** Style matches `measurement.ts` / `aggregate.ts` (heavy "why" doc-comments, `export function`, no classes).
- **Surface, don't bury** — join misses and degenerate pools are returned explicitly, not silently dropped.
- **TDD** — test file first (red), then implementation to green; each module runs only its own test file while building.

## Inputs (existing shapes — do not modify)

- `MeasurementRow` (types.ts): run-level, has `query_id, page_url, engine, cited, position, run_idx, model_version, …`.
- `MeasurementAggregate` (stats/aggregate.ts): per-(query,page,engine) `{ k, cited_count, p_cited, ci_low, ci_high, position_weight, model_version, … }`.
- `CandidatePage` (contract-records.ts): `{ company_domain, url, role }`.

---

## Module 1 — `src/quality/flip-rate.ts` (measurement-noise QA)

Integrate **three** complementary instability lenses per `(query_id, page_url, engine)` group of K run-level rows. All derive from the same K binary `cited` outcomes; group rows by the full triple (reuse the same grouping discipline as aggregate.ts — stable first-seen order).

```ts
export interface InstabilityMetrics {
  minority_fraction: number;  // min(cited_count, k-cited_count)/k ∈ [0,0.5]; 0 = unanimous. PRIMARY.
  transition_rate: number;    // adjacent label changes / (k-1), rows ordered by run_idx ∈ [0,1].
                              // Order-dependent & runs are exchangeable → informational only.
  entropy: number;            // binary Shannon entropy of p=cited_count/k, in BITS ∈ [0,1];
                              // 0 when unanimous, 1 at p=0.5. 0*log2(0) treated as 0.
  flipped: boolean;           // minority_fraction > 0 (i.e. not unanimous).
}

export interface GroupInstability extends InstabilityMetrics {
  query_id: string; page_url: string; engine: Engine; k: number; cited_count: number;
}

export interface EngineFlipReport {
  engine: Engine;
  n_groups: number;          // groups with k >= 2 (eligible)
  n_insufficient: number;    // groups with k < 2 (can't flip; excluded from means)
  n_flipped: number;         // eligible groups with flipped === true
  flip_fraction: number;     // n_flipped / n_groups (0 when n_groups === 0)
  mean_minority_fraction: number;
  mean_transition_rate: number;
  mean_entropy: number;
  unstable: GroupInstability[]; // flipped groups, worst-first by minority_fraction desc,
                                // tiebreak entropy desc; stable for equal keys.
}

// One report per engine present in `rows`. Engines never merged.
export function computeFlipRates(rows: MeasurementRow[]): EngineFlipReport[];
```

Notes: transition_rate needs the runs **ordered by `run_idx`** (rows may arrive unordered). For k<2 groups, instability metrics are still defined (minority_fraction=0, transition_rate=0, entropy=0, flipped=false) but the group is counted in `n_insufficient` and EXCLUDED from `n_groups` and the means (a single draw tells you nothing about noise).

**Tests** (`tests/quality/flip-rate.test.ts`):
- minority_fraction: 3/3 & 0/3 → 0 (unanimous, flipped=false); 2/3 → 0.333 flipped; 2/4 → 0.5 (max).
- transition_rate honors run_idx order: rows {0:cited,1:uncited,2:cited} (shuffled input) → 2 transitions /2 = 1.0; {0:cited,1:cited,2:uncited} → 0.5.
- entropy: unanimous → 0; 2/4 → 1.0; 1/4 → 0.811 (tol 1e-3); no NaN at p=0 or 1.
- per-engine separation: same query+page on two engines → two groups in two reports.
- k<2 group → n_insufficient, excluded from means; all-k<2 engine → flip_fraction 0, no NaN.
- unstable sorted worst-first; empty input → [].

---

## Module 2 — `src/quality/label-table.ts` (model-ready output for P4)

Join aggregates → candidate pool by `page_url` to attach the normalized domain key + role.

```ts
export type Label = "winner" | "loser";

export interface LabelTableRow {
  query_id: string; engine: Engine; page_url: string;
  company_domain: string;     // NORMALIZED (P1 join key)
  role: PageRole;
  p_cited: number; ci_low: number; ci_high: number; position_weight: number; k: number;
  label: Label;               // p_cited >= 0.5 ? "winner" : "loser" (majority convenience;
                              // the RATE+CI is the primary signal, label is secondary)
  model_version: string;
}

export interface LabelTable {
  rows: LabelTableRow[];
  unmatched: MeasurementAggregate[]; // aggregates with no pool page at that page_url —
                                     // a keying miss is a BUG to surface, never dropped silently
}

export function buildLabelTable(aggregates: MeasurementAggregate[], pool: CandidatePage[]): LabelTable;
```

Join: match `aggregate.page_url` to a pool page by `page.url`. Build the pool lookup keyed by exact `url` (the contract carries normalized URLs already; do NOT re-normalize the path, only `company_domain` is normalized via `normalizeDomain`). Output row order follows input aggregate order (stable). `label` threshold is `>= 0.5` (a page cited in exactly half its runs counts as a winner — tie goes to "cited").

**Tests** (`tests/quality/label-table.test.ts`): a cited aggregate (p_cited 1.0) → winner with normalized company_domain + role from the pool; p_cited 0.0 → loser; p_cited exactly 0.5 → winner (tie rule); an aggregate whose page_url is absent from the pool → `unmatched`, not in rows; per-engine rows preserved; empty inputs → empty table.

---

## Module 3 — `src/quality/pool-composition.ts` (case-control sanity)

Guards the card's gotcha: a loser pool dominated by one company biases the model. Operates on ONE category's pool (caller groups by vertical).

```ts
export interface DomainShare { company_domain: string; n_pages: number; share: number; } // normalized domain

export interface CompositionReport {
  n_pages: number;
  n_companies: number;          // distinct normalized company_domain
  shares: DomainShare[];        // desc by n_pages, then domain asc; share = n_pages/n_pages_total
  dominated: boolean;           // any share > dominanceThreshold
  offenders: DomainShare[];     // shares strictly above the threshold
}

export function assessPoolComposition(
  pool: CandidatePage[],
  opts?: { dominanceThreshold?: number }, // default 0.5
): CompositionReport;
```

Pages whose `company_domain` normalizes to "" are excluded from counts (defensive — same posture as labeling.ts), but note: do not crash on them. Empty pool → `{ n_pages:0, n_companies:0, shares:[], dominated:false, offenders:[] }`.

**Tests** (`tests/quality/pool-composition.test.ts`): balanced 2-domain pool → not dominated; one domain holding 3/4 → dominated, that domain in offenders; threshold boundary (exactly 0.5 with default → NOT dominated, strict `>`); custom threshold; garbage domain excluded; empty pool → zeros, not NaN.

---

## Verification (final gate — run by the human after modules land)

1. `npm run typecheck` clean.
2. `npm test` — prior 106 + new green.
3. Optional live capstone: extend `scripts/p2-3-live.ts` (or a new `p2-4-flip.ts`) to run K≥4 repeats on one query and feed run-level rows into `computeFlipRates` for a REAL flip-rate number (the P2·3 live run already showed openai/apollo.io cited 2/3 — a genuine flip).

## File manifest (all NEW)

| File | Depends on |
|---|---|
| `src/quality/flip-rate.ts` + `tests/quality/flip-rate.test.ts` | types |
| `src/quality/label-table.ts` + `tests/quality/label-table.test.ts` | aggregate (type), contract-records, normalize |
| `src/quality/pool-composition.ts` + `tests/quality/pool-composition.test.ts` | contract-records, normalize |

The three modules are **mutually independent** → build all three in parallel. Each agent runs only its own test file; project-wide typecheck + full suite run once at the end.
