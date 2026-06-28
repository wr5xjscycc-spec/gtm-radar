# Packaging — `gtm-radar-analysis` (open methodology core)

This package open-sources the **measurement + experiment methodology core** of P4.
The algorithm is open; the data and the loop are the moat and are **not shipped**.

> "The moat is the data + loop, not the algorithm."
> — P4 Phase 6, task 2

## What's open (shipped in the wheel)

The `src` package — the measurement + experiment methodology:

| Module           | Role                                                              |
| ---------------- | ---------------------------------------------------------------- |
| `src.assembly`   | Assemble analysis rows from inputs                                |
| `src.matching`   | Candidate / comparison matching                                  |
| `src.features`   | Feature construction                                              |
| `src.labeling`   | Winner / loser labeling                                          |
| `src.rows`       | Row schema + transforms                                          |
| `src.bayes`      | Bayesian hypothesis generator (PyMC)                             |
| `src.hypotheses` | Hypothesis ranking / selection                                  |
| `src.did`        | Randomized difference-in-differences causal-lift engine (OLS)   |
| `src.experiment` | Experiment design / randomization math                          |
| `src.delivery`   | 3-tier delivery routing                                         |
| `src.moat`       | Moat record writer (the causal `lift_result`)                   |
| `src.contract`   | Typed I/O contract (Pydantic)                                   |

Also present in the source tree but treated as soft/optional, not part of the
shipped core methodology:

- `src.baseline` — a scikit-learn baseline **yardstick** for evaluation only.
  `scikit-learn` is therefore an optional (`[test]`) dependency, not a core one.
- `src.service` — a FastAPI HTTP wrapper. Lives behind the `[service]` extra.

## What's proprietary (NOT shipped — the moat)

These are intentionally excluded and live **outside this repo**:

- The **live interventional dataset** (the real experiment results / causal records).
- The **vertical packs** (domain-specific configuration / priors).
- The **orchestration loop** (the closed measure → hypothesize → experiment → deliver loop).

Concretely, the build excludes the test suite and the
seed/interventional-style fixtures (`tests*`, `tests/fixtures*`) so no moat data
ever lands in a distribution. This is enforced in `pyproject.toml` under
`[tool.setuptools.packages.find]` and asserted in `tests/test_packaging.py`.

## Dependencies

Core runtime (installed automatically):

- `numpy`, `pandas` — row assembly, features, experiment math
- `statsmodels` — the randomized-DiD OLS fit
- `pymc` — the Bayesian hypothesis model (pulls `pytensor`)
- `pydantic` — the typed I/O contract

### Extras

| Extra       | Install                                  | Adds                                          |
| ----------- | ---------------------------------------- | --------------------------------------------- |
| `[service]` | `pip install gtm-radar-analysis[service]`| `fastapi`, `uvicorn`, `httpx` (HTTP wrapper)  |
| `[test]`    | `pip install gtm-radar-analysis[test]`   | `pytest`, `scikit-learn`, `fastapi`, `httpx`  |

## Build

From the `analysis/` directory:

```bash
python -m pip install build       # one-time, if not already present
python -m build                   # produces dist/*.whl and dist/*.tar.gz
```

This emits an sdist (`.tar.gz`) and a wheel (`.whl`) under `dist/`.

## Install

```bash
# core methodology only
pip install dist/gtm_radar_analysis-*.whl

# with the HTTP service wrapper
pip install "dist/gtm_radar_analysis-*.whl[service]"

# from source for development + tests
pip install -e ".[test]"
```

After install, the methodology is importable as `import src` (e.g.
`from src.did import ...`, `from src.bayes import ...`). The `pythonpath = ["."]`
pytest setting keeps that same import path working for the test suite without an
install.
