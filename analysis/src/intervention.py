"""Intervention moat store — record completed experiments as moat entries.

Each row is a recorded causal link:
    (feature_changed × category × engine → measured_lift + CI)

This is the defensible dataset that compounds over time.
"""

from datetime import datetime, timezone

from src.models import Intervention, LiftResult


def record_intervention(
    lift_result: LiftResult,
    category: str,
    engine: str,
    feature_changed: str,
) -> Intervention:
    """Create an intervention row from a completed experiment.

    Parameters
    ----------
    lift_result : LiftResult
        The causal estimate from the DiD.
    category : str
        Content category.
    engine : str
        Answer engine.
    feature_changed : str
        The feature that was modified (e.g. "comparison_table",
        "offpage.g2_presence").

    Returns
    -------
    Intervention with recorded lift and CI.
    """
    return Intervention(
        feature_changed=feature_changed,
        category=category,
        engine=engine,
        measured_lift=lift_result.estimate,
        ci_low=lift_result.ci_low,
        ci_high=lift_result.ci_high,
        experiment_id=lift_result.experiment_id,
    )
