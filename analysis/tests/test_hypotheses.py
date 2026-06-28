"""Phase-4 hypothesis-selection + Rung-1 claim-ladder tests.

ModelFit/Coefficient objects are built inline (fast, no PyMC sampling) so these
tests exercise the honesty layer directly.
"""

from __future__ import annotations

from src.contract import Coefficient, ModelFit
from src.hypotheses import (
    BANNED_CAUSAL_WORDS,
    rung1_payload,
    select_top_hypotheses,
)

# Hardcoded from the Phase-4 task spec, NOT imported from the module under test —
# the honesty guard must not derive its banned list from the code it polices, or it
# would silently pass if that list ever drifted.
REQUIRED_BANNED_WORDS = (
    "cause",
    "causes",
    "causal",
    "drives",
    "increases",
    "guarantee",
    "will rank",
    "because of",
)


def _coef(
    feature: str,
    median: float,
    ci_low: float,
    ci_high: float,
    noise_flag: bool,
) -> Coefficient:
    return Coefficient(
        feature=feature,
        posterior_median=median,
        ci_low=ci_low,
        ci_high=ci_high,
        noise_flag=noise_flag,
    )


def _fit(coefficients: list[Coefficient], *, n_companies: int = 24) -> ModelFit:
    return ModelFit(
        id="fit-test",
        customer_id="cust-1",
        category="observability",
        engine="openai",
        coefficients=coefficients,
        prior_version="phase4-test-v0",
        n_companies=n_companies,
        n_rows=120,
    )


def test_only_survivors_appear():
    fit = _fit(
        [
            _coef("page__comparison_table", 1.2, 0.4, 2.0, noise_flag=False),
            _coef("page__faq_block", 0.05, -0.3, 0.4, noise_flag=True),
            _coef("company__domain_rating", 0.9, 0.2, 1.6, noise_flag=False),
        ]
    )
    out = select_top_hypotheses(fit)
    joined = " ".join(out)
    assert "page__comparison_table" in joined
    assert "company__domain_rating" in joined
    # the noise coefficient must never surface as a hypothesis
    assert "page__faq_block" not in joined


def test_all_noise_returns_empty():
    fit = _fit(
        [
            _coef("a", 0.1, -0.2, 0.4, noise_flag=True),
            _coef("b", -0.05, -0.5, 0.3, noise_flag=True),
        ]
    )
    assert select_top_hypotheses(fit) == []


def test_ranking_strong_before_weak_and_k_cap():
    # strong: interval far from zero; weak: interval barely clears zero.
    strong = _coef("strong", 2.5, 2.0, 3.0, noise_flag=False)
    medium = _coef("medium", 1.5, 1.0, 2.0, noise_flag=False)
    weak = _coef("weak", 0.6, 0.1, 1.1, noise_flag=False)
    fit = _fit([weak, strong, medium])  # deliberately unsorted input

    top2 = select_top_hypotheses(fit, k=2)
    assert len(top2) == 2
    assert "strong" in top2[0]
    assert "medium" in top2[1]
    assert all("weak" not in s for s in top2)

    # k larger than survivor count just returns all survivors
    assert len(select_top_hypotheses(fit, k=10)) == 3
    # non-positive k returns nothing
    assert select_top_hypotheses(fit, k=0) == []


def test_direction_positive_vs_negative():
    pos = _fit([_coef("pos_feat", 1.1, 0.5, 1.7, noise_flag=False)])
    neg = _fit([_coef("neg_feat", -1.1, -1.7, -0.5, noise_flag=False)])

    (pos_sentence,) = select_top_hypotheses(pos)
    (neg_sentence,) = select_top_hypotheses(neg)

    assert "more often" in pos_sentence
    assert "less often" in neg_sentence
    assert "more often" not in neg_sentence


def _assert_no_banned_words(text: str) -> None:
    low = text.lower()
    for word in REQUIRED_BANNED_WORDS:
        assert word not in low, f"banned causal word {word!r} leaked into: {text!r}"


def test_module_enforces_at_least_the_spec_banned_words():
    # the module's own list must cover (at minimum) the spec list.
    assert set(REQUIRED_BANNED_WORDS) <= set(BANNED_CAUSAL_WORDS)


def test_language_guard_no_causal_words_and_tentative_present():
    fit = _fit(
        [
            _coef("page__comparison_table", 1.2, 0.4, 2.0, noise_flag=False),
            _coef("company__domain_rating", -0.9, -1.6, -0.2, noise_flag=False),
        ]
    )
    hypotheses = select_top_hypotheses(fit)
    assert hypotheses  # sanity: we actually produced strings to guard

    for sentence in hypotheses:
        _assert_no_banned_words(sentence)
        # tentative, hypothesis framing must be present
        assert "may" in sentence.lower()
        assert "hypothesis" in sentence.lower()

    payload = rung1_payload(fit)
    # every string field in the payload is guarded
    for value in payload.values():
        if isinstance(value, str):
            _assert_no_banned_words(value)
        elif isinstance(value, list):
            for item in value:
                _assert_no_banned_words(item)

    _assert_no_banned_words(payload["caveat"])


def test_payload_shape_counts_and_caveat():
    fit = _fit(
        [
            _coef("survivor_1", 1.2, 0.4, 2.0, noise_flag=False),
            _coef("survivor_2", -0.9, -1.6, -0.2, noise_flag=False),
            _coef("noise_1", 0.05, -0.3, 0.4, noise_flag=True),
            _coef("noise_2", -0.02, -0.5, 0.45, noise_flag=True),
            _coef("noise_3", 0.1, -0.1, 0.3, noise_flag=True),
        ],
        n_companies=27,
    )
    payload = rung1_payload(fit)

    assert payload["claim_rung"] == 1
    assert payload["category"] == "observability"
    assert payload["engine"] == "openai"
    assert payload["n_companies"] == 27
    assert payload["n_features_total"] == 5
    assert payload["n_features_noise"] == 3
    assert payload["n_features_surviving"] == 2
    assert len(payload["top_hypotheses"]) == 2
    assert isinstance(payload["caveat"], str) and payload["caveat"]
    # the caveat must surface effective-N so the UI shows how thin the data is
    assert "27" in payload["caveat"]


def test_payload_all_noise_empty_hypotheses():
    fit = _fit(
        [
            _coef("a", 0.1, -0.2, 0.4, noise_flag=True),
            _coef("b", -0.05, -0.5, 0.3, noise_flag=True),
        ]
    )
    payload = rung1_payload(fit)
    assert payload["top_hypotheses"] == []
    assert payload["n_features_surviving"] == 0
    assert payload["n_features_noise"] == 2
