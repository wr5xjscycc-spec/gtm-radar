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

from src.contract import Engine, Intervention, LiftResult


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
