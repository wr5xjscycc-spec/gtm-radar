"""Phase-6 scale-path tests: the graduation gate is real logic; the model is a stub.

We test the gate at each threshold boundary, assert the stub refuses to fake a fit
(and that its message names the load-bearing concepts), and pin the documented
thresholds so a silent change to the graduation policy fails CI.
"""

from __future__ import annotations

import pytest

from src.scale import (
    MIN_CATEGORIES,
    MIN_COMPANIES,
    fit_hierarchical_model,
    ready_for_hierarchical,
)


def test_thresholds_are_documented_values() -> None:
    """The card specifies ~15 categories / ~300 companies; pin them."""
    assert MIN_CATEGORIES == 15
    assert MIN_COMPANIES == 300


def test_ready_only_when_both_thresholds_met() -> None:
    result = ready_for_hierarchical(n_categories=MIN_CATEGORIES, n_companies=MIN_COMPANIES)
    assert result["ready"] is True
    assert result["reasons"] == []


def test_not_ready_below_category_threshold() -> None:
    result = ready_for_hierarchical(n_categories=MIN_CATEGORIES - 1, n_companies=MIN_COMPANIES)
    assert result["ready"] is False
    assert any("categor" in r for r in result["reasons"])


def test_not_ready_below_company_threshold() -> None:
    result = ready_for_hierarchical(n_categories=MIN_CATEGORIES, n_companies=MIN_COMPANIES - 1)
    assert result["ready"] is False
    assert any("companies" in r for r in result["reasons"])


def test_not_ready_below_both_thresholds_lists_both_reasons() -> None:
    result = ready_for_hierarchical(n_categories=0, n_companies=0)
    assert result["ready"] is False
    assert len(result["reasons"]) == 2


def test_fit_hierarchical_model_is_an_honest_stub() -> None:
    with pytest.raises(NotImplementedError) as exc:
        fit_hierarchical_model({})
    message = str(exc.value).lower()
    assert "partial pooling" in message
    assert "random effects" in message
