"""Phase-2 page-matching tests (records built inline — no fixtures/ dependency)."""

from __future__ import annotations

from src.matching import Pair, derive_topical_clusters, match_pairs


def _company(domain: str) -> dict:
    return {
        "domain": domain,
        "name": domain.split(".")[0],
        "role": "competitor",
        "firmographics": {"headcount_growth": 0.2},
        "offpage": {"g2_presence": True},
    }


def _page(company_domain: str, url: str, *, listicle: float) -> dict:
    # listicle_vs_prose is numeric so it survives assembly as page__listicle_vs_prose;
    # values kept away from the 0.5 bucket boundary so content-type matching is real.
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
    companies = [_company("acme.com"), _company("globex.com"), _company("initech.com")]
    pages = [
        _page("acme.com", "https://acme.com/compare", listicle=0.7),  # q1 winner
        _page("globex.com", "https://globex.com/product", listicle=0.65),  # q2 winner
        _page("acme.com", "https://acme.com/guide", listicle=0.1),  # q1 loser
        _page("initech.com", "https://initech.com/docs", listicle=0.15),  # q2 loser
    ]
    measurements = [
        # q1 cluster
        _measurement("openai", "q1", "https://acme.com/compare", 0.70),
        _measurement("openai", "q1", "https://acme.com/guide", 0.08),
        # q2 cluster
        _measurement("openai", "q2", "https://globex.com/product", 0.66),
        _measurement("openai", "q2", "https://initech.com/docs", 0.05),
    ]
    return measurements, pages, companies


def test_derive_topical_clusters_maps_page_to_cluster():
    measurements, _, _ = _records()
    clusters = derive_topical_clusters(measurements)
    assert clusters["acme.com/compare"] == "q1"
    assert clusters["globex.com/product"] == "q2"
    assert clusters["initech.com/docs"] == "q2"


def test_derive_topical_clusters_multi_query_primary_is_sorted_first():
    measurements = [
        _measurement("openai", "q_zeta", "https://acme.com/bridge", 0.5),
        _measurement("openai", "q_alpha", "https://acme.com/bridge", 0.5),
    ]
    clusters = derive_topical_clusters(measurements)
    # tested by two queries -> deterministic primary = sorted-first query_id
    assert clusters["acme.com/bridge"] == "q_alpha"


def test_pairs_are_always_cross_cluster_spillover_guard():
    measurements, pages, companies = _records()
    pairs = match_pairs(measurements, pages, companies, engine="openai")
    assert pairs
    for p in pairs:
        assert p.cluster_a != p.cluster_b  # hard spillover assertion


def test_pairs_respect_rate_tolerance():
    measurements, pages, companies = _records()
    pairs = match_pairs(measurements, pages, companies, engine="openai", rate_tolerance=0.15)
    assert pairs
    for p in pairs:
        gap = abs(p.match_covars["treatment_p_cited"] - p.match_covars["control_p_cited"])
        assert gap <= 0.15 + 1e-9
        assert p.match_covars["abs_rate_gap"] <= 0.15 + 1e-9


def test_expected_cross_cluster_pairs_form():
    measurements, pages, companies = _records()
    pairs = match_pairs(measurements, pages, companies, engine="openai")
    # winners (compare ~0.70 / product ~0.66) and losers (guide ~0.08 / docs ~0.05)
    # pair across clusters; within-cluster winner<->loser gaps exceed tolerance.
    paired = {frozenset((p.treatment_page, p.control_page)) for p in pairs}
    assert frozenset(("acme.com/compare", "globex.com/product")) in paired
    assert frozenset(("acme.com/guide", "initech.com/docs")) in paired


def test_per_engine_isolation_uses_engine_specific_rates():
    companies = [_company("acme.com"), _company("globex.com")]
    pages = [
        _page("acme.com", "https://acme.com/compare", listicle=0.7),
        _page("globex.com", "https://globex.com/product", listicle=0.65),
    ]
    # openai rates are close (match within 0.15); perplexity rates are far apart.
    measurements = [
        _measurement("openai", "q1", "https://acme.com/compare", 0.70),
        _measurement("openai", "q2", "https://globex.com/product", 0.66),
        _measurement("perplexity", "q1", "https://acme.com/compare", 0.70),
        _measurement("perplexity", "q2", "https://globex.com/product", 0.10),
    ]
    openai_pairs = match_pairs(measurements, pages, companies, engine="openai")
    assert len(openai_pairs) == 1
    assert openai_pairs[0].match_covars["control_p_cited"] == 0.66

    perplexity_pairs = match_pairs(measurements, pages, companies, engine="perplexity")
    # 0.70 vs 0.10 exceeds tolerance -> no pair on perplexity (uses perplexity rates)
    assert perplexity_pairs == []


def test_each_page_used_at_most_once_and_deterministic():
    measurements, pages, companies = _records()
    first = match_pairs(measurements, pages, companies, engine="openai")
    second = match_pairs(measurements, pages, companies, engine="openai")
    # deterministic across repeated calls
    assert [p.model_dump() for p in first] == [p.model_dump() for p in second]
    # no page appears in more than one pair
    seen: list[str] = []
    for p in first:
        seen.extend((p.treatment_page, p.control_page))
    assert len(seen) == len(set(seen))


def test_graceful_empty_when_no_cross_cluster_match_in_tolerance():
    # Two pages in DIFFERENT clusters but rates far apart -> no valid pair.
    companies = [_company("acme.com"), _company("globex.com")]
    pages = [
        _page("acme.com", "https://acme.com/compare", listicle=0.7),
        _page("globex.com", "https://globex.com/product", listicle=0.65),
    ]
    measurements = [
        _measurement("openai", "q1", "https://acme.com/compare", 0.90),
        _measurement("openai", "q2", "https://globex.com/product", 0.10),
    ]
    pairs = match_pairs(measurements, pages, companies, engine="openai", rate_tolerance=0.15)
    assert pairs == []


def test_same_cluster_pages_never_paired():
    # Both pages in the SAME cluster q1 with near-identical rates: tempting on rate,
    # but the spillover guard must refuse them.
    companies = [_company("acme.com"), _company("globex.com")]
    pages = [
        _page("acme.com", "https://acme.com/a", listicle=0.7),
        _page("globex.com", "https://globex.com/b", listicle=0.7),
    ]
    measurements = [
        _measurement("openai", "q1", "https://acme.com/a", 0.50),
        _measurement("openai", "q1", "https://globex.com/b", 0.52),
    ]
    pairs = match_pairs(measurements, pages, companies, engine="openai")
    assert pairs == []


def test_multi_query_overlap_blocks_pair():
    # A is in {q1,q2}, B is in {q2}. Primary clusters differ (q1 vs q2) but they
    # share q2 -> disjointness guard must still refuse them.
    companies = [_company("acme.com"), _company("globex.com")]
    pages = [
        _page("acme.com", "https://acme.com/a", listicle=0.7),
        _page("globex.com", "https://globex.com/b", listicle=0.7),
    ]
    measurements = [
        _measurement("openai", "q1", "https://acme.com/a", 0.50),
        _measurement("openai", "q2", "https://acme.com/a", 0.50),
        _measurement("openai", "q2", "https://globex.com/b", 0.51),
    ]
    pairs = match_pairs(measurements, pages, companies, engine="openai")
    assert pairs == []


def test_content_type_mismatch_blocks_pair():
    # Cross-cluster, identical rate -> tempting; but one is listicle, one prose.
    companies = [_company("acme.com"), _company("globex.com")]
    pages = [
        _page("acme.com", "https://acme.com/a", listicle=0.8),  # listicle
        _page("globex.com", "https://globex.com/b", listicle=0.1),  # prose
    ]
    measurements = [
        _measurement("openai", "q1", "https://acme.com/a", 0.50),
        _measurement("openai", "q2", "https://globex.com/b", 0.50),
    ]
    pairs = match_pairs(measurements, pages, companies, engine="openai")
    assert pairs == []


def test_pair_is_pydantic_model():
    measurements, pages, companies = _records()
    pairs = match_pairs(measurements, pages, companies, engine="openai")
    assert all(isinstance(p, Pair) for p in pairs)
