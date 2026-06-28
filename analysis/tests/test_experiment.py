"""Phase-5 experiment design + randomization tests (records built inline)."""

from __future__ import annotations

import numpy as np

from src.contract import Experiment, ExperimentPair
from src.experiment import design_experiment, randomize_assignment
from src.matching import Pair


def _company(domain: str) -> dict:
    return {
        "domain": domain,
        "name": domain.split(".")[0],
        "role": "competitor",
        "firmographics": {"headcount_growth": 0.2},
        "offpage": {"g2_presence": True},
    }


def _page(company_domain: str, url: str, *, listicle: float) -> dict:
    return {
        "company_domain": company_domain,
        "url": url,
        "role": "candidate",
        "content_features": {"word_count": 1000, "listicle_vs_prose": listicle},
    }


def _measurement(engine: str, query_id: str, page_url: str, p_cited: float) -> dict:
    return {
        "id": f"m-{engine}-{query_id}-{page_url}",
        "engine": engine,
        "query_id": query_id,
        "page_url": page_url,
        "p_cited": p_cited,
        "ci_low": max(0.0, p_cited - 0.1),
        "ci_high": min(1.0, p_cited + 0.1),
    }


def _records() -> tuple[list[dict], list[dict], list[dict]]:
    """Two cross-cluster pairs: winners (compare/product) and losers (guide/docs)."""
    companies = [_company("acme.com"), _company("globex.com"), _company("initech.com")]
    pages = [
        _page("acme.com", "https://acme.com/compare", listicle=0.7),
        _page("globex.com", "https://globex.com/product", listicle=0.65),
        _page("acme.com", "https://acme.com/guide", listicle=0.1),
        _page("initech.com", "https://initech.com/docs", listicle=0.15),
    ]
    measurements = [
        _measurement("openai", "q1", "https://acme.com/compare", 0.70),
        _measurement("openai", "q1", "https://acme.com/guide", 0.08),
        _measurement("openai", "q2", "https://globex.com/product", 0.66),
        _measurement("openai", "q2", "https://initech.com/docs", 0.05),
    ]
    return measurements, pages, companies


def _design(seed: int = 0, **kw) -> Experiment:
    measurements, pages, companies = _records()
    return design_experiment(
        measurements,
        pages,
        companies,
        customer_id="cust-1",
        engine="openai",
        baseline_window="2026-01",
        post_window="2026-02",
        experiment_id=f"exp-{seed}",
        target_feature="page__listicle_vs_prose",
        seed=seed,
        **kw,
    )


def _assignment_key(exp: Experiment) -> list[tuple[str, str]]:
    return [(p.treatment_page, p.control_page) for p in exp.pairs]


def test_returns_valid_experiment_with_windows_and_status():
    exp = _design()
    assert isinstance(exp, Experiment)
    assert exp.customer_id == "cust-1"
    assert exp.status == "designing"
    assert isinstance(exp.baseline_window, str) and isinstance(exp.post_window, str)
    assert exp.baseline_window == "2026-01"
    assert exp.post_window == "2026-02"
    assert exp.pairs
    assert all(isinstance(p, ExperimentPair) for p in exp.pairs)


def test_window_strings_passed_through():
    measurements, pages, companies = _records()
    exp = design_experiment(
        measurements, pages, companies,
        customer_id="c", engine="openai",
        baseline_window="2026-05",
        post_window="2026-06",
        experiment_id="e",
    )
    assert exp.baseline_window == "2026-05"
    assert exp.post_window == "2026-06"


def test_determinism_same_seed_identical_assignment():
    assert _assignment_key(_design(seed=7)) == _assignment_key(_design(seed=7))


def test_different_seeds_can_differ():
    # Deterministic per seed, so scan a range and assert assignments are not all
    # identical (rather than betting on a specific pair of seeds).
    keys = {tuple(_assignment_key(_design(seed=s))) for s in range(30)}
    assert len(keys) > 1


def test_randomize_assignment_is_deterministic_per_seed():
    pair = Pair(
        treatment_page="a", control_page="b",
        cluster_a="q1", cluster_b="q2",
        match_covars={},
    )
    a = randomize_assignment(pair, np.random.default_rng(3))
    b = randomize_assignment(pair, np.random.default_rng(3))
    assert a == b
    assert set(a) == {"a", "b"} and a[0] != a[1]


def test_randomization_balance_both_sides_chosen():
    pair = Pair(
        treatment_page="a", control_page="b",
        cluster_a="q1", cluster_b="q2",
        match_covars={},
    )
    treated = [randomize_assignment(pair, np.random.default_rng(s))[0] for s in range(200)]
    # Both pages must get chosen as treatment across seeds (not always one side)...
    assert set(treated) == {"a", "b"}
    # ...and roughly balanced (loose band — this is a coin flip, not a fixed ratio).
    share_a = treated.count("a") / len(treated)
    assert 0.35 <= share_a <= 0.65


def test_every_pair_has_distinct_treatment_and_control():
    exp = _design()
    for p in exp.pairs:
        assert p.treatment_page != p.control_page


def test_pairs_are_cross_cluster_spillover_guard():
    exp = _design()
    for p in exp.pairs:
        assert p.match_covars["treatment_cluster"] != p.match_covars["control_cluster"]


def test_covars_re_keyed_to_final_assignment_after_flip():
    # The load-bearing correctness test: after the coin flip, each arm's recorded
    # rate must match the rate of the page actually in that arm — not the
    # candidate's original slot. Catches stale-covar mislabeling.
    known_rate = {
        "https://acme.com/compare": 0.70,
        "https://globex.com/product": 0.66,
        "https://acme.com/guide": 0.08,
        "https://initech.com/docs": 0.05,
    }
    for seed in range(20):
        exp = _design(seed=seed)
        for p in exp.pairs:
            assert p.match_covars["treatment_p_cited"] == known_rate[p.treatment_page]
            assert p.match_covars["control_p_cited"] == known_rate[p.control_page]


def test_invisible_control_convention_recorded():
    exp = _design()
    assert all(p.match_covars["control_visibility"] == "invisible" for p in exp.pairs)


def test_target_feature_recorded_per_pair():
    exp = _design()
    assert all(p.match_covars["target_feature"] == "page__listicle_vs_prose" for p in exp.pairs)


def test_target_feature_optional():
    measurements, pages, companies = _records()
    exp = design_experiment(
        measurements, pages, companies,
        customer_id="c", engine="openai",
        baseline_window="2026-01", post_window="2026-02",
        experiment_id="e",
    )
    assert all("target_feature" not in p.match_covars for p in exp.pairs)


def test_pair_count_respects_n_pairs_cap():
    exp = _design(n_pairs=1)
    assert len(exp.pairs) == 1


def test_pair_count_respects_available_candidates():
    # Only two cross-cluster pairs exist; asking for 8 returns the 2 available
    # (an honest under-powered design, not a fabricated one).
    exp = _design(n_pairs=8)
    assert len(exp.pairs) == 2
