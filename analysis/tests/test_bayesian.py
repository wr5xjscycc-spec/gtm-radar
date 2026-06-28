"""Bayesian hypothesis generator tests — recovery, shrinkage, edge cases."""

import re

import numpy as np
import pytest

from src.models import FitRow
from src.bayesian import fit_bayesian, _hdi, _noise_flag


def _row(page_url, cluster_id, p_cited, **feats):
    return FitRow(page_url=page_url, cluster_id=cluster_id, P_cited=p_cited, features=feats)


def _make_synthetic_fit_rows(
    n_companies: int = 30,
    n_features: int = 15,
    seed: int = 42,
) -> tuple[list[FitRow], np.ndarray]:
    """Generate synthetic Beta-regression data with planted signal coefficients."""
    rng = np.random.default_rng(seed)
    rows: list[FitRow] = []

    true_beta = np.zeros(n_features)
    true_beta[0] = 0.8  # strong positive
    true_beta[1] = -0.5  # strong negative

    for i in range(n_companies):
        cluster_id = f"company_{i}"
        n_pages = int(rng.integers(1, 3))
        for j in range(n_pages):
            x = rng.normal(0, 1, n_features)
            feats = {f"feat_{k}": float(x[k]) for k in range(n_features)}

            logit_mu = float(x @ true_beta)
            mu = 1.0 / (1.0 + np.exp(-logit_mu))
            mu = max(1e-6, min(1 - 1e-6, mu))
            y = float(rng.beta(mu * 15.0, (1.0 - mu) * 15.0))

            rows.append(
                FitRow(
                    page_url=f"https://{cluster_id}/p{j}",
                    cluster_id=cluster_id,
                    P_cited=y,
                    features=feats,
                )
            )

    return rows, true_beta


class TestHdi:
    def test_symmetric(self):
        samples = np.random.default_rng(42).normal(0, 1, 1000)
        low, high = _hdi(samples, 0.9)
        assert low < high
        assert -2.5 < low < 0
        assert 0 < high < 2.5

    def test_2d(self):
        samples = np.column_stack([np.random.default_rng(42).normal(0, 1, 1000) for _ in range(3)])
        lows, highs = _hdi(samples, 0.9)
        assert len(lows) == 3
        assert len(highs) == 3
        assert all(l < h for l, h in zip(lows, highs))


class TestNoiseFlag:
    def test_ci_crosses_zero(self):
        assert _noise_flag(-0.5, 0.5, 0.1) is True

    def test_ci_positive(self):
        assert _noise_flag(0.1, 0.9, 0.5) is False

    def test_ci_negative(self):
        assert _noise_flag(-0.9, -0.1, -0.5) is False

    def test_tiny_median(self):
        assert _noise_flag(0.001, 0.002, 0.001) is True

    def test_ci_touches_zero_from_above(self):
        assert _noise_flag(0.0, 0.5, 0.3) is True


class TestFitBayesianEdgeCases:
    def test_no_rows(self):
        coeffs, hypotheses = fit_bayesian([])
        assert coeffs == []
        assert hypotheses == []

    def test_no_P_cited(self):
        rows = [
            FitRow(page_url="https://a.com/p1", cluster_id="a", features={"x": 1.0}),
            FitRow(page_url="https://b.com/p1", cluster_id="b", features={"y": 2.0}),
        ]
        coeffs, hypotheses = fit_bayesian(rows)
        assert len(coeffs) == 2
        assert all(c.posterior_median == 0.0 for c in coeffs)
        assert all(c.noise_flag for c in coeffs)

    def test_single_company_produces_dummy(self):
        rows = [
            _row("https://a.com/p1", "a", 0.5, x=1.0),
            _row("https://a.com/p2", "a", 0.5, x=0.0),
        ]
        coeffs, hypotheses = fit_bayesian(rows)
        assert all(c.posterior_median == 0.0 for c in coeffs)
        assert all(c.noise_flag for c in coeffs)

    def test_single_value_P_cited_produces_dummy(self):
        rows = [
            _row("https://a.com/p1", "a", 0.5, x=1.0),
            _row("https://b.com/p1", "b", 0.5, x=0.0),
        ]
        coeffs, hypotheses = fit_bayesian(rows)
        assert all(c.posterior_median == 0.0 for c in coeffs)
        assert all(c.noise_flag for c in coeffs)

    def test_single_feature(self):
        rows = [
            _row("https://a.com/p1", "a", 0.9, z=5.0),
            _row("https://b.com/p1", "b", 0.1, z=0.0),
        ]
        coeffs, hypotheses = fit_bayesian(rows, draws=100, tune=100)
        assert len(coeffs) == 1
        assert coeffs[0].feature == "z"

    def test_empty_features(self):
        rows = [
            _row("https://a.com/p1", "a", 0.5),
            _row("https://b.com/p1", "b", 0.5),
        ]
        coeffs, hypotheses = fit_bayesian(rows)
        assert coeffs == []
        assert hypotheses == []


class TestFitBayesianRecovery:
    """Plant signals and verify the Bayesian model recovers their signs."""

    def test_recovers_positive_and_negative_signals(self):
        rows, true_beta = _make_synthetic_fit_rows(
            n_companies=40, n_features=10, seed=42
        )
        coeffs, hypotheses = fit_bayesian(rows, draws=300, tune=200, chains=2)

        coeff_map = {c.feature: c for c in coeffs}

        # feat_0 has true_beta[0] = 0.8 → positive
        c0 = coeff_map["feat_0"]
        assert c0.posterior_median > 0, f"Expected positive for feat_0, got {c0.posterior_median}"

        # feat_1 has true_beta[1] = -0.5 → negative
        c1 = coeff_map["feat_1"]
        assert c1.posterior_median < 0, f"Expected negative for feat_1, got {c1.posterior_median}"

    def test_null_features_largely_flagged_as_noise(self):
        rows, true_beta = _make_synthetic_fit_rows(
            n_companies=30, n_features=15, seed=123
        )
        coeffs, _ = fit_bayesian(rows, draws=300, tune=200, chains=2)

        null_features = [c for i, c in enumerate(coeffs) if i >= 2]
        noise_flags = [c.noise_flag for c in null_features]
        noise_rate = sum(noise_flags) / len(noise_flags)

        assert noise_rate >= 0.5, f"Expected ≥50% noise_flag on nulls, got {noise_rate:.0%}"

    def test_top_hypotheses_use_correlation_not_causation(self):
        rows, true_beta = _make_synthetic_fit_rows(
            n_companies=30, n_features=10, seed=456
        )
        _, hypotheses = fit_bayesian(rows, draws=300, tune=200, chains=2)

        for h in hypotheses:
            assert "correlates" in h.lower(), f"Hypothesis uses causal language: {h}"
            assert "test this hypothesis" in h.lower(), f"Hypothesis missing test instruction: {h}"

    def test_hypotheses_from_strongest_coefficients(self):
        rows = [
            _row("https://a.com/p1", "a", 0.9, strong=2.0, weak=0.1),
            _row("https://b.com/p1", "b", 0.1, strong=-2.0, weak=0.1),
            _row("https://c.com/p1", "c", 0.9, strong=2.0, weak=-0.1),
            _row("https://d.com/p1", "d", 0.1, strong=-2.0, weak=0.1),
        ]
        _, hypotheses = fit_bayesian(rows, draws=200, tune=100, chains=2)
        assert len(hypotheses) <= 3
        if hypotheses:
            assert "strong" in hypotheses[0]


class TestFitBayesianShrinkage:
    """At small N, coefficients should be bounded (not blow up)."""

    def test_shrinkage_at_small_n(self):
        rng = np.random.default_rng(99)
        rows = []
        for i in range(5):
            x = rng.normal(0, 1, 6)
            rows.append(
                _row(
                    f"https://c{i}.com/p1", f"c{i}", 0.5 + 0.3 * float(x[0]),
                    a=float(x[0]), b=float(x[1]), c=float(x[2]),
                    d=float(x[3]), e=float(x[4]), f=float(x[5]),
                )
            )

        coeffs, hypotheses = fit_bayesian(rows, draws=200, tune=100, chains=2)
        for c in coeffs:
            assert abs(c.posterior_median) < 5.0, (
                f"{c.feature} has extreme coefficient {c.posterior_median:.2f} "
                f"— shrinkage failing"
            )

    def test_default_prior_version(self):
        rows = [
            _row("https://a.com/p1", "a", 0.9, x=1.0),
            _row("https://b.com/p1", "b", 0.1, x=0.0),
        ]
        coeffs, _ = fit_bayesian(rows)
        assert len(coeffs) == 1
        assert coeffs[0].feature == "x"


class TestCoefficientStructure:
    """Verify coefficient shapes and metadata."""

    def test_coefficients_have_ci_and_noise_flag(self):
        rows = [
            _row("https://a.com/p1", "a", 0.9, a=1.0, b=0.0),
            _row("https://b.com/p1", "b", 0.1, a=0.0, b=1.0),
            _row("https://c.com/p1", "c", 0.8, a=1.0, b=0.0),
            _row("https://d.com/p1", "d", 0.2, a=0.0, b=1.0),
        ]
        coeffs, _ = fit_bayesian(rows, draws=200, tune=100, chains=2)
        for c in coeffs:
            assert c.ci_low < c.ci_high
            assert isinstance(c.noise_flag, bool)

    def test_feature_names_preserved(self):
        rows = [
            _row("https://a.com/p1", "a", 0.9, schema_markup=1.0, word_count=0.5),
            _row("https://b.com/p1", "b", 0.1, schema_markup=0.0, word_count=0.3),
        ]
        coeffs, _ = fit_bayesian(rows, draws=100, tune=100, chains=2)
        features = {c.feature for c in coeffs}
        assert features == {"schema_markup", "word_count"}
