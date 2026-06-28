"""Phase-3 case-control labeling tests (records built inline — no fixtures/ dependency)."""

from __future__ import annotations

from src.labeling import case_control_label, ci_weight, label_measurement


def test_case_control_winner_loser_excluded_mapping():
    assert case_control_label(appeared=True, cited=True) == "winner"
    # cited implies winner regardless of the appeared flag
    assert case_control_label(appeared=False, cited=True) == "winner"
    # considered-but-not-cited is the only valid loser/control
    assert case_control_label(appeared=True, cited=False) == "loser"
    # never considered -> excluded from the pool (NOT a loser)
    assert case_control_label(appeared=False, cited=False) is None


def test_label_measurement_on_full_records():
    winner = {"engine": "openai", "page_url": "https://a.com/x", "appeared": True, "cited": True}
    loser = {"engine": "openai", "page_url": "https://a.com/y", "appeared": True, "cited": False}
    excluded = {"engine": "openai", "page_url": "https://a.com/z", "appeared": False, "cited": False}
    assert label_measurement(winner) == "winner"
    assert label_measurement(loser) == "loser"
    assert label_measurement(excluded) is None
    # missing flags default to False -> excluded
    assert label_measurement({"engine": "openai", "page_url": "https://a.com/q"}) is None


def test_ci_weight_none_and_zero_are_full_weight():
    assert ci_weight(None) == 1.0
    assert ci_weight(0.0) == 1.0


def test_ci_weight_monotonic_decreasing_in_width():
    weights = [ci_weight(w) for w in (0.0, 0.1, 0.3, 0.6, 1.0)]
    assert all(later < earlier for earlier, later in zip(weights, weights[1:]))
    assert ci_weight(1.0) == 0.5  # 1 / (1 + 1)


def test_ci_weight_negative_width_clamped_to_full_weight():
    assert ci_weight(-0.2) == 1.0
