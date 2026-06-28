"""Experiment design tests — pairing, randomization, assignment."""

import numpy as np
from src.models import FitRow, Experiment
from src.experiment import design_experiment


def _row(page_url, cluster_id, p_cited=None, **feats):
    return FitRow(page_url=page_url, cluster_id=cluster_id, P_cited=p_cited, features=feats)


def _make_candidate_rows():
    return [
        _row("https://a.com/p1", "a.com", 0.9, word_count=100, comparison_table=1.0),
        _row("https://a.com/p2", "a.com", 0.7, word_count=150, comparison_table=0.0),
        _row("https://b.com/p1", "b.com", 0.3, word_count=200, comparison_table=0.0),
        _row("https://b.com/p2", "b.com", 0.1, word_count=250, comparison_table=1.0),
        _row("https://c.com/p1", "c.com", 0.5, word_count=180, comparison_table=0.0),
        _row("https://d.com/p1", "d.com", 0.4, word_count=220, comparison_table=1.0),
    ]


class TestDesignExperiment:
    def test_returns_experiment_record(self):
        rows = _make_candidate_rows()
        exp = design_experiment(
            rows,
            customer_id="ws_acme",
            category="GTM analytics",
            engine="openai",
            hypothesis="comparison_table correlates with citation probability",
        )
        assert isinstance(exp, Experiment)
        assert exp.status == "designing"
        assert exp.customer_id == "ws_acme"
        assert exp.category == "GTM analytics"
        assert exp.engine == "openai"
        assert "comparison_table" in exp.hypothesis

    def test_pairs_are_cross_cluster(self):
        rows = _make_candidate_rows()
        exp = design_experiment(
            rows, "ws_acme", "GTM analytics", "openai",
            hypothesis="test", n_pairs=3,
        )
        for p in exp.pairs:
            t_cluster = None
            c_cluster = None
            for r in rows:
                if r.page_url == p.treatment_page:
                    t_cluster = r.cluster_id
                if r.page_url == p.control_page:
                    c_cluster = r.cluster_id
            assert t_cluster != c_cluster, (
                f"Same-cluster pair: {p.treatment_page} vs {p.control_page}"
            )

    def test_no_page_in_multiple_pairs(self):
        rows = _make_candidate_rows()
        exp = design_experiment(
            rows, "ws_acme", "GTM analytics", "openai",
            hypothesis="test", n_pairs=10,
        )
        all_urls = []
        for p in exp.pairs:
            assert p.treatment_page not in all_urls
            assert p.control_page not in all_urls
            all_urls.append(p.treatment_page)
            all_urls.append(p.control_page)

    def test_treatment_is_randomized(self):
        """Run design_experiment twice with different seeds; treatment assignment should differ."""
        rows = _make_candidate_rows()
        exp1 = design_experiment(
            rows, "ws", "cat", "openai", hypothesis="test", n_pairs=2, seed=1,
        )
        exp2 = design_experiment(
            rows, "ws", "cat", "openai", hypothesis="test", n_pairs=2, seed=999,
        )
        t1 = {p.treatment_page for p in exp1.pairs}
        t2 = {p.treatment_page for p in exp2.pairs}
        assert t1 != t2, (
            "Same treatment assignment across seeds — randomization may be broken"
        )

    def test_insufficient_rows_returns_empty_pairs(self):
        rows = [
            _row("https://a.com/p1", "a.com", 0.5, word_count=100),
        ]
        exp = design_experiment(
            rows, "ws_acme", "GTM analytics", "openai", hypothesis="test",
        )
        assert len(exp.pairs) == 0

    def test_max_pairs_respected(self):
        rows = _make_candidate_rows()
        exp = design_experiment(
            rows, "ws", "cat", "openai", hypothesis="test", n_pairs=1,
        )
        assert len(exp.pairs) <= 1

    def test_match_covars_in_pairs(self):
        rows = _make_candidate_rows()
        exp = design_experiment(
            rows, "ws", "cat", "openai", hypothesis="test", n_pairs=2,
        )
        for p in exp.pairs:
            assert "P_cited_diff" in p.match_covars
            assert "content_cosine_sim" in p.match_covars
