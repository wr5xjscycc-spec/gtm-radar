"""Baseline tests — Ridge regression on fit rows."""

from src.models import FitRow
from src.baseline import fit_baseline


def _row(page_url, cluster_id, p_cited, **feats):
    return FitRow(page_url=page_url, cluster_id=cluster_id, P_cited=p_cited, features=feats)


class TestFitBaseline:
    def test_returns_coefficients(self):
        rows = [
            _row("https://a.com/p1", "a", 0.9, x=1.0, y=0.0),
            _row("https://b.com/p1", "b", 0.1, x=0.0, y=1.0),
        ]
        coeffs, hypotheses, metrics = fit_baseline(rows)
        assert len(coeffs) == 2
        assert metrics.n_features == 2
        assert metrics.n_rows == 2
        assert metrics.n_companies == 2

    def test_r2_is_between_0_and_1(self):
        rows = [
            _row("https://a.com/p1", "a", 0.9, x=1.0),
            _row("https://b.com/p1", "b", 0.1, x=0.0),
        ]
        _, _, metrics = fit_baseline(rows)
        assert 0.0 <= metrics.accuracy <= 1.0

    def test_no_P_cited_produces_dummy_coefficients(self):
        rows = [
            FitRow(page_url="https://a.com/p1", cluster_id="a", features={"x": 1.0}),
            FitRow(page_url="https://b.com/p1", cluster_id="b", features={"y": 2.0}),
        ]
        coeffs, hypotheses, metrics = fit_baseline(rows)
        assert len(coeffs) == 2
        assert all(c.posterior_median == 0.0 for c in coeffs)
        assert metrics.accuracy == 0.0

    def test_single_value_P_cited_produces_dummy(self):
        rows = [
            _row("https://a.com/p1", "a", 0.5, x=1.0),
            _row("https://b.com/p1", "b", 0.5, x=0.0),
        ]
        coeffs, hypotheses, metrics = fit_baseline(rows)
        assert all(c.posterior_median == 0.0 for c in coeffs)

    def test_top_hypotheses_from_strongest_coefficients(self):
        rows = [
            _row("https://a.com/p1", "a", 0.9, strong=2.0, weak=0.1),
            _row("https://b.com/p1", "b", 0.1, strong=-2.0, weak=0.1),
        ]
        _, hypotheses, _ = fit_baseline(rows)
        assert len(hypotheses) <= 3
        if hypotheses:
            assert "strong" in hypotheses[0]

    def test_single_feature_produces_one_coefficient(self):
        rows = [
            _row("https://a.com/p1", "a", 0.9, z=5.0),
            _row("https://b.com/p1", "b", 0.1, z=0.0),
        ]
        coeffs, _, metrics = fit_baseline(rows)
        assert len(coeffs) == 1
        assert coeffs[0].feature == "z"
