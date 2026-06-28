"""Moat (interventional dataset) write tests (P4 Phase 5, task 6)."""

from __future__ import annotations

from src.contract import Intervention, LiftResult
from src.moat import (
    aggregate_interventions,
    append_intervention,
    record_intervention,
    should_record,
)


def _iv(
    *,
    feature: str = "page__comparison_table",
    category: str = "observability",
    engine: str = "openai",
    measured_lift: float = 0.2,
    ci_low: float = 0.1,
    ci_high: float = 0.3,
    intervention_id: str = "iv",
) -> Intervention:
    """Build an Intervention row directly (bypassing a LiftResult) for pooling tests."""
    return Intervention(
        id=intervention_id,
        feature_changed=feature,
        category=category,
        engine=engine,  # type: ignore[arg-type]
        measured_lift=measured_lift,
        ci_low=ci_low,
        ci_high=ci_high,
        experiment_id=f"exp-{intervention_id}",
        recorded_at="2026-06-27T00:00:00Z",
    )


def _lift(
    *,
    experiment_id: str = "exp-1",
    estimate: float = 0.12,
    ci_low: float = 0.03,
    ci_high: float = 0.21,
    verdict: str = "worked",
) -> LiftResult:
    return LiftResult(
        id=f"lift-{experiment_id}",
        experiment_id=experiment_id,
        estimate=estimate,
        ci_low=ci_low,
        ci_high=ci_high,
        p_value=0.04,
        verdict=verdict,  # type: ignore[arg-type]
        computed_at="2026-06-27T00:00:00Z",
    )


def test_record_intervention_carries_values_from_lift_result():
    lift = _lift(experiment_id="exp-42", estimate=0.15, ci_low=0.05, ci_high=0.25)
    iv = record_intervention(
        lift_result=lift,
        feature_changed="page__comparison_table",
        category="observability",
        engine="openai",
        intervention_id="iv-1",
        recorded_at="2026-06-27T12:00:00Z",
    )

    assert isinstance(iv, Intervention)
    assert iv.measured_lift == lift.estimate == 0.15
    assert iv.ci_low == lift.ci_low == 0.05
    assert iv.ci_high == lift.ci_high == 0.25
    assert iv.experiment_id == lift.experiment_id == "exp-42"
    assert iv.feature_changed == "page__comparison_table"
    assert iv.category == "observability"
    assert iv.engine == "openai"
    assert iv.id == "iv-1"
    assert iv.recorded_at == "2026-06-27T12:00:00Z"


def test_append_intervention_grows_the_store():
    store: list[Intervention] = []

    iv1 = record_intervention(
        lift_result=_lift(experiment_id="exp-1"),
        feature_changed="page__comparison_table",
        category="observability",
        engine="openai",
        intervention_id="iv-1",
        recorded_at="2026-06-27T12:00:00Z",
    )
    returned = append_intervention(store, iv1)
    assert returned is store
    assert len(store) == 1

    iv2 = record_intervention(
        lift_result=_lift(experiment_id="exp-2"),
        feature_changed="company__g2_presence",
        category="observability",
        engine="gemini",
        intervention_id="iv-2",
        recorded_at="2026-06-27T13:00:00Z",
    )
    append_intervention(store, iv2)

    # the moat compounds: multiple appends accumulate distinct rows
    assert len(store) == 2
    assert [iv.experiment_id for iv in store] == ["exp-1", "exp-2"]


def test_should_record_keeps_inconclusive_results():
    # honest data: an inconclusive run is still proprietary signal, never dropped.
    assert should_record(_lift(verdict="inconclusive")) is True
    assert should_record(_lift(verdict="worked")) is True
    assert should_record(_lift(verdict="no_effect")) is True


# --- aggregate_interventions: the empirical-prior read side of the moat ---------
def test_aggregate_empty_returns_empty_dict():
    assert aggregate_interventions([], category="observability") == {}
    # also empty when nothing matches the category filter
    rows = [_iv(category="crm")]
    assert aggregate_interventions(rows, category="observability") == {}


def test_aggregate_single_row_passes_through():
    """A single symmetric-CI row pools to exactly itself (mean + reconstructed CI)."""
    rows = [_iv(measured_lift=0.2, ci_low=0.1, ci_high=0.3, intervention_id="a")]
    out = aggregate_interventions(rows, category="observability")

    assert set(out) == {"page__comparison_table"}
    agg = out["page__comparison_table"]
    assert agg["n"] == 1
    assert agg["mean_lift"] == 0.2
    # se = (0.3-0.1)/(2*1.645); pooled CI = mean ± 1.645*se == the original [0.1, 0.3].
    assert abs(agg["ci_low"] - 0.1) < 1e-9
    assert abs(agg["ci_high"] - 0.3) < 1e-9


def test_aggregate_tight_ci_row_dominates_wide_ci_row():
    """Inverse-variance weighting: a tight-CI measurement dominates a wide-CI one."""
    tight = _iv(measured_lift=1.0, ci_low=0.9, ci_high=1.1, intervention_id="tight")
    wide = _iv(measured_lift=0.0, ci_low=-2.0, ci_high=2.0, intervention_id="wide")
    out = aggregate_interventions([tight, wide], category="observability")

    agg = out["page__comparison_table"]
    assert agg["n"] == 2
    # Naive average would be 0.5; inverse-variance pooling sits ~1.0 (the tight row).
    assert agg["mean_lift"] > 0.9
    # Pooling two rows is more certain than either alone -> CI tighter than the tight row.
    assert (agg["ci_high"] - agg["ci_low"]) < (1.1 - 0.9)


def test_aggregate_filters_by_category_and_engine():
    rows = [
        _iv(feature="page__x", category="observability", engine="openai",
            measured_lift=0.5, intervention_id="a"),
        _iv(feature="page__x", category="observability", engine="gemini",
            measured_lift=0.9, intervention_id="b"),
        _iv(feature="page__x", category="crm", engine="openai",
            measured_lift=9.9, intervention_id="c"),
    ]

    # Category only: pools the two observability rows, excludes the crm row entirely.
    cat_only = aggregate_interventions(rows, category="observability")
    assert cat_only["page__x"]["n"] == 2

    # Category + engine: engines are never pooled -> only the openai observability row.
    eng = aggregate_interventions(rows, category="observability", engine="openai")
    assert eng["page__x"]["n"] == 1
    assert eng["page__x"]["mean_lift"] == 0.5


def test_aggregate_groups_distinct_features_separately():
    rows = [
        _iv(feature="page__a", measured_lift=0.3, intervention_id="a"),
        _iv(feature="page__b", measured_lift=-0.4, intervention_id="b"),
    ]
    out = aggregate_interventions(rows, category="observability")
    assert set(out) == {"page__a", "page__b"}
    assert out["page__a"]["mean_lift"] == 0.3
    assert out["page__b"]["mean_lift"] == -0.4


def test_aggregate_zero_width_ci_does_not_crash():
    """A perfectly-certain (zero-width) CI is epsilon-floored, never divides by zero."""
    rows = [_iv(measured_lift=0.7, ci_low=0.7, ci_high=0.7, intervention_id="z")]
    out = aggregate_interventions(rows, category="observability")
    agg = out["page__comparison_table"]
    assert agg["mean_lift"] == 0.7
    assert agg["ci_low"] <= 0.7 <= agg["ci_high"]
