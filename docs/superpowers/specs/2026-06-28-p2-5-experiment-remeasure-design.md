# P2·5 — Experiment re-measurement (design/spec)

**Date:** 2026-06-28 · **Lane:** P2 (Measurement) · **Branch:** `p2/phase-5-experiment-remeasure` (off `p2/phase-6-cost-guards`)
**Status:** approved direction; implementation contract for the build workflow.

## Goal

Phase card P2·5 DoD: **an experiment's pre/post citation rates are measured, windowed (`baseline`/`post`), and tagged with `experiment_id` for P4's difference-in-differences.** Built against an `experiment`-record **fixture** (CONTRACT §7) because P4 doesn't exist yet — the contract spec prescribes exactly this ("code against its fixture, note the assumption"). Drops onto real P4 data unchanged.

Out of scope: P4's DiD / `lift_result` (P4 owns causal claims); P1's scheduler / publish-event trigger (P2 ships the re-measurement *function* the scheduler calls).

## Non-negotiables

- **Identical-arm protocol** — treatment and control pages are measured in ONE `measureAdaptive` pass with ONE shared config. Asymmetric measurement (different engines/K/cadence per arm) is the #1 DiD confound; symmetry must be *structural*, not promised.
- **Version-stamp survives** — `model_version` already rides each row (drift across a window invalidates DiD; P2·6 `detectModelDrift` can be run over the tagged rows).
- **Per-engine, never merged.** Re-measurement is per-engine throughout (unchanged from the core).
- **Pure / injectable** — `tagExperimentRows` is pure & non-mutating; the orchestration takes an injected registry (fakes in tests, no network).
- **Style:** match `measurement.ts` / `adaptive.ts`. **TDD**, test file first.

## Design choice (decided): RE-TAG AFTER measurement

`measureAdaptive` → `buildLabeledRows` emit rows with `window_tag:"adhoc"` and no `experiment_id`. Rather than thread two new params through the measurement core, a pure post-pass `tagExperimentRows` rewrites those two fields. Keeps the core untouched and tagging trivially testable.

## Inputs (existing — do not modify)

`MeasurementRow` (types.ts) already carries `window_tag: "baseline"|"post"|"adhoc"` and `experiment_id?: string` — no type changes needed. `measureAdaptive` (sampling/adaptive.ts), `QueryRecord`/`CandidatePage` (contract-records.ts), `EngineRegistry` (dispatch.ts).

---

## Module 1 — `src/experiment-records.ts`

Projection of the CONTRACT §7 `experiment` record (the fields P2 re-measurement needs) — a NEW file (do not edit `contract-records.ts`).

```ts
export type ExperimentStatus = "designing" | "awaiting_publish" | "running" | "complete" | "expired";

export interface ExperimentPair {
  treatment_page: string;   // page url (the changed page)
  control_page: string;     // page url (the matched, unchanged page)
  match_covars?: Record<string, unknown>;
}

export interface ExperimentRecord {
  id: string;
  customer_id: string;
  pairs: ExperimentPair[];
  baseline_window: string;  // opaque window id/label (P1 owns semantics)
  post_window: string;
  status: ExperimentStatus;
  publish_event_ts?: number;
}

export type Arm = "treatment" | "control";

// Which arm (if any) a page url belongs to in this experiment. EXACT url match against every
// pair's treatment_page / control_page. Returns null for a page that is in neither arm (e.g. a
// competitor page sharing the candidate pool). Treatment takes precedence if a url somehow appears
// as both (defensive — shouldn't happen in a well-formed experiment).
export function classifyArm(pageUrl: string, experiment: ExperimentRecord): Arm | null;
```

**Tests** (`tests/experiment-records.test.ts`): a treatment_page url → "treatment"; a control_page url → "control"; an unrelated url → null; multiple pairs scanned; exact-match only (a near-miss url → null); treatment precedence on a (malformed) dual-listed url.

---

## Module 2 — `src/experiment.ts`

```ts
import type { WindowTag } from "./types";

// Pure, NON-MUTATING: return new rows with window_tag + experiment_id set. windowTag is restricted
// to the experiment windows (baseline|post) — re-measurement never writes "adhoc".
export function tagExperimentRows(
  rows: MeasurementRow[],
  windowTag: "baseline" | "post",
  experimentId: string,
): MeasurementRow[];

export interface ExperimentWindowResult {
  experiment_id: string;
  window: "baseline" | "post";
  rows: MeasurementRow[];                                  // ALL rows, tagged
  byArm: { treatment: MeasurementRow[]; control: MeasurementRow[] }; // partition via classifyArm
  failures: Array<{ engine: Engine; error: string; query_id: string }>;
}

// Re-measure one window of an experiment with the IDENTICAL-ARM protocol: every query measured in a
// single measureAdaptive pass (pools contain both arms' pages), then all rows tagged with this
// window + experiment_id. byArm partitions rows by classifyArm (rows in neither arm — competitor
// pool pages — are tagged and present in `rows` but appear in NEITHER arm bucket).
export function reMeasureExperimentWindow(params: {
  experiment: ExperimentRecord;
  window: "baseline" | "post";
  queries: QueryRecord[];
  poolFor: (query: QueryRecord) => CandidatePage[];  // pools MUST contain the arm pages
  registry: EngineRegistry;
  apiKeys: Partial<Record<Engine, string>>;
  ts: number;
  kInitial?: number; kMax?: number; threshold?: number; focusDomains?: string[];
  model?: string; fetchImpl?: typeof fetch;
}): Promise<ExperimentWindowResult>;
```

Algorithm: for each query, `measureAdaptive(...)` with the SAME config (this is the identical-arm guarantee — both arms ride the same pass); concat rows + query-tagged failures; `tagExperimentRows(allRows, window, experiment.id)`; partition tagged rows by `classifyArm(row.page_url, experiment)`.

**Tests** (`tests/experiment.test.ts`, fake registry, no network):
- `tagExperimentRows`: sets window_tag + experiment_id on every row, leaves other fields intact, does NOT mutate the input array/objects; works for baseline and post.
- `reMeasureExperimentWindow`: every returned row carries the window + experiment_id; treatment_page rows land in `byArm.treatment`, control_page rows in `byArm.control`, a competitor pool page in neither bucket (but present in `rows`).
- **identical-arm protocol**: assert treatment & control pages were measured by the same engines and same K (e.g. both arms have rows for every target engine; their run_idx ranges match) — i.e. one shared pass, not two asymmetric ones.
- per-engine separation preserved; a throwing engine → failure tagged with query_id, other engines/arms still measured.
- baseline vs post produce correctly-tagged row sets (a baseline call then a post call → disjoint window_tag values).

---

## Verification (final gate — human)

1. `npm run typecheck` clean.
2. `npm test` — prior 184 + new green.
3. (No live capstone needed — re-measurement just re-tags the same measurement path already live-proven in P2·3.)

## File manifest (all NEW) — build order

| File | Phase | Depends on |
|---|---|---|
| `src/experiment-records.ts` + `tests/experiment-records.test.ts` | Records | types only |
| `src/experiment.ts` + `tests/experiment.test.ts` | Orchestration | experiment-records, adaptive, contract-records, dispatch types |

`experiment.ts` imports `ExperimentRecord`/`classifyArm` from `experiment-records.ts`, so Records lands first, then Orchestration. Each agent runs only its own test file; project-wide typecheck + full suite at the end.
