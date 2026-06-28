"""Phase-3 modeling-table construction tests (records built inline — no fixtures/ dependency)."""

from __future__ import annotations

from src.labeling import ci_weight
from src.rows import ModelingTable, build_modeling_tables


def _company(domain: str, category: str) -> dict:
    return {
        "domain": domain,
        "name": domain.split(".")[0],
        "role": "competitor",
        "firmographics": {"headcount_growth": 0.2},
        "offpage": {"g2_presence": True},
        "understanding": {"category": category, "icp": "smb", "positioning": "x"},
    }


def _page(company_domain: str, url: str) -> dict:
    return {
        "company_domain": company_domain,
        "url": url,
        "role": "candidate",
        "content_features": {"word_count": 1000, "schema_markup": True},
    }


def _meas(engine: str, url: str, *, appeared: bool, cited: bool, p_cited: float) -> dict:
    return {
        "id": f"m-{engine}-{url}-{int(appeared)}{int(cited)}",
        "engine": engine,
        "page_url": url,
        "appeared": appeared,
        "cited": cited,
        "p_cited": p_cited,
        "ci_low": max(0.0, p_cited - 0.1),
        "ci_high": min(1.0, p_cited + 0.1),
    }


def _dataset() -> tuple[list[dict], list[dict], list[dict]]:
    companies = [
        _company("acme.com", "crm"),
        _company("globex.com", "crm"),
        _company("dataz.com", "analytics"),
        _company("nope.com", "crm"),
    ]
    pages = [
        _page("acme.com", "https://acme.com/pricing"),
        _page("acme.com", "https://acme.com/features"),  # 2nd page -> pseudo-replication
        _page("globex.com", "https://globex.com/home"),
        _page("dataz.com", "https://dataz.com/dashboard"),
        _page("dataz.com", "https://dataz.com/reports"),
        _page("nope.com", "https://nope.com/ghost"),  # never considered -> excluded
    ]
    measurements = [
        # --- openai ---
        _meas("openai", "https://acme.com/pricing", appeared=True, cited=True, p_cited=0.7),
        # 2nd query for the same page: not cited here, but page still wins (any-cited rollup)
        _meas("openai", "https://acme.com/pricing", appeared=True, cited=False, p_cited=0.6),
        _meas("openai", "https://acme.com/features", appeared=True, cited=False, p_cited=0.2),
        _meas("openai", "https://globex.com/home", appeared=True, cited=True, p_cited=0.8),
        _meas("openai", "https://dataz.com/dashboard", appeared=True, cited=True, p_cited=0.9),
        _meas("openai", "https://dataz.com/reports", appeared=True, cited=False, p_cited=0.3),
        _meas("openai", "https://nope.com/ghost", appeared=False, cited=False, p_cited=0.0),
        # --- perplexity ---
        _meas("perplexity", "https://acme.com/pricing", appeared=True, cited=True, p_cited=0.5),
        # same page as an openai winner, but a LOSER on perplexity -> engine isolation
        _meas("perplexity", "https://globex.com/home", appeared=True, cited=False, p_cited=0.1),
        _meas("perplexity", "https://dataz.com/dashboard", appeared=True, cited=True, p_cited=0.6),
    ]
    return measurements, pages, companies


def test_tables_keyed_per_category_and_engine():
    tables = build_modeling_tables(*_dataset())
    # 2 categories x 2 engines, all four combos populated
    assert set(tables.keys()) == {
        ("crm", "openai"),
        ("analytics", "openai"),
        ("crm", "perplexity"),
        ("analytics", "perplexity"),
    }
    assert all(isinstance(t, ModelingTable) for t in tables.values())
    categories = {cat for (cat, _eng) in tables}
    assert categories == {"crm", "analytics"}


def test_n_companies_is_distinct_companies_not_row_count():
    tables = build_modeling_tables(*_dataset())
    crm_openai = tables[("crm", "openai")]
    # rows: acme/pricing (W), acme/features (L), globex/home (W) -> 3 rows, 2 companies
    assert crm_openai.n_rows == 3
    assert crm_openai.n_companies == 2
    assert crm_openai.n_companies < crm_openai.n_rows


def test_not_considered_rows_are_excluded():
    tables = build_modeling_tables(*_dataset())
    all_domains = {r.company_domain for t in tables.values() for r in t.rows}
    assert "nope.com" not in all_domains  # appeared=False everywhere -> never a loser
    all_urls = {r.page_url for t in tables.values() for r in t.rows}
    assert "https://nope.com/ghost" not in all_urls


def test_per_engine_isolation_uses_engine_specific_labels():
    tables = build_modeling_tables(*_dataset())
    openai_globex = next(r for r in tables[("crm", "openai")].rows if r.page_url == "https://globex.com/home")
    perp_globex = next(r for r in tables[("crm", "perplexity")].rows if r.page_url == "https://globex.com/home")
    # same page: winner on openai, loser on perplexity -> labels are engine-scoped
    assert openai_globex.label == "winner"
    assert perp_globex.label == "loser"
    # and the P(cited) rate differs per engine (not pooled)
    assert openai_globex.p_cited != perp_globex.p_cited


def test_multiple_measurements_per_page_roll_up_to_winner():
    tables = build_modeling_tables(*_dataset())
    pricing = next(r for r in tables[("crm", "openai")].rows if r.page_url == "https://acme.com/pricing")
    # cited on one query, not on another -> page-level rollup is winner
    assert pricing.label == "winner"


def test_both_winner_and_loser_labels_present():
    tables = build_modeling_tables(*_dataset())
    labels = {r.label for r in tables[("crm", "openai")].rows}
    assert labels == {"winner", "loser"}


def test_rows_carry_weight_and_namespaced_features():
    tables = build_modeling_tables(*_dataset())
    row = next(r for r in tables[("crm", "openai")].rows if r.page_url == "https://acme.com/pricing")
    assert row.weight == ci_weight(0.2)  # measurement ci bounds span 0.2 -> 1/(1+0.2)
    assert "page__word_count" in row.features
    assert "company__headcount_growth" in row.features


def test_engines_argument_restricts_tables():
    tables = build_modeling_tables(*_dataset(), engines=("openai",))
    assert {eng for (_cat, eng) in tables} == {"openai"}
