"""Row assembly tests — measurement ↔ page ↔ company join."""

import json
from pathlib import Path
from src.rows import build_fit_requests, assemble_fit_rows_to_frame

FIXTURES = Path(__file__).resolve().parent.parent.parent / "tests" / "integration" / "fixtures"


def _load(name: str):
    with open(FIXTURES / name) as f:
        return json.load(f)


class TestBuildFitRequests:
    def test_joins_measurements_to_pages_to_companies(self):
        measurements = _load("measurements.json")
        pages = _load("pages.json")
        companies = _load("companies.json")

        requests = build_fit_requests(measurements, pages, companies)

        assert len(requests) >= 1

    def test_every_row_has_cluster_id(self):
        measurements = _load("measurements.json")
        pages = _load("pages.json")
        companies = _load("companies.json")

        for req in build_fit_requests(measurements, pages, companies):
            for row in req.rows:
                assert row.cluster_id, f"Missing cluster_id for {row.page_url}"

    def test_cluster_id_is_company_domain(self):
        measurements = _load("measurements.json")
        pages = _load("pages.json")
        companies = _load("companies.json")

        for req in build_fit_requests(measurements, pages, companies):
            for row in req.rows:
                assert row.cluster_id in ("acme.com", "competitor.com")

    def test_features_include_content_and_offpage(self):
        measurements = _load("measurements.json")
        pages = _load("pages.json")
        companies = _load("companies.json")

        reqs = build_fit_requests(measurements, pages, companies)
        all_feats = set()
        for req in reqs:
            for row in req.rows:
                all_feats.update(row.features.keys())

        assert "word_count" in all_feats
        assert "comparison_table" in all_feats
        assert "offpage.thirdparty_mentions" in all_feats
        assert "offpage.brand_search_volume" in all_feats

    def test_P_cited_carried_from_measurement(self):
        measurements = _load("measurements.json")
        pages = _load("pages.json")
        companies = _load("companies.json")

        reqs = build_fit_requests(measurements, pages, companies)
        p_citeds = []
        for req in reqs:
            for row in req.rows:
                p_citeds.append(row.P_cited)

        assert 0.0 in p_citeds
        assert 1.0 in p_citeds

    def test_unknown_page_is_skipped(self):
        measurements = [{"page_url": "https://unknown.com/page", "engine": "openai", "P_cited": 0.5}]
        pages = _load("pages.json")
        companies = _load("companies.json")
        reqs = build_fit_requests(measurements, pages, companies)
        assert len(reqs) == 0

    def test_assemble_fit_rows_to_frame_shape(self):
        rows = [
            type("Row", (), {"features": {"a": 1.0, "b": 2.0}, "P_cited": 0.8, "cluster_id": "c1"}),
            type("Row", (), {"features": {"a": 0.5, "b": 3.0}, "P_cited": 0.2, "cluster_id": "c2"}),
        ]
        X, y, feature_names, cluster_ids = assemble_fit_rows_to_frame(rows)
        assert X.shape == (2, 2)
        assert y is not None
        assert y.shape == (2,)
        assert set(feature_names) == {"a", "b"}
        assert cluster_ids == ["c1", "c2"]


class TestBuildFitRequestsFromFixture:
    """End-to-end: load fixtures → build → verify grouping."""

    def test_groups_by_customer_category_engine(self):
        measurements = _load("measurements.json")
        pages = _load("pages.json")
        companies = _load("companies.json")

        reqs = build_fit_requests(measurements, pages, companies)

        keys = [(r.customer_id, r.category, r.engine) for r in reqs]
        assert ("ws_acme", "GTM analytics", "openai") in keys
