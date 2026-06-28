"""Phase-1 row-assembly tests (records built inline — no fixtures/ dependency)."""

from __future__ import annotations

from src.assembly import assemble_rows, assembly_summary, build_fit_request
from src.contract import FitRequest


def _company(domain: str) -> dict:
    return {
        "domain": domain,
        "name": domain.split(".")[0],
        "role": "competitor",
        "firmographics": {"headcount_growth": 0.2, "tech_stack": ["next"]},  # list dropped
        "offpage": {"g2_presence": True, "backlink_density": 0.5},
    }


def _page(company_domain: str, url: str) -> dict:
    return {
        "company_domain": company_domain,
        "url": url,
        "role": "candidate",
        "content_features": {
            "word_count": 1200,
            "schema_markup": True,
            "comparison_table": False,
            "listicle_vs_prose": "prose",  # string dropped
        },
    }


def _measurement(engine: str, page_url: str, p_cited: float) -> dict:
    return {
        "id": f"m-{engine}-{page_url}",
        "engine": engine,
        "page_url": page_url,
        "p_cited": p_cited,
        "ci_low": max(0.0, p_cited - 0.1),
        "ci_high": min(1.0, p_cited + 0.1),
    }


def _records() -> tuple[list[dict], list[dict], list[dict]]:
    companies = [_company("acme.com"), _company("globex.com"), _company("zorg.com")]
    pages = [
        _page("acme.com", "https://acme.com/pricing"),
        _page("acme.com", "https://acme.com/features"),  # 2nd page -> pseudo-replication
        _page("globex.com", "HTTP://WWW.Globex.com/Home/"),  # messy -> normalized to https://globex.com/Home
        _page("zorg.com", "https://zorg.com/blog"),
    ]
    measurements = [
        _measurement("openai", "https://acme.com/pricing", 0.7),
        _measurement("openai", "https://acme.com/features", 0.4),
        # uppercase scheme + www + trailing slash must still join via normalization
        _measurement("openai", "HTTP://WWW.Globex.com/Home/", 0.6),
        # perplexity-only page: must be excluded when assembling openai
        _measurement("perplexity", "https://zorg.com/blog", 0.9),
    ]
    return measurements, pages, companies


def test_every_row_carries_company_cluster_id():
    measurements, pages, companies = _records()
    rows = assemble_rows(measurements, pages, companies, engine="openai")
    assert rows
    assert all(row.company_domain for row in rows)


def test_effective_n_is_distinct_companies_and_below_row_count():
    measurements, pages, companies = _records()
    rows = assemble_rows(measurements, pages, companies, engine="openai")
    summary = assembly_summary(rows)
    # 3 openai rows across 2 companies (acme has two pages) -> pseudo-replication
    assert summary["n_rows"] == 3
    assert summary["n_companies"] == 2
    assert summary["n_companies"] < summary["n_rows"]


def test_per_engine_separation_excludes_other_engines():
    measurements, pages, companies = _records()
    rows = assemble_rows(measurements, pages, companies, engine="openai")
    domains = {row.company_domain for row in rows}
    assert "zorg.com" not in domains  # zorg only measured on perplexity

    perplexity_rows = assemble_rows(measurements, pages, companies, engine="perplexity")
    assert {row.company_domain for row in perplexity_rows} == {"zorg.com"}


def test_normalized_domain_join_handles_scheme_www_trailing_slash():
    measurements, pages, companies = _records()
    rows = assemble_rows(measurements, pages, companies, engine="openai")
    by_url = {row.page_url: row for row in rows}
    assert "https://globex.com/Home" in by_url  # joined despite https://WWW...Home/
    assert by_url["https://globex.com/Home"].company_domain == "globex.com"


def test_features_are_namespaced_page_and_company():
    measurements, pages, companies = _records()
    rows = assemble_rows(measurements, pages, companies, engine="openai")
    row = next(r for r in rows if r.page_url == "https://acme.com/pricing")
    assert row.features["page__word_count"] == 1200.0
    assert row.features["page__schema_markup"] == 1.0  # bool -> 1.0
    assert row.features["company__headcount_growth"] == 0.2
    assert row.features["company__g2_presence"] == 1.0  # bool -> 1.0
    # non-numeric values are dropped, never namespaced
    assert "page__listicle_vs_prose" not in row.features
    assert "company__tech_stack" not in row.features


def test_ci_width_derived_from_bounds():
    measurements, pages, companies = _records()
    rows = assemble_rows(measurements, pages, companies, engine="openai")
    row = next(r for r in rows if r.page_url == "https://acme.com/pricing")
    assert row.ci_width is not None
    assert abs(row.ci_width - 0.2) < 1e-9


def test_build_fit_request_returns_valid_request():
    measurements, pages, companies = _records()
    request = build_fit_request(
        measurements,
        pages,
        companies,
        customer_id="cust-1",
        category="crm",
        engine="openai",
    )
    assert isinstance(request, FitRequest)
    assert request.engine == "openai"
    assert request.prior_version == "phase1-baseline-v0"
    assert request.n_companies() == 2
    # round-trips through the wire contract
    assert FitRequest.model_validate_json(request.model_dump_json()).n_companies() == 2
