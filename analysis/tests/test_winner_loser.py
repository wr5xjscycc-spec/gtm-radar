"""Winner/loser row construction tests."""

import json
import pytest
from pathlib import Path
from src.winner_loser import (
    _ci_weight,
    _extract_page_features,
    _extract_company_features,
    build_modeling_tables,
    build_modeling_tables_from_synthetic,
)
from src.models import WeightedFitRow, CategoryEngineTable

FIXTURES = Path(__file__).resolve().parent.parent.parent / "tests" / "integration" / "fixtures"


def _load(name: str):
    with open(FIXTURES / name) as f:
        return json.load(f)


EPS = 1e-8


class TestCiWeight:
    def test_narrow_ci_high_weight(self):
        w = _ci_weight(0.45, 0.55)
        assert w == pytest.approx(10.0)

    def test_wide_ci_low_weight(self):
        w = _ci_weight(0.0, 1.0)
        assert w == pytest.approx(1.0)

    def test_moderate_ci(self):
        w = _ci_weight(0.0, 0.26)
        assert w == pytest.approx(1 / 0.26)

    def test_degenerate_ci_fallback(self):
        w = _ci_weight(0.5, 0.5)
        assert w == pytest.approx(1000.0)

    def test_zero_width_fallback(self):
        w = _ci_weight(0.5, 0.5)
        assert w > 500

    def test_reversed_ci_still_positive(self):
        w = _ci_weight(0.8, 0.2)
        assert w > 0

    def test_nan_ci_produces_finite_weight(self):
        import math
        w = _ci_weight(math.nan, 0.5)
        assert w == pytest.approx(1000.0)
        assert not math.isnan(w)
        assert math.isfinite(w)

    def test_inf_ci_produces_finite_weight(self):
        import math
        w = _ci_weight(0.0, math.inf)
        assert not math.isnan(w)
        assert math.isfinite(w)


class TestExtractPageFeatures:
    def test_extracts_all_content_keys(self):
        page = {
            "content_features": {
                "schema_markup": True,
                "comparison_table": False,
                "word_count": 480,
                "heading_structure": 3,
                "freshness_days": 210,
                "query_term_coverage": 0.4,
                "direct_answer_first": False,
                "stats_density": 0.1,
                "citation_density": 0.0,
                "listicle_vs_prose": 0.2,
            }
        }
        feats = _extract_page_features(page)
        assert feats["schema_markup"] == 1.0
        assert feats["comparison_table"] == 0.0
        assert feats["word_count"] == 480
        assert feats["query_term_coverage"] == 0.4
        assert feats["citation_density"] == 0.0

    def test_missing_content_features_defaults_zero(self):
        page = {}
        feats = _extract_page_features(page)
        assert all(v == 0.0 for v in feats.values())

    def test_bool_conversion(self):
        page = {"content_features": {"schema_markup": True, "comparison_table": False}}
        feats = _extract_page_features(page)
        assert feats["schema_markup"] == 1.0
        assert feats["comparison_table"] == 0.0

    def test_returns_all_expected_keys(self):
        page = {"content_features": {"word_count": 100}}
        feats = _extract_page_features(page)
        from src.rows import CONTENT_FEATURE_KEYS
        assert set(feats.keys()) == set(CONTENT_FEATURE_KEYS)

    def test_heading_structure_float(self):
        page = {"content_features": {"heading_structure": 5}}
        feats = _extract_page_features(page)
        assert feats["heading_structure"] == 5.0


class TestExtractCompanyFeatures:
    def test_extracts_offpage_into_feature_dict(self):
        company = {
            "offpage": {
                "thirdparty_mentions": 3,
                "reddit_presence": 0,
                "g2_presence": 1,
                "brand_search_volume": 120,
            }
        }
        feats = _extract_company_features(company)
        assert feats["offpage.thirdparty_mentions"] == 3.0
        assert feats["offpage.reddit_presence"] == 0.0
        assert feats["offpage.brand_search_volume"] == 120.0

    def test_missing_offpage_defaults_zero(self):
        feats = _extract_company_features({})
        assert all(v == 0.0 for v in feats.values())

    def test_none_values_default_zero(self):
        company = {"offpage": {"thirdparty_mentions": None}}
        feats = _extract_company_features(company)
        assert feats["offpage.thirdparty_mentions"] == 0.0

    def test_returns_all_expected_keys(self):
        company = {"offpage": {"thirdparty_mentions": 5}}
        feats = _extract_company_features(company)
        from src.rows import OFFPAGE_FEATURE_KEYS
        assert set(feats.keys()) == {f"offpage.{k}" for k in OFFPAGE_FEATURE_KEYS}

    def test_missing_key_defaults_zero(self):
        company = {"offpage": {}}
        feats = _extract_company_features(company)
        assert feats["offpage.thirdparty_mentions"] == 0.0


class TestBuildModelingTables:
    def test_returns_list_of_CategoryEngineTable(self):
        measurements = _load("measurements.json")
        pages = _load("pages.json")
        companies = _load("companies.json")

        tables = build_modeling_tables(measurements, pages, companies)
        assert len(tables) >= 1
        assert all(isinstance(t, CategoryEngineTable) for t in tables)

    def test_group_keys_are_correct(self):
        measurements = _load("measurements.json")
        pages = _load("pages.json")
        companies = _load("companies.json")

        tables = build_modeling_tables(measurements, pages, companies)
        keys = [(t.customer_id, t.category, t.engine) for t in tables]
        assert ("ws_acme", "GTM analytics", "openai") in keys

    def test_rows_have_feature_separation(self):
        measurements = _load("measurements.json")
        pages = _load("pages.json")
        companies = _load("companies.json")

        tables = build_modeling_tables(measurements, pages, companies)
        for t in tables:
            for r in t.rows:
                assert isinstance(r.page_features, dict)
                assert isinstance(r.company_features, dict)
                assert len(r.page_features) > 0
                assert len(r.company_features) > 0
                # No overlap between feature namespaces
                assert not set(r.page_features) & set(r.company_features)

    def test_winner_loser_classification(self):
        measurements = _load("measurements.json")
        pages = _load("pages.json")
        companies = _load("companies.json")

        tables = build_modeling_tables(measurements, pages, companies)
        for t in tables:
            for r in t.rows:
                if r.P_cited > 0:
                    assert r.is_winner is True
                else:
                    assert r.is_winner is False

    def test_loser_from_fixture(self):
        measurements = _load("measurements.json")
        pages = _load("pages.json")
        companies = _load("companies.json")

        tables = build_modeling_tables(measurements, pages, companies)
        acme_row = None
        for t in tables:
            for r in t.rows:
                if r.page_url == "https://acme.com/pricing":
                    acme_row = r
        assert acme_row is not None
        assert acme_row.is_winner is False
        assert acme_row.P_cited == 0.0

    def test_winner_from_fixture(self):
        measurements = _load("measurements.json")
        pages = _load("pages.json")
        companies = _load("companies.json")

        tables = build_modeling_tables(measurements, pages, companies)
        comp_row = None
        for t in tables:
            for r in t.rows:
                if r.page_url == "https://competitor.com/pricing":
                    comp_row = r
        assert comp_row is not None
        assert comp_row.is_winner is True
        assert comp_row.P_cited == 1.0

    def test_n_companies_is_effective_n(self):
        measurements = _load("measurements.json")
        pages = _load("pages.json")
        companies = _load("companies.json")

        tables = build_modeling_tables(measurements, pages, companies)
        for t in tables:
            cluster_ids = {r.cluster_id for r in t.rows}
            assert t.n_companies == len(cluster_ids)
            assert t.n_companies <= t.n_rows

    def test_n_rows_counts_page_level_rows(self):
        measurements = _load("measurements.json")
        pages = _load("pages.json")
        companies = _load("companies.json")

        tables = build_modeling_tables(measurements, pages, companies)
        for t in tables:
            assert t.n_rows == len(t.rows)

    def test_ci_weight_attached_per_row(self):
        measurements = _load("measurements.json")
        pages = _load("pages.json")
        companies = _load("companies.json")

        tables = build_modeling_tables(measurements, pages, companies)
        for t in tables:
            for r in t.rows:
                assert r.weight > 0
                assert r.weight < 2000  # sane bound

    def test_unknown_page_url_skipped(self):
        measurements = [{"page_url": "https://unknown.com/x", "engine": "openai", "P_cited": 0.5}]
        pages = _load("pages.json")
        companies = _load("companies.json")
        tables = build_modeling_tables(measurements, pages, companies)
        assert len(tables) == 0

    def test_unknown_company_domain_skipped(self):
        measurements = [{"page_url": "https://nobody.com/x", "engine": "openai", "P_cited": 0.5}]
        page = {
            "url": "https://nobody.com/x",
            "company_domain": "nobody.com",
            "content_features": {},
        }
        pages = _load("pages.json") + [page]
        companies = _load("companies.json")
        tables = build_modeling_tables(measurements, pages, companies)
        assert len(tables) == 0

    def test_company_features_identical_across_same_company(self):
        measurements = _load("measurements.json")
        pages = _load("pages.json")
        companies = _load("companies.json")

        # Add second page for acme
        pages = list(pages)
        pages.append({
            "url": "https://acme.com/about",
            "company_domain": "acme.com",
            "content_features": {
                "schema_markup": False, "comparison_table": False,
                "word_count": 320, "heading_structure": 2,
                "freshness_days": 90, "query_term_coverage": 0.3,
                "direct_answer_first": False, "stats_density": 0.0,
                "citation_density": 0.0, "listicle_vs_prose": 0.1,
            },
        })
        measurements = list(measurements)
        measurements.append({
            "workspaceId": "ws_acme",
            "page_url": "https://acme.com/about",
            "engine": "openai",
            "P_cited": 0.1, "ci_low": 0.0, "ci_high": 0.3,
        })

        tables = build_modeling_tables(measurements, pages, companies)
        for t in tables:
            acme_rows = [r for r in t.rows if r.cluster_id == "acme.com"]
            if len(acme_rows) >= 2:
                for k in acme_rows[0].company_features:
                    vals = {r.company_features[k] for r in acme_rows}
                    assert len(vals) == 1, f"{k} differs: {vals}"

    def test_page_features_differ_across_same_company(self):
        measurements = _load("measurements.json")
        pages = _load("pages.json")
        companies = _load("companies.json")

        pages = list(pages)
        pages.append({
            "url": "https://acme.com/about",
            "company_domain": "acme.com",
            "content_features": {
                "schema_markup": False, "comparison_table": False,
                "word_count": 320, "heading_structure": 2,
                "freshness_days": 90, "query_term_coverage": 0.3,
                "direct_answer_first": False, "stats_density": 0.0,
                "citation_density": 0.0, "listicle_vs_prose": 0.1,
            },
        })
        measurements = list(measurements)
        measurements.append({
            "workspaceId": "ws_acme",
            "page_url": "https://acme.com/about",
            "engine": "openai",
            "P_cited": 0.1, "ci_low": 0.0, "ci_high": 0.3,
        })

        tables = build_modeling_tables(measurements, pages, companies)
        for t in tables:
            acme_rows = [r for r in t.rows if r.cluster_id == "acme.com"]
            if len(acme_rows) >= 2:
                wc = {r.page_features.get("word_count") for r in acme_rows}
                assert len(wc) > 1

    def test_per_engine_separation_no_pooling(self):
        measurements = _load("measurements.json")
        pages = _load("pages.json")
        companies = _load("companies.json")

        measurements = list(measurements)
        measurements.append({
            "workspaceId": "ws_acme",
            "page_url": "https://acme.com/pricing",
            "engine": "claude",
            "P_cited": 0.5, "ci_low": 0.3, "ci_high": 0.7,
        })

        tables = build_modeling_tables(measurements, pages, companies)
        engines = {(t.customer_id, t.category, t.engine) for t in tables}
        assert ("ws_acme", "GTM analytics", "openai") in engines
        assert ("ws_acme", "GTM analytics", "claude") in engines

    def test_nan_ci_does_not_crash_pipeline(self):
        tables = build_modeling_tables(
            measurements=[{
                "workspaceId": "ws_test",
                "page_url": "https://test.com/p",
                "engine": "openai",
                "P_cited": 0.5,
                "ci_low": float("nan"),
                "ci_high": 0.75,
            }],
            pages=[{
                "url": "https://test.com/p",
                "company_domain": "test.com",
                "content_features": {"word_count": 100},
            }],
            companies=[{
                "domain": "test.com",
                "understanding": {"category": "test"},
                "offpage": {"thirdparty_mentions": 5},
            }],
        )
        assert len(tables) == 1
        r = tables[0].rows[0]
        import math
        assert math.isfinite(r.weight)
        assert r.weight == 1000.0

    def test_content_feature_keys_match_contract(self):
        from src.rows import CONTENT_FEATURE_KEYS
        contract_keys = {
            "schema_markup", "comparison_table", "word_count",
            "heading_structure", "freshness_days", "query_term_coverage",
            "direct_answer_first", "stats_density", "citation_density",
            "quote_density", "listicle_vs_prose",
        }
        assert set(CONTENT_FEATURE_KEYS) == contract_keys

    def test_offpage_feature_keys_match_contract(self):
        from src.rows import OFFPAGE_FEATURE_KEYS
        contract_keys = {
            "thirdparty_mentions", "reddit_presence", "g2_presence",
            "brand_search_volume", "wikipedia_presence", "review_site_presence",
            "backlink_density", "entity_cooccurrence",
        }
        assert set(OFFPAGE_FEATURE_KEYS) == contract_keys

    def test_none_p_cited_ci_treated_as_zero(self):
        tables = build_modeling_tables(
            measurements=[{
                "workspaceId": "ws_test",
                "page_url": "https://test.com/p",
                "engine": "openai",
                "P_cited": None,
                "ci_low": None,
                "ci_high": None,
            }],
            pages=[{
                "url": "https://test.com/p",
                "company_domain": "test.com",
                "content_features": {"word_count": 100},
            }],
            companies=[{
                "domain": "test.com",
                "understanding": {"category": "test"},
                "offpage": {"thirdparty_mentions": 5},
            }],
        )
        assert len(tables) == 1
        r = tables[0].rows[0]
        assert r.P_cited == 0.0
        assert r.ci_low == 0.0
        assert r.ci_high == 0.0
        assert r.weight == 1000.0  # degenerate CI fallback

    def test_cluster_id_matches_company_domain(self):
        measurements = _load("measurements.json")
        pages = _load("pages.json")
        companies = _load("companies.json")

        tables = build_modeling_tables(measurements, pages, companies)
        for t in tables:
            for r in t.rows:
                assert r.cluster_id in ("acme.com", "competitor.com")

    def test_missing_understanding_category_default(self):
        tables = build_modeling_tables(
            measurements=[{
                "workspaceId": "ws_test",
                "page_url": "https://test.com/p",
                "engine": "openai",
                "P_cited": 0.5, "ci_low": 0.25, "ci_high": 0.75,
            }],
            pages=[{
                "url": "https://test.com/p",
                "company_domain": "test.com",
                "content_features": {"word_count": 100},
            }],
            companies=[{
                "domain": "test.com",
                "offpage": {"thirdparty_mentions": 5},
            }],
        )
        assert len(tables) == 1
        assert tables[0].category == "unknown"


class TestBuildModelingTablesFromSynthetic:
    def test_creates_one_row_per_page(self):
        pages = _load("pages.json")
        companies = _load("companies.json")

        tables = build_modeling_tables_from_synthetic(pages, companies)
        total_rows = sum(t.n_rows for t in tables)
        assert total_rows == len(pages)

    def test_default_P_cited_is_0_5(self):
        pages = _load("pages.json")
        companies = _load("companies.json")

        tables = build_modeling_tables_from_synthetic(pages, companies)
        for t in tables:
            for r in t.rows:
                assert r.P_cited == 0.5
                assert r.is_winner is True  # 0.5 > 0

    def test_skips_orphan_pages_no_company(self):
        pages = [{"url": "https://orphan.com/p", "company_domain": "orphan.com"}]
        companies = _load("companies.json")
        tables = build_modeling_tables_from_synthetic(pages, companies)
        assert len(tables) == 0

    def test_default_engine_openai(self):
        pages = _load("pages.json")
        companies = _load("companies.json")

        tables = build_modeling_tables_from_synthetic(pages, companies)
        for t in tables:
            assert t.engine == "openai"


class TestWeightedFitRowModel:
    def test_full_construction(self):
        row = WeightedFitRow(
            page_url="https://example.com/p",
            cluster_id="example.com",
            is_winner=True,
            P_cited=0.8,
            ci_low=0.6,
            ci_high=0.95,
            weight=1 / 0.35,
            page_features={"word_count": 500.0},
            company_features={"offpage.mentions": 10.0},
        )
        assert row.is_winner is True
        assert row.weight == pytest.approx(1 / 0.35)
