# Session Handoff — GTM Radar build state

Read this at the start of a new session before touching any code.

## Where we are

**Repo:** `C:\Users\raj_k\yc\gtm-radar` · **Working branch:** `p2/phase-5-experiment-remeasure`

Branches built so far (P2·0 + all below now pushed to origin):

| Branch | Remote | Phase |
|---|---|---|
| `p2/phase-0-openai-citation` | ✅ pushed | P2·0 — OpenAI adapter + citation parser + row builder |
| `p2/phase-2-dispatch-labeling` | ✅ pushed | P2·1 cost constants + P2·2 dispatch / labeling / pipeline |
| `p2/phase-3-statistics` | ✅ pushed | P2·3 — Wilson CI, per-engine aggregation, adaptive-K + one-key 3-engine backing |
| `p2/phase-4-label-quality` | ✅ pushed | P2·4 — flip-rate QA, label table, pool-composition |
| `p2/phase-6-cost-guards` | ✅ pushed | P2·6 — retry/backoff, drift detection, budget guard, resumable sweep |
| `p2/phase-5-experiment-remeasure` | ✅ pushed | **P2·5 — window tagging + identical-arm re-measurement (CURRENT)** |
| `p1/phase-0-thin-slice` | ❌ local only | Convex schema + seed (deprioritized — see below) |

Stack order: `p2/phase-5-experiment-remeasure` → `p2/phase-6-cost-guards` → `p2/phase-4-label-quality` → `p2/phase-3-statistics` → `p2/phase-2-dispatch-labeling` → `p2/phase-0-openai-citation`. `p1/phase-0-thin-slice` branches off P2·0 separately.

`main` is the original scaffold. **CI has STILL never actually run** — branches are pushed but no PR is open, and CI only triggers on push-to-`main` or `pull_request` (deliberately not triggered yet, per user). **202 measurement tests pass locally on Node 24** (typecheck clean); other lanes verified CI-ready (platform 1, sourcing 1, python smoke 1 — all green locally; CI uses Node 20 / Python 3.12).

## What was built (P2·5) — `p2/phase-5-experiment-remeasure`

Spec: `docs/superpowers/specs/2026-06-28-p2-5-experiment-remeasure-design.md`. Built against an `experiment`-record **fixture** (CONTRACT §7; P4 not yet built — drops onto real data unchanged). 18 new tests:

| File | What |
|---|---|
| `experiment-records.ts` | `ExperimentRecord` projection (CONTRACT §7) + `classifyArm(url, exp)` → `treatment\|control\|null` (exact-match, treatment precedence). |
| `experiment.ts` | `tagExperimentRows(rows, window, expId)` (pure, non-mutating: stamps `window_tag` baseline/post + `experiment_id`) + `reMeasureExperimentWindow(...)` — **one shared `measureAdaptive` pass per query** so treatment & control ride the SAME engines/K/pool. The identical-arm protocol is structural (the #1 DiD confound, neutralized). Partitions tagged rows by arm; query-tagged failures. |

Re-tag-after-measurement keeps the core untouched. Ready for P4's DiD: it consumes the `baseline`/`post`-tagged, `experiment_id`-stamped rows. (P2·5 was originally flagged as blocked on P4 — built against the contract fixture per the contract's own prescription for cross-lane deps.)

## What was built (P2·6) — `p2/phase-6-cost-guards`

Spec: `docs/superpowers/specs/2026-06-28-p2-6-cost-guards-design.md`. Four modules (40 new tests) delivering the P2·6 DoD (sweep stays in budget, survives an engine failing, flags drift):

| File | What |
|---|---|
| `reliability/retry.ts` | `withRetry(fn, opts)` — exp-backoff on retryable errors (429/5xx/network), injectable `sleep`, deterministic schedule `[500,1000,2000]`. |
| `quality/drift.ts` | `detectModelDrift(rows)` — flags `(query,engine)` groups spanning >1 `model_version` (polluted aggregation) + per-engine versions across the sweep. |
| `cost/budget.ts` | `makeBudgetGuard({ceilingUSD})` — live spend tracking + `canAfford` reservation (closure, no class) + `worstCaseCalls`. |
| `sweep.ts` | `runSweep(...)` — resumable **PAUSE-THEN-CONTINUE** sweep (your chosen budget posture). Reserves worst-case (kMax) per query **before** starting, records actual (≤ reserve) after ⇒ ceiling **can't** be overrun. Pauses at a query boundary, returns a `checkpoint`; resume with a fresh window. Wraps registry in `withRetry`; reports coverage / spend / drift / query-tagged failures. |

Budget posture = pause/checkpoint, **not** degrade — every persisted query is full-quality (full K, all engines). Per-engine never merged; all NaN-guarded. **Optional live capstone not run** — a tiny low-ceiling 2-query sweep would demo a real pause + resume (~$0.10–0.30, uses `OPENAI_API_KEY`).

## What was built (P2·4) — `p2/phase-4-label-quality`

Spec: `docs/superpowers/specs/2026-06-28-p2-4-label-quality-design.md`. Three pure analyses over P2·3 outputs (38 new tests), for P4 + honest noise reporting:

| File | What |
|---|---|
| `quality/flip-rate.ts` | `computeFlipRates(rows)` → per-engine instability. Integrates **3 lenses** per (query,page,engine): `minority_fraction` (primary, order-free), `transition_rate` (run_idx-ordered, informational), binary `entropy` (bits). Reports `flip_fraction` + means + worst-first `unstable[]`. k<2 groups surfaced + excluded from means. |
| `quality/label-table.ts` | `buildLabelTable(aggregates, pool)` joins on `page_url` → rows keyed on normalized `company_domain` + `role` for P4. Rate+CI primary, winner/loser `label` secondary (≥0.5→winner). Join misses → `unmatched` (surfaced, never dropped). |
| `quality/pool-composition.ts` | `assessPoolComposition(pool)` → per-domain share, `dominated` + `offenders` (strict `>` threshold, default 0.5). Guards "loser pool dominated by one company". |

Per-engine never merged; normalized domain is the join key; all NaN-guarded. **Optional live capstone not yet run** — feed real K≥4 run-level rows into `computeFlipRates` for a demo flip-rate number (the P2·3 live run already showed a genuine flip: openai/apollo.io cited 2/3).

## What was built (P2·3) — `p2/phase-3-statistics`

Spec: `docs/superpowers/specs/2026-06-27-p2-3-statistics-design.md` (authoritative contract).

### Statistics layer — `measurement/src/` (all pure, TDD)

| File | What |
|---|---|
| `stats/wilson.ts` | Wilson score interval `wilsonInterval(successes, n, z=1.96)` — correct at small K / near 0,1 (where the normal approx fails). n=0 → {0,1}. |
| `stats/aggregate.ts` | `aggregateRuns(rows)` groups run-level rows by `(query_id, page_url, engine)` → `MeasurementAggregate { k, cited_count, p_cited, ci_low, ci_high, position_weight, … }`. position_weight = mean reciprocal-rank over **cited runs only** (orthogonal to p_cited). **Per-engine never merged.** |
| `sampling/adaptive.ts` | `anyAmbiguous(aggs, opts)` straddle-τ decision + `measureAdaptive(...)` loop. |
| `engines/openai-backed.ts` | One-key 3-engine backing (see below). |
| `cost.ts` | + `realizedCostUSD(calls)` and `adaptiveSavingsUSD(...)`. |

### The two load-bearing decisions

1. **Adaptive K is per-(query, engine), NOT per-page.** One query call labels the whole candidate pool at once, so you can't sample one page more without re-running the query. Extend K while ANY in-focus page is unresolved; stop the whole engine when none are. Default kInitial=3, kMax=8.
2. **Stopping rule = CI straddles τ (default 0.5), NOT symmetric CI width.** A width rule pins every never-cited page (which dominate the "0 of N cited" pool by construction) to kMax and kills the −40–50% cost lever. Under straddle-0.5, clear pages (cited-always or never-cited) resolve at K≈4; only genuine mid-rate pages reach kMax. **Regression-guarded** by the adaptive test (never-cited → exactly 4 calls; coin-flip → 8). Do not revert to a width rule.

### One-key three-engine backing (`engines/openai-backed.ts`)

The `perplexity` and `gemini` engine **slots are backed by OpenAI** until real keys arrive, so the full 3-engine pipeline runs from a single `OPENAI_API_KEY`. `makeOpenAIBackedAdapter({engine, model})` wraps `runOpenAIQuery` (openai.ts is **not** edited), binds a model, and overrides the engine **label** — but `model_version` stays the real API value (so the stand-in is self-evident in the data and drift detection stays real).

`ENGINE_MODELS` (all **live-smoke-verified**: HTTP 200, web_search tool accepted, url_citation returned):
- `openai` → `gpt-5` (resolves `gpt-5-2025-08-07`)
- `perplexity` → `gpt-5-mini` (resolves `gpt-5-mini-2025-08-07`)
- `gemini` → `gpt-5-nano` (resolves `gpt-5-nano-2025-08-07`)

`DEFAULT_REGISTRY` (in dispatch.ts) stays honest (openai only). To go real later, swap in real Perplexity/Gemini adapters in the registry — **nothing else changes**. `buildOpenAIBackedRegistry()` + `spreadOpenAIKey(key)` wire the stand-in path.

**Sharp edge:** `measureAdaptive`'s `model` param is silently ignored by the backed adapters (each slot's bound model wins). A caller passing `model:"gpt-4o"` to the backed registry is still billed for gpt-5/mini/nano.

### Live integration

`measurement/scripts/p2-3-live.ts` runs `measureAdaptive` over one real query across all 3 backed slots (`OPENAI_API_KEY=… npx tsx scripts/p2-3-live.ts`). gpt-5 + web_search is slow (~30–60s/call), so 3 engines × K runs several minutes.

**Verified live (2026-06-28, query "best B2B sales lead enrichment platforms 2026", pool apollo/clay/zoominfo/seraleads, kInitial=2 kMax=3, ~$0.18):** all 3 slots ran, 0 failures, distinct real `model_version`s, per-engine aggregates intact. Engines genuinely disagree (clay.com: openai P=1.00 / perplexity P=0.00 / gemini P=0.33). The "customer" seraleads.com cited **0/3 on every engine** — the gut-punch is real. `savedPct=0` was expected here: kMax=3 leaves no headroom above the K≈4 resolution point, so the adaptive loop extended every page to the cap (savings behavior is proven by the unit tests at full K, not this cost-capped run).

## 🚧 Convex (deprioritized — skip unless asked)

P1 thin-slice (`convex/`) schema + functions + `seed-data.json` are scaffolded but Convex was deprioritized. First run needs an interactive `npx convex dev` browser login (only the user can do it). Steps in `convex/README.md`. The React board (`platform/`) is blocked on this. Untracked `convex/_generated/` + `convex/*.js` artifacts exist in the working tree (gitignore them before committing convex work).

## What's next (options)

1. **Push branches + open PRs / get CI green** — nothing is on `origin` except P2·0; CI (Node 20) has never run on anything. Lowest-risk next move now that there are 106 tests to protect.
2. **React board** (`platform/`) — blocked on Convex login (deprioritized).
3. **P3 lane** — Fiber battlefield + Orange Slice enrichment. Needs `FIBER_API_KEY`, `ORANGESLICE_API_KEY`, `SERP_API_KEY` (not yet provided — ask).
4. **P2·6** — budget caps / per-engine isolation / drift detection (builds on the adaptive loop; uses `OPENAI_API_KEY` already in `.env`).

## Keys / secrets

- `OPENAI_API_KEY` — in `.env` (gitignored). All gen-5 models above verified working. **User should rotate** (was pasted in chat history).
- Perplexity, Gemini, Fiber, Orange Slice — not yet provided; currently stood in by OpenAI for perplexity/gemini. Ask before P3 work.

## Orientation order for a new session

1. Read this file
2. `docs/ARCHITECTURE.md` (system + tool inventory)
3. `docs/CONTRACT.md` (the 9 Convex records — the cross-lane interface)
4. `docs/phase-cards/P2-Measurement-Engine.md` + `docs/phase-cards/P1-Platform-and-Experience.md`
5. `docs/superpowers/specs/2026-06-27-p2-3-statistics-design.md` (P2·3 spec)
