"""DiD estimation tests — recovery, power honesty, edge cases.

CRITICAL: the recovery test is how we prove honesty — plant a known lift,
verify the DiD estimate is within CI of truth and has the correct sign.
"""

import numpy as np
import pandas as pd
import pytest

from src.did import estimate_did, simulate_panel, _compute_verdict, _run_ols_did


class TestSimulatePanel:
    def test_returns_dataframe_with_expected_columns(self):
        df = simulate_panel(n_pages=10, n_treated=5, effect=0.15, seed=42)
        assert isinstance(df, pd.DataFrame)
        assert set(df.columns) >= {"page", "citation_rate", "treatment", "post", "week"}
        assert len(df) == 10 * 2 * 2  # n_pages × 2 weeks × 2 periods

    def test_treated_count_matches(self):
        df = simulate_panel(n_pages=20, n_treated=8, effect=0.1, seed=42)
        treated_pages = df.loc[df["treatment"] == 1, "page"].nunique()
        assert treated_pages == 8

    def test_seeded_reproducibility(self):
        df1 = simulate_panel(n_pages=5, n_treated=2, effect=0.15, seed=42)
        df2 = simulate_panel(n_pages=5, n_treated=2, effect=0.15, seed=42)
        assert df1["citation_rate"].values == pytest.approx(df2["citation_rate"].values)


class TestDidRecovery:
    """Plant a known lift; verify the DiD recovers it."""

    def test_recovers_positive_lift(self):
        df = simulate_panel(n_pages=30, n_treated=15, effect=0.15, noise_sd=0.05, seed=42)
        result = estimate_did(df, experiment_id="exp_test")

        assert result.claim_rung == 2
        assert result.estimate > 0
        assert result.ci_low < result.estimate < result.ci_high
        assert result.ci_low > 0, f"CI crosses zero: [{result.ci_low:.4f}, {result.ci_high:.4f}]"
        assert result.verdict == "worked"

    def test_recovers_negative_lift(self):
        df = simulate_panel(n_pages=30, n_treated=15, effect=-0.15, noise_sd=0.05, seed=42)
        result = estimate_did(df, experiment_id="exp_test")

        assert result.estimate < 0
        assert result.ci_high < 0, f"CI crosses zero: [{result.ci_low:.4f}, {result.ci_high:.4f}]"
        assert result.verdict == "no_effect"

    def test_estimate_within_ci_of_truth(self):
        true_effect = 0.20
        df = simulate_panel(n_pages=40, n_treated=20, effect=true_effect, noise_sd=0.04, seed=42)
        result = estimate_did(df, experiment_id="exp_test")

        assert result.ci_low <= true_effect <= result.ci_high, (
            f"True effect {true_effect:.3f} outside CI [{result.ci_low:.3f}, {result.ci_high:.3f}]"
        )

    def test_p_value_below_threshold_for_strong_signal(self):
        df = simulate_panel(n_pages=40, n_treated=20, effect=0.20, noise_sd=0.04, seed=42)
        result = estimate_did(df, experiment_id="exp_test")
        assert result.p_value <= 0.05

    def test_seeded_recovery_is_reproducible(self):
        df = simulate_panel(n_pages=30, n_treated=15, effect=0.15, noise_sd=0.05, seed=123)
        r1 = estimate_did(df, "exp1")
        r2 = estimate_did(df, "exp2")
        assert r1.estimate == pytest.approx(r2.estimate)


class TestDidPowerHonesty:
    """At tiny N, the model must return inconclusive (never a false positive)."""

    def test_two_pages_per_arm_inconclusive(self):
        df = simulate_panel(n_pages=4, n_treated=2, effect=0.5, noise_sd=0.1, seed=42)
        result = estimate_did(df, experiment_id="exp_tiny")
        assert result.verdict == "inconclusive", f"Expected inconclusive, got {result.verdict}"

    def test_single_page_per_arm_inconclusive(self):
        df = simulate_panel(n_pages=2, n_treated=1, effect=0.5, noise_sd=0.05, seed=42)
        result = estimate_did(df, experiment_id="exp_tiny2")
        assert result.verdict == "inconclusive"

    def test_single_time_period_inconclusive(self):
        df = simulate_panel(n_pages=20, n_treated=10, effect=0.5, noise_sd=0.05, seed=42)
        df["post"] = 0  # force single period
        result = estimate_did(df, experiment_id="exp_single_period")
        assert result.verdict == "inconclusive"


class TestComputeVerdict:
    def test_worked_when_positive_and_ci_excludes_zero(self):
        v = _compute_verdict(0.15, 0.05, 0.25, 0.01, None)
        assert v == "worked"

    def test_no_effect_when_negative_and_ci_excludes_zero(self):
        v = _compute_verdict(-0.15, -0.25, -0.05, 0.01, None)
        assert v == "no_effect"

    def test_inconclusive_when_ci_crosses_zero(self):
        v = _compute_verdict(0.05, -0.05, 0.15, 0.15, None)
        assert v == "inconclusive"

    def test_inconclusive_when_warning(self):
        v = _compute_verdict(0.15, 0.05, 0.25, 0.01, "inconclusive: too few pages")
        assert v == "inconclusive"

    def test_inconclusive_when_p_above_005(self):
        v = _compute_verdict(0.15, -0.05, 0.35, 0.15, None)
        assert v == "inconclusive"


class TestE2eFromExperiment:
    """End-to-end: design experiment → simulate panel → estimate DiD → verdict."""

    def test_full_pipeline(self):
        from src.models import FitRow
        from src.experiment import design_experiment, build_fit_rows_from_experiment

        rows = [
            FitRow(page_url=f"https://a{i}.com/p1", cluster_id=f"a{i}.com", P_cited=0.7 + (i % 2) * 0.2,
                   features={"word_count": 100 + i * 10, "comparison_table": 1.0})
            for i in range(6)
        ] + [
            FitRow(page_url=f"https://b{i}.com/p1", cluster_id=f"b{i}.com", P_cited=0.2 + (i % 2) * 0.1,
                   features={"word_count": 200 + i * 10, "comparison_table": 0.0})
            for i in range(6)
        ]

        exp = design_experiment(
            rows, "ws_acme", "GTM analytics", "openai",
            hypothesis="comparison_table correlates with citation",
        )
        assert len(exp.pairs) >= 1

        n_treatment = len({p.treatment_page for p in exp.pairs})
        n_control = len({p.control_page for p in exp.pairs})

        df = simulate_panel(
            n_pages=n_treatment + n_control,
            n_treated=n_treatment,
            effect=0.15,
            noise_sd=0.08,
            seed=42,
        )
        result = estimate_did(df, experiment_id="exp_e2e")
        assert result.claim_rung == 2
        assert result.verdict in ("worked", "no_effect", "inconclusive")
        assert result.ci_low < result.ci_high
