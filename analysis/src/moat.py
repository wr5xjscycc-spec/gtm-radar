"""The interventional dataset — the moat (P4 Phase 5, task 6).

Each completed randomized experiment yields one ``intervention`` row:
``feature_changed × category × engine → measured_lift`` with its CI, sourced
from the experiment's ``lift_result`` (the only Rung-2 causal record). Banked
together these rows are the compounding proprietary dataset — measured causal
lifts no competitor has — that the 3-round red-team converged on as the real
moat (the data + loop, not the algorithm).

The production store is Convex; here it is an in-memory list so the write path is
testable without a database. No external calls in this module.
"""

from __future__ import annotations

import math

from src.contract import Engine, Intervention, LiftResult

# z for a 90% (two-sided) normal interval — the CI convention every intervention
# row and the pooled estimate are expressed in.
_Z_90 = 1.645
# Floor for a per-row standard error so a zero-width CI (se == 0) doesn't divide by
# zero / send the inverse-variance weight to infinity.
_SE_EPS = 1e-6


def should_record(lift_result: LiftResult) -> bool:
    """Whether to bank this result as an intervention.

    Choice: **record every measured result, including ``inconclusive``.** An
    honestly-measured null or "can't tell yet at this N" is itself proprietary
    signal — it tells us (and only us) that changing this feature did not move the
    needle in this category/engine, which is exactly the kind of data the moat
    compounds. Silently dropping inconclusive runs would bias the dataset toward
    only-wins and quietly overstate what works. So we never drop a measured run.
    """
    return True


def record_intervention(
    *,
    lift_result: LiftResult,
    feature_changed: str,
    category: str,
    engine: Engine,
    intervention_id: str,
    recorded_at: str,
) -> Intervention:
    """Build an ``Intervention`` from a completed experiment's ``LiftResult``.

    ``measured_lift`` and the CI come straight from the lift result (the causal
    estimate), and ``experiment_id`` is carried through so the moat row stays
    traceable back to the randomized experiment that earned it.
    """
    return Intervention(
        id=intervention_id,
        feature_changed=feature_changed,
        category=category,
        engine=engine,
        measured_lift=lift_result.estimate,
        ci_low=lift_result.ci_low,
        ci_high=lift_result.ci_high,
        experiment_id=lift_result.experiment_id,
        recorded_at=recorded_at,
    )


def append_intervention(store: list, intervention: Intervention) -> list:
    """Append an intervention to the in-memory moat store and return it.

    Stand-in for the Convex write. The store is the compounding proprietary
    dataset: each appended row makes it more valuable, so appends accumulate and
    nothing is overwritten.
    """
    store.append(intervention)
    return store


def aggregate_interventions(
    interventions: list[Intervention],
    *,
    category: str,
    engine: str | None = None,
) -> dict[str, dict]:
    """Pool banked interventions into per-feature empirical measured-lift means.

    This is the READ side of the moat — the values that close the loop by feeding
    back into the next Bayesian fit as informative ``prior_means`` (see
    :func:`src.bayes.fit_bayesian_logistic`). The Convex side mirrors this exact
    computation to ship the priors over the wire; keeping a pure-Python reference
    here makes the pooling testable and keeps the two implementations honest.

    Pooling is a **fixed-effects inverse-variance meta-analysis** (the standard way
    to combine several independent measured effects of the *same* feature): a row
    measured with a tight CI is more certain, so it gets more weight than a row with
    a wide CI. Per row, from its 90% CI:

        se      = (ci_high - ci_low) / (2 * 1.645)     # 90% CI half-width / z
        weight  = 1 / se**2                            # inverse variance

    (``se`` is floored at a small epsilon so a zero-width CI can't divide by zero.)
    Pooled over the rows for one feature:

        mean_lift = Σ(w · lift) / Σw
        pooled_se = sqrt(1 / Σw)
        90% CI    = mean_lift ± 1.645 · pooled_se

    Rows are filtered to ``category`` (engines are never pooled, so also to ``engine``
    when one is given — ``None`` means "any engine"). Returns
    ``{feature: {"n", "mean_lift", "ci_low", "ci_high"}}``; an empty/all-filtered-out
    input returns ``{}``.
    """
    by_feature: dict[str, list[Intervention]] = {}
    for iv in interventions:
        if iv.category != category:
            continue
        if engine is not None and iv.engine != engine:
            continue
        by_feature.setdefault(iv.feature_changed, []).append(iv)

    out: dict[str, dict] = {}
    for feature, rows in by_feature.items():
        sum_w = 0.0
        sum_w_lift = 0.0
        for iv in rows:
            se = (iv.ci_high - iv.ci_low) / (2.0 * _Z_90)
            se = max(se, _SE_EPS)  # guard a zero-width (perfectly certain) CI
            w = 1.0 / (se * se)
            sum_w += w
            sum_w_lift += w * iv.measured_lift

        pooled_mean = sum_w_lift / sum_w
        pooled_se = math.sqrt(1.0 / sum_w)
        out[feature] = {
            "n": len(rows),
            "mean_lift": pooled_mean,
            "ci_low": pooled_mean - _Z_90 * pooled_se,
            "ci_high": pooled_mean + _Z_90 * pooled_se,
        }
    return out
