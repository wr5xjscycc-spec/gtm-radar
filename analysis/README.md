# analysis/ — Lane P4 (Intelligence & Loop)

The protected core (separate Python service, called by a Convex action): the **Bayesian hypothesis generator** (honest, uncertainty-flagged), the **randomized matched-pair difference-in-differences experiment engine**, the **interventional dataset** (the moat), plus asset generation + 3-tier delivery + CMS publish.

- Brief: [`../docs/phase-cards/P4-Intelligence-and-Loop.md`](../docs/phase-cards/P4-Intelligence-and-Loop.md)
- Writes `model_fit`, `experiment`, `lift_result`, `intervention` (see `../docs/CONTRACT.md`).
- Tests: `pip install -r requirements.txt && pytest` (run from repo root: `pytest analysis`).
- **Stats are tested on synthetic data with known ground truth** — that's how we prove honesty.
- Non-negotiables: correlation≠causation (no causal output without a `lift_result`); effective N = #companies.

## Phase 0 — the analysis service (Convex ⇄ Python contract)

A small **FastAPI** service a Convex action calls over HTTP. The fit compute is a
Phase-0 **stub** (`src/dummy.py`); Phase 4 swaps in the real Bayesian generator
behind the same wire contract.

**Run locally**

```
cd analysis
python -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn src.service:app --reload   # http://127.0.0.1:8000  (docs at /docs)
```

**HTTP contract** (for P1's Convex action — designed **async** because real fits are slow):

| Method | Path | Body / returns |
|---|---|---|
| `GET` | `/health` | `{status, service, version}` |
| `POST` | `/fit` | body = `FitRequest`; returns `FitJob` (`status:"queued"`), HTTP 202 |
| `GET` | `/fit/{job_id}` | returns `FitJob`; `result` (a `model_fit`) populated once `status:"complete"` |

The Convex action: build a `FitRequest` → `POST /fit` → poll `GET /fit/{job_id}` →
on `complete`, write `result` back as the `model_fit` record. Typed shapes
(`FitRequest`/`FitRow`/`ModelFit`/`Coefficient`/`FitJob`) live in `src/contract.py`;
a seed request fixture is at `tests/fixtures/fit_request.json`. The mocked
round-trip lives in `tests/test_roundtrip.py`.

## The pipeline (Phases 1–5)

`measurement`+`page`+`company` → `assembly` (per-engine page rows, effective N) →
`features` (content+off-page, inheritance check) → `matching` (cross-cluster pairs)
→ `labeling`/`rows` (case-control, per-category/engine tables) → `bayes` (honest
hypothesis generator) → `hypotheses` (Rung-1) → `experiment` (randomized design) →
`did` (causal lift + CI) → `delivery` (3-tier) → `moat` (interventional dataset).

## Open source & honesty (Phase 6)

- **OSS methodology core** — `PACKAGING.md`. The algorithm is open; the
  interventional dataset, vertical packs, and orchestration are not shipped (the
  moat is the data + loop). Build: `python -m build`.
- **Honesty audit** — `src/honesty.py` enforces the epistemic ladder:
  `measurement` (descriptive) ≠ `model_fit` (hypothesis, Rung 1) ≠ `lift_result`
  (causal, Rung 2). `assert_no_causation_without_experiment` is the load-bearing
  guard — a causal claim requires a `lift_result` from the randomized DiD path.
- **Scale path** — `SCALE.md`: hierarchical graduation (≥15 categories / ≥300
  companies) and the deferred AI-Overviews capture (ToS risk, out of v1).
