"""Phase-6 honesty-audit tests — adversarial by design.

The job of these tests is to *try to make the product overclaim* and prove the
audit catches it. The pydantic contract already enforces the happy path
(``noise_flag`` required, CI ordered, ``Verdict`` constrained, no causal fields on
``ModelFit``), so every over-claim is built as a **plain dict** — the only shape a
doctored claim can actually take. Clean cases are built as real pydantic models to
prove honest records pass.

Includes the MANDATORY honesty assertion from ``docs/TESTING.md``:
"No-causation-without-experiment (P4): the analysis service emits causal output
(lift_result) only from the randomized DiD path, never from model_fit coefficients."
"""

from __future__ import annotations

import pytest

from src.contract import Coefficient, LiftResult, ModelFit
from src.honesty import (
    assert_no_causation_without_experiment,
    assert_no_causation_without_experiment_strict,
    audit_claim_ladder,
    audit_lift_result,
    audit_model_fit,
)

# Hardcoded, NOT imported from the module under audit — the guard must not derive
# its banned vocabulary from the code it polices (mirrors test_hypotheses.py).
PLANTED_CAUSAL_WORD = "drives"


def _coef(feature: str, median: float, lo: float, hi: float, noise: bool) -> Coefficient:
    return Coefficient(
        feature=feature, posterior_median=median, ci_low=lo, ci_high=hi, noise_flag=noise
    )


def _clean_model_fit() -> ModelFit:
    return ModelFit(
        id="fit-1",
        customer_id="cust-1",
        category="observability",
        engine="openai",
        coefficients=[
            _coef("page__comparison_table", 1.2, 0.4, 2.0, noise=False),
            _coef("page__faq_block", 0.05, -0.3, 0.4, noise=True),
        ],
        prior_version="phase4-test-v0",
        top_hypotheses=[
            "Pages with higher `page__comparison_table` may be cited more often "
            "(hypothesis — test with an experiment)"
        ],
        n_companies=24,
        n_rows=120,
    )


def _worked_lift_result() -> LiftResult:
    return LiftResult(
        id="lift-1",
        experiment_id="exp-1",
        estimate=0.18,
        ci_low=0.05,
        ci_high=0.31,
        p_value=0.02,
        verdict="worked",
        claim_rung=2,
        computed_at="2026-06-27T00:00:00Z",
    )


# --- audit_model_fit ---------------------------------------------------------


def test_clean_model_fit_passes():
    result = audit_model_fit(_clean_model_fit())
    assert result["ok"], result["violations"]
    assert result["violations"] == []


def test_model_fit_with_planted_causal_word_fails():
    fit = {
        "id": "fit-bad",
        "coefficients": [{"feature": "x", "noise_flag": False}],
        "top_hypotheses": [
            f"Pages with `x` {PLANTED_CAUSAL_WORD} more citations"
        ],
    }
    result = audit_model_fit(fit)
    assert not result["ok"]
    assert any(PLANTED_CAUSAL_WORD in v for v in result["violations"])


def test_model_fit_missing_noise_flag_fails():
    # A coefficient with no noise_flag — only constructible as a dict.
    fit = {"coefficients": [{"feature": "x", "posterior_median": 1.0}]}
    result = audit_model_fit(fit)
    assert not result["ok"]
    assert any("noise_flag" in v for v in result["violations"])


def test_model_fit_smuggling_causal_field_fails():
    # A model_fit dict that smuggles a Rung-2 causal field — the load-bearing check.
    fit = {
        "coefficients": [{"feature": "x", "noise_flag": False}],
        "top_hypotheses": [],
        "claim_rung": 2,
        "verdict": "worked",
        "estimate": 0.4,
    }
    result = audit_model_fit(fit)
    assert not result["ok"]
    assert any("claim_rung" in v for v in result["violations"])
    assert any("verdict" in v for v in result["violations"])
    assert any("estimate" in v for v in result["violations"])


def test_model_fit_with_rung1_label_is_fine():
    fit = {
        "coefficients": [{"feature": "x", "noise_flag": False}],
        "top_hypotheses": [],
        "claim_rung": 1,  # honest self-labelling, not an over-claim
    }
    assert audit_model_fit(fit)["ok"]


# --- audit_lift_result -------------------------------------------------------


def test_clean_lift_result_passes():
    result = audit_lift_result(_worked_lift_result())
    assert result["ok"], result["violations"]


def test_lift_result_wrong_rung_fails():
    bad = {
        "estimate": 0.18,
        "ci_low": 0.05,
        "ci_high": 0.31,
        "verdict": "worked",
        "claim_rung": 1,  # a causal claim must be rung 2
    }
    result = audit_lift_result(bad)
    assert not result["ok"]
    assert any("claim_rung" in v for v in result["violations"])


def test_lift_result_misordered_ci_fails():
    bad = {
        "estimate": 0.1,
        "ci_low": 0.5,
        "ci_high": 0.2,  # mis-ordered
        "verdict": "worked",
        "claim_rung": 2,
    }
    result = audit_lift_result(bad)
    assert not result["ok"]
    assert any("mis-ordered" in v for v in result["violations"])


def test_inconclusive_cannot_be_dressed_as_a_win():
    incon = LiftResult(
        id="lift-incon",
        experiment_id="exp-2",
        estimate=0.0,
        ci_low=-1.0,
        ci_high=1.0,
        verdict="inconclusive",
        claim_rung=2,
        computed_at="2026-06-27T00:00:00Z",
    )
    # honest presentation: fine
    assert audit_lift_result(incon, claimed_verdict="inconclusive")["ok"]
    # dressing it as a win: flagged
    result = audit_lift_result(incon, claimed_verdict="worked")
    assert not result["ok"]
    assert any("dressed as a win" in v for v in result["violations"])


# --- assert_no_causation_without_experiment (THE MANDATORY TEST) -------------


def test_mandatory_worked_claim_with_backing_lift_passes():
    """A 'worked' causal claim backed by a rung-2 DiD lift_result is allowed."""
    result = assert_no_causation_without_experiment(
        lift_result=_worked_lift_result(), claimed_verdict="worked"
    )
    assert result["ok"], result["violations"]
    # strict variant does not raise
    assert_no_causation_without_experiment_strict(
        lift_result=_worked_lift_result(), claimed_verdict="worked"
    )


def test_mandatory_causal_claim_from_model_fit_alone_raises():
    """A causal claim asserted from a model_fit with NO lift_result must fail.

    This is the load-bearing assertion: coefficients can never yield causation.
    """
    over_claiming_fit = {
        "coefficients": [{"feature": "page__comparison_table", "noise_flag": False}],
        "estimate": 0.4,
        "verdict": "worked",
        "claim_rung": 2,
    }
    result = assert_no_causation_without_experiment(
        model_fit=over_claiming_fit, lift_result=None
    )
    assert not result["ok"]

    with pytest.raises(AssertionError):
        assert_no_causation_without_experiment_strict(
            model_fit=over_claiming_fit, lift_result=None
        )


def test_worked_claim_without_any_lift_raises():
    """Presenting a 'worked' verdict with no lift_result at all is unbacked."""
    with pytest.raises(AssertionError):
        assert_no_causation_without_experiment_strict(claimed_verdict="worked")


def test_honest_rung1_only_does_not_raise():
    """A clean rung-1 model_fit and no causal claim must NOT raise."""
    result = assert_no_causation_without_experiment(model_fit=_clean_model_fit())
    assert result["ok"], result["violations"]
    assert_no_causation_without_experiment_strict(model_fit=_clean_model_fit())


def test_worked_claim_backed_by_inconclusive_lift_raises():
    """A 'worked' presentation backed only by an inconclusive result is unbacked."""
    incon = {
        "estimate": 0.0,
        "ci_low": -1.0,
        "ci_high": 1.0,
        "verdict": "inconclusive",
        "claim_rung": 2,
    }
    result = assert_no_causation_without_experiment(
        lift_result=incon, claimed_verdict="worked"
    )
    assert not result["ok"]


# --- audit_claim_ladder ------------------------------------------------------


def test_claim_ladder_accepts_well_formed_records():
    records = [
        _clean_model_fit(),
        _worked_lift_result(),
        {
            "id": "iv-1",
            "feature_changed": "page__comparison_table",
            "measured_lift": 0.18,
            "ci_low": 0.05,
            "ci_high": 0.31,
            "experiment_id": "exp-1",
            "claim_rung": 2,
        },
    ]
    result = audit_claim_ladder(records)
    assert result["ok"], result["violations"]


def test_claim_ladder_rejects_model_fit_claiming_rung2():
    # A model_fit-shaped record lying about its rung — detected by structure,
    # never by trusting the claim_rung field it reports.
    records = [
        {
            "coefficients": [{"feature": "x", "noise_flag": False}],
            "top_hypotheses": ["Pages with `x` may be cited more often"],
            "claim_rung": 2,
        }
    ]
    result = audit_claim_ladder(records)
    assert not result["ok"]
    assert any("supports rung 1" in v for v in result["violations"])


def test_claim_ladder_flags_unrecognized_record():
    result = audit_claim_ladder([{"foo": "bar"}])
    assert not result["ok"]
    assert any("recognizable" in v for v in result["violations"])
