"""Phase-5 difference-in-differences estimator — the causal layer (the moat).

This module turns a randomized ship-vs-hold ``Experiment`` and P2's windowed
``measurement`` rows into a single :class:`~src.contract.LiftResult` (``claim_rung``
== 2). It is the **only** place in P4 allowed to speak causally, and only because
the estimate comes from the randomized DiD path, never from observational
coefficients. Read these guardrails as part of the API:

- **Why DiD and not pre/post (fact #5).** A single-group before/after is
  confounded by model drift, seasonality, and the customer's other SEO. DiD
  subtracts the control arm's pre→post movement from the treatment arm's, so any
  shock common to both arms cancels. The estimand is the ``treatment:post``
  interaction.
- **Why page-clustered SEs (fact #2 / pseudo-replication).** The repeated unit is
  the *page*: a page is observed many times (queries × weeks × runs) in each
  window. Treating those as independent overstates N. We cluster the standard
  errors on the page so inference respects the real number of independent units.
- **Why ``inconclusive`` at small N (honesty is the point).** At a handful of
  pairs the cluster SE is huge by construction (df = n_pages − 1). We return
  ``inconclusive`` rather than fabricate a worked/no_effect call from too little
  data. We never emit a positive verdict the data cannot support.

Fixed-effects specification (statsmodels OLS):

    outcome ~ treatment:post + C(page) + C(period)

The **page** fixed effects absorb the ``treatment`` main effect (it is
time-invariant within a page) and every time-invariant page difference; the
**period** fixed effects absorb the ``post`` main effect (the common time shock)
and any week-to-week drift. That is why the formula carries only the interaction:
the two main effects of the textbook ``treatment*post`` form are collinear with
the fixed effects, so writing them out only makes the design rank-deficient. The
surviving ``treatment:post`` coefficient is the DiD estimate. ``period`` is always
nested inside the window (``window_tag`` prefixed onto any finer week id) so that
``post`` is guaranteed constant within a period and is cleanly absorbed.

Verdict rule (documented exactly, because honesty is the deliverable):

- Degenerate panel (missing a window, only one arm, no within-arm variation),
  a failed/singular fit, fewer than ``min_pairs_for_power`` complete pairs, or a
  CI wider than ``max_ci_width`` -> ``inconclusive`` (the honest "can't tell yet").
- ``worked`` when the (1-alpha) CI excludes 0 on the positive side (``ci_low > 0``).
- ``no_effect`` when, with adequate power, the CI's upper bound is at or below
  ``min_detectable_lift`` — i.e. we can rule out a *meaningful* positive lift.
  This deliberately also covers a clearly-negative effect (the change did not help).
- Otherwise ``inconclusive`` — the CI still admits a meaningful positive lift but
  does not confirm one.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

import numpy as np
import pandas as pd
import statsmodels.formula.api as smf

from .contract import Experiment, LiftResult, Verdict

# A DiD on a rate (P_cited in [0,1]) lives in roughly [-1, 1]; a CI wider than this
# spans the whole plausible range and is therefore uninformative.
_DEGENERATE_CI = (-1.0, 1.0)


def _outcome(row: dict) -> Optional[float]:
    """Citation-rate outcome for one measurement row.

    Prefer the aggregate ``P_cited`` (a rate over K runs); fall back to the raw
    ``cited`` boolean (0/1) when no aggregate is present. Either way the regression
    sees a rate and the page clustering handles the repeated observations.
    """
    for key in ("P_cited", "p_cited"):
        if row.get(key) is not None:
            return float(row[key])
    if row.get("cited") is not None:
        return float(bool(row["cited"]))
    return None


def _period_key(row: dict) -> str:
    """Time fixed-effect key, always nested inside the window.

    We prefix the ``window_tag`` so every period belongs to exactly one window —
    this guarantees ``post`` is constant within a period and is absorbed by the
    period FE. The finer part is an explicit ``period`` field, else the ISO week of
    ``ts``, else a single bucket (collapsing to the canonical 2-period DiD).
    """
    window = str(row.get("window_tag"))
    fine = row.get("period")
    if fine is None:
        ts = row.get("ts")
        if ts:
            try:
                dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
                iso = dt.isocalendar()
                fine = f"{iso[0]}-W{iso[1]:02d}"
            except ValueError:
                fine = None
    if fine is None:
        fine = "0"
    return f"{window}:{fine}"


def _result(
    *,
    lift_id: str,
    experiment_id: str,
    estimate: float,
    ci_low: float,
    ci_high: float,
    p_value: Optional[float],
    verdict: Verdict,
    computed_at: str,
) -> LiftResult:
    return LiftResult(
        id=lift_id,
        experiment_id=experiment_id,
        estimate=estimate,
        ci_low=ci_low,
        ci_high=ci_high,
        p_value=p_value,
        verdict=verdict,
        computed_at=computed_at,
    )


def _inconclusive(
    *,
    lift_id: str,
    experiment_id: str,
    computed_at: str,
    estimate: float = 0.0,
    ci: tuple[float, float] = _DEGENERATE_CI,
    p_value: Optional[float] = None,
) -> LiftResult:
    """An honest ``inconclusive`` result. The default wide CI says, literally, that
    the whole plausible range is still on the table — we know nothing yet."""
    est = float(estimate) if np.isfinite(estimate) else 0.0
    return _result(
        lift_id=lift_id,
        experiment_id=experiment_id,
        estimate=est,
        ci_low=ci[0],
        ci_high=ci[1],
        p_value=p_value,
        verdict="inconclusive",
        computed_at=computed_at,
    )


def _simple_did(df: pd.DataFrame) -> float:
    """Group-means DiD point estimate (no inference). Used to report a best-effort
    number even when the panel is too thin to fit a clustered model."""

    def cell(t: int, p: int) -> float:
        sub = df[(df["treatment"] == t) & (df["post"] == p)]
        return float(sub["outcome"].mean()) if len(sub) else float("nan")

    return (cell(1, 1) - cell(1, 0)) - (cell(0, 1) - cell(0, 0))


def estimate_lift(
    experiment: Experiment,
    measurements: list[dict],
    *,
    engine: str,
    computed_at: str,
    lift_id: str,
    min_pairs_for_power: int = 4,
    alpha: float = 0.10,
    min_detectable_lift: float = 0.05,
    max_ci_width: float = 1.0,
) -> LiftResult:
    """Estimate causal citation-rate lift via randomized matched-pair DiD.

    Builds a page×window panel from ``measurements`` (filtered to ``engine`` and to
    the experiment's pages), fits ``outcome ~ treatment:post + C(page) + C(period)``
    by OLS with page-clustered SEs, and returns a ``LiftResult`` with a (1-alpha)
    CI. Never crashes on a degenerate panel — it returns ``inconclusive`` instead.
    """
    pairs = experiment.pairs
    treatment_pages = {p.treatment_page for p in pairs}
    control_pages = {p.control_page for p in pairs}
    all_pages = treatment_pages | control_pages

    def incon(estimate: float = 0.0, ci: tuple[float, float] = _DEGENERATE_CI,
              p_value: Optional[float] = None) -> LiftResult:
        return _inconclusive(
            lift_id=lift_id,
            experiment_id=experiment.id,
            computed_at=computed_at,
            estimate=estimate,
            ci=ci,
            p_value=p_value,
        )

    if not all_pages:
        return incon()

    # --- assemble the long panel ---------------------------------------------
    records: list[dict] = []
    for row in measurements:
        if row.get("engine") != engine:
            continue
        page = row.get("page_url")
        if page not in all_pages:
            continue
        window = row.get("window_tag")
        if window not in ("baseline", "post"):
            continue
        y = _outcome(row)
        if y is None or not np.isfinite(y):
            continue  # drop NaN outcomes up front so groups stay aligned with the design
        records.append(
            {
                "page": page,
                "outcome": float(y),
                "treatment": 1 if page in treatment_pages else 0,
                "post": 1 if window == "post" else 0,
                "period": _period_key(row),
            }
        )

    if not records:
        return incon()
    df = pd.DataFrame.from_records(records).reset_index(drop=True)

    # --- degeneracy guards ----------------------------------------------------
    # Need both windows and both arms with observed variation, else DiD is undefined.
    if df["post"].nunique() < 2 or df["treatment"].nunique() < 2:
        return incon()

    point = _simple_did(df)

    # Effective power = complete pairs (both pages seen in BOTH windows).
    seen = {(p, w) for p, w in zip(df["page"], df["post"])}
    complete_pairs = sum(
        1
        for pr in pairs
        if {(pr.treatment_page, 0), (pr.treatment_page, 1),
            (pr.control_page, 0), (pr.control_page, 1)} <= seen
    )
    if complete_pairs < min_pairs_for_power:
        # Too few pairs: report the best-effort point estimate but be honest that
        # we have no power — a wide CI, never a worked/no_effect call.
        return incon(estimate=point)

    # --- clustered DiD fit ----------------------------------------------------
    try:
        model = smf.ols("outcome ~ treatment:post + C(page) + C(period)", data=df)
        res = model.fit(cov_type="cluster", cov_kwds={"groups": df["page"]})
    except Exception:
        return incon(estimate=point)

    term = next((name for name in res.params.index
                 if "treatment" in name and "post" in name), None)
    if term is None:
        return incon(estimate=point)

    estimate = float(res.params[term])
    p_value = float(res.pvalues[term])
    ci = res.conf_int(alpha=alpha).loc[term]
    ci_low, ci_high = float(ci.iloc[0]), float(ci.iloc[1])

    if not all(np.isfinite(v) for v in (estimate, ci_low, ci_high)):
        return incon(estimate=point)

    # --- verdict --------------------------------------------------------------
    if (ci_high - ci_low) > max_ci_width:
        # CI spans most of the plausible range -> underpowered, can't tell.
        return incon(estimate=estimate, ci=(ci_low, ci_high), p_value=p_value)

    if ci_low > 0.0:
        verdict: Verdict = "worked"  # CI excludes 0 on the positive side
    elif ci_high <= min_detectable_lift:
        verdict = "no_effect"  # adequate power, a meaningful positive lift is ruled out
    else:
        verdict = "inconclusive"  # CI still admits a meaningful positive lift

    return _result(
        lift_id=lift_id,
        experiment_id=experiment.id,
        estimate=estimate,
        ci_low=ci_low,
        ci_high=ci_high,
        p_value=p_value,
        verdict=verdict,
        computed_at=computed_at,
    )
