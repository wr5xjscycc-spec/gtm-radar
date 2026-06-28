"""Phase-5 DiD tests — simulated panel with a KNOWN lift.

This is how we prove *honesty*, not just correctness: we plant a real causal lift
on the treatment arm and assert the estimator recovers it (sign + coverage +
``worked``); we plant NO lift and assert it does not cry ``worked``; we starve it
of data and assert it says ``inconclusive`` instead of a false positive; and we
hand it broken panels and assert it degrades to ``inconclusive`` without crashing.
Seeds are fixed so every assertion is deterministic.
"""

from __future__ import annotations

import numpy as np

from src.contract import Experiment, ExperimentPair
from src.did import estimate_lift

_BASELINE = "2026-05"
_POST = "2026-06"
# Distinct ISO weeks per window so the period FE has real week-level structure.
_BASE_WEEKS = ["2026-05-04", "2026-05-11"]
_POST_WEEKS = ["2026-06-01", "2026-06-08"]


def _experiment(n_pairs: int, exp_id: str = "exp_1") -> Experiment:
    pairs = [
        ExperimentPair(
            treatment_page=f"https://t{i}.example/p",
            control_page=f"https://c{i}.example/p",
        )
        for i in range(n_pairs)
    ]
    return Experiment(
        id=exp_id,
        customer_id="cust_1",
        pairs=pairs,
        baseline_window=_BASELINE,
        post_window=_POST,
    )


def _panel(
    exp: Experiment,
    *,
    lift: float,
    rng: np.random.Generator,
    noise: float = 0.02,
    base: float = 0.30,
    engine: str = "openai",
) -> list[dict]:
    """Simulate windowed measurements with a known treatment lift in the post window.

    Outcome model: P_cited = base + lift * treatment * post + N(0, noise). Both arms
    share the same baseline level and the same (zero) common time shock, so the only
    systematic treatment/control divergence post-publish is ``lift`` — exactly what
    the DiD must recover. Multiple weeks per window give the clustered SE real N.
    """
    rows: list[dict] = []
    for pair in exp.pairs:
        for page, is_treat in ((pair.treatment_page, 1), (pair.control_page, 0)):
            for window, weeks in (("baseline", _BASE_WEEKS), ("post", _POST_WEEKS)):
                post = 1 if window == "post" else 0
                for week in weeks:
                    mean = base + lift * is_treat * post
                    val = float(np.clip(mean + rng.normal(0.0, noise), 0.0, 1.0))
                    rows.append(
                        {
                            "page_url": page,
                            "engine": engine,
                            "window_tag": window,
                            "P_cited": val,
                            "ts": f"{week}T10:00:00Z",
                        }
                    )
    return rows


def test_recovery_known_positive_lift() -> None:
    """Plant a +0.20 lift on treatment pages; assert sign, coverage, and ``worked``."""
    rng = np.random.default_rng(42)
    exp = _experiment(n_pairs=10)
    true_lift = 0.20
    measurements = _panel(exp, lift=true_lift, rng=rng)

    res = estimate_lift(
        exp, measurements, engine="openai",
        computed_at="2026-06-15T00:00:00Z", lift_id="lift_1",
    )

    assert res.claim_rung == 2
    assert res.experiment_id == "exp_1"
    assert res.id == "lift_1"
    assert res.estimate > 0  # correct sign
    assert res.ci_low <= true_lift <= res.ci_high  # true lift inside the CI
    assert res.ci_low > 0  # CI excludes zero on the positive side
    assert res.verdict == "worked"
    assert res.p_value is not None and res.p_value < 0.10


def test_null_no_true_lift() -> None:
    """Both arms move together (no treatment effect) -> estimate ~0, never ``worked``."""
    rng = np.random.default_rng(7)
    exp = _experiment(n_pairs=10)
    measurements = _panel(exp, lift=0.0, rng=rng)

    res = estimate_lift(
        exp, measurements, engine="openai",
        computed_at="2026-06-15T00:00:00Z", lift_id="lift_null",
    )

    assert abs(res.estimate) < 0.05  # near zero
    assert res.verdict in ("no_effect", "inconclusive")
    assert res.verdict != "worked"


def test_power_honesty_tiny_n_is_inconclusive() -> None:
    """One pair with a HUGE point estimate must be ``inconclusive``, not ``worked``.

    Even though the raw treatment/control gap is large, a single pair carries no
    power, so the honest verdict is "can't tell yet."
    """
    rng = np.random.default_rng(1)
    exp = _experiment(n_pairs=1)
    measurements = _panel(exp, lift=0.40, rng=rng, noise=0.005)

    res = estimate_lift(
        exp, measurements, engine="openai",
        computed_at="2026-06-15T00:00:00Z", lift_id="lift_tiny",
    )

    assert res.verdict == "inconclusive"


def test_degenerate_missing_post_window() -> None:
    """A panel with only the baseline window -> inconclusive, no crash."""
    rng = np.random.default_rng(2)
    exp = _experiment(n_pairs=6)
    measurements = [m for m in _panel(exp, lift=0.2, rng=rng) if m["window_tag"] == "baseline"]

    res = estimate_lift(
        exp, measurements, engine="openai",
        computed_at="2026-06-15T00:00:00Z", lift_id="lift_deg1",
    )
    assert res.verdict == "inconclusive"


def test_degenerate_single_arm() -> None:
    """Only treatment-arm measurements present (no controls) -> inconclusive."""
    rng = np.random.default_rng(3)
    exp = _experiment(n_pairs=6)
    treatment_pages = {p.treatment_page for p in exp.pairs}
    measurements = [m for m in _panel(exp, lift=0.2, rng=rng) if m["page_url"] in treatment_pages]

    res = estimate_lift(
        exp, measurements, engine="openai",
        computed_at="2026-06-15T00:00:00Z", lift_id="lift_deg2",
    )
    assert res.verdict == "inconclusive"


def test_degenerate_empty_measurements() -> None:
    """No measurements at all -> inconclusive with the uninformative wide CI."""
    exp = _experiment(n_pairs=6)
    res = estimate_lift(
        exp, [], engine="openai",
        computed_at="2026-06-15T00:00:00Z", lift_id="lift_empty",
    )
    assert res.verdict == "inconclusive"
    assert res.ci_low < 0 < res.ci_high  # wide sentinel = "we know nothing"


def test_engine_filter_isolates_slice() -> None:
    """Measurements for a different engine must be ignored (never pool engines)."""
    rng = np.random.default_rng(9)
    exp = _experiment(n_pairs=8)
    real = _panel(exp, lift=0.18, rng=rng, engine="openai")
    # Add contradictory perplexity rows that should be filtered out entirely.
    noise_rows = _panel(exp, lift=-0.30, rng=rng, engine="perplexity")

    res = estimate_lift(
        exp, real + noise_rows, engine="openai",
        computed_at="2026-06-15T00:00:00Z", lift_id="lift_eng",
    )
    assert res.estimate > 0
    assert res.verdict == "worked"


def test_determinism_same_input_same_result() -> None:
    """Same panel in -> byte-identical estimate/CI out (no hidden randomness)."""
    rng = np.random.default_rng(11)
    exp = _experiment(n_pairs=8)
    measurements = _panel(exp, lift=0.15, rng=rng)

    a = estimate_lift(exp, measurements, engine="openai",
                      computed_at="t", lift_id="x")
    b = estimate_lift(exp, measurements, engine="openai",
                      computed_at="t", lift_id="x")
    assert a.estimate == b.estimate
    assert a.ci_low == b.ci_low and a.ci_high == b.ci_high
    assert a.p_value == b.p_value
