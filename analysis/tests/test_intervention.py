"""Intervention moat store tests."""

from src.models import LiftResult, Intervention
from src.intervention import record_intervention


class TestRecordIntervention:
    def test_creates_intervention_from_lift_result(self):
        lift = LiftResult(
            experiment_id="exp_001",
            estimate=0.15,
            ci_low=0.05,
            ci_high=0.25,
            p_value=0.01,
            verdict="worked",
            claim_rung=2,
            computed_at="2026-06-27T00:00:00Z",
        )
        intervention = record_intervention(
            lift_result=lift,
            category="GTM analytics",
            engine="openai",
            feature_changed="comparison_table",
        )
        assert isinstance(intervention, Intervention)
        assert intervention.feature_changed == "comparison_table"
        assert intervention.category == "GTM analytics"
        assert intervention.engine == "openai"
        assert intervention.measured_lift == 0.15
        assert intervention.ci_low == 0.05
        assert intervention.ci_high == 0.25

    def test_preserves_experiment_id(self):
        lift = LiftResult(
            experiment_id="exp_abc",
            estimate=0.1,
            ci_low=-0.02,
            ci_high=0.22,
            p_value=0.12,
            verdict="inconclusive",
            claim_rung=2,
            computed_at="2026-06-27T00:00:00Z",
        )
        intervention = record_intervention(
            lift_result=lift,
            category="test",
            engine="gemini",
            feature_changed="word_count",
        )
        assert intervention.experiment_id == "exp_abc"

    def test_handles_zero_lift(self):
        lift = LiftResult(
            experiment_id="exp_zero",
            estimate=0.0,
            ci_low=0.0,
            ci_high=0.0,
            p_value=1.0,
            verdict="no_effect",
            claim_rung=2,
            computed_at="2026-06-27T00:00:00Z",
        )
        intervention = record_intervention(
            lift_result=lift,
            category="test",
            engine="openai",
            feature_changed="heading_structure",
        )
        assert intervention.measured_lift == 0.0
        assert intervention.ci_low == 0.0
        assert intervention.ci_high == 0.0
