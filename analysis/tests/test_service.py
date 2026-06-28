import json
import pytest
from fastapi.testclient import TestClient
from src.service import app
from src.models import FitJobRequest, FitJobResponse, FitRow

client = TestClient(app)


def test_health():
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


class TestFit:
    def _make_row(self, page_url, cluster_id, p_cited=None, **feats):
        d = {"page_url": page_url, "cluster_id": cluster_id, "features": feats}
        if p_cited is not None:
            d["P_cited"] = p_cited
        return d

    def test_fit_returns_valid_model_fit(self):
        rows = [
            self._make_row("https://acme.com/pricing", "acme.com", 0.0, comparison_table=1.0, word_count=0.75),
            self._make_row("https://acme.com/about", "acme.com", 0.5, comparison_table=0.0, word_count=0.50),
            self._make_row("https://competitor.com/pricing", "competitor.com", 1.0, comparison_table=1.0, word_count=0.90),
        ]
        body = {"customer_id": "ws_acme", "category": "GTM analytics", "engine": "openai", "rows": rows}
        resp = client.post("/fit", json=body)

        assert resp.status_code == 200
        data = resp.json()
        assert "coefficients" in data
        assert len(data["coefficients"]) == 2
        assert data["n_rows"] == 3
        assert isinstance(data["top_hypotheses"], list)

    def test_n_companies_equals_distinct_clusters(self):
        rows = [
            self._make_row("https://a.com/p1", "company_a", 0.5, feat=1.0),
            self._make_row("https://a.com/p2", "company_a", 0.5, feat=2.0),
            self._make_row("https://b.com/p1", "company_b", 0.5, feat=3.0),
            self._make_row("https://c.com/p1", "company_c", 0.5, feat=4.0),
        ]
        body = {"customer_id": "ws_test", "category": "test", "engine": "openai", "rows": rows}
        resp = client.post("/fit", json=body)

        assert resp.status_code == 200
        data = resp.json()
        assert data["n_companies"] == 3
        assert data["n_rows"] == 4

    def test_single_company_n_companies_is_one(self):
        rows = [
            self._make_row("https://acme.com/p1", "acme.com", 0.5, feat=1.0),
            self._make_row("https://acme.com/p2", "acme.com", 0.5, feat=2.0),
        ]
        body = {"customer_id": "ws_test", "category": "test", "engine": "openai", "rows": rows}
        resp = client.post("/fit", json=body)
        assert resp.json()["n_companies"] == 1

    def test_coefficients_match_feature_names(self):
        rows = [
            self._make_row("https://a.com/p1", "a", 0.5, alpha=0.5, beta=0.3),
            self._make_row("https://b.com/p1", "b", 0.5, alpha=0.7, gamma=0.1),
        ]
        body = {"customer_id": "ws_test", "category": "test", "engine": "openai", "rows": rows}
        resp = client.post("/fit", json=body)
        features = {c["feature"] for c in resp.json()["coefficients"]}
        assert features == {"alpha", "beta", "gamma"}

    def test_request_response_round_trip(self):
        rows = [
            self._make_row("https://a.com/p1", "a", 0.5, x=1.0),
            self._make_row("https://b.com/p1", "b", 0.5, y=2.0),
        ]
        body = FitJobRequest(customer_id="ws_test", category="test", engine="openai", rows=rows)
        payload = body.model_dump()
        resp = client.post("/fit", json=payload)
        assert resp.status_code == 200

        parsed = FitJobResponse(**resp.json())
        assert parsed.n_rows == 2
        assert parsed.n_companies == 2
        assert len(parsed.coefficients) == 2
        parsed_json = parsed.model_dump_json()
        recovered = FitJobResponse(**json.loads(parsed_json))
        assert recovered.n_rows == parsed.n_rows

    def test_baseline_fit_returns_nonzero_coefficients(self):
        rows = [
            self._make_row("https://a.com/p1", "a", 0.9, signal=5.0, noise=0.1),
            self._make_row("https://b.com/p1", "b", 0.1, signal=-5.0, noise=0.1),
            self._make_row("https://c.com/p1", "c", 0.9, signal=5.0, noise=-0.1),
            self._make_row("https://d.com/p1", "d", 0.1, signal=-5.0, noise=0.1),
        ]
        body = {"customer_id": "ws_test", "category": "test", "engine": "openai", "rows": rows}
        resp = client.post("/fit", json=body)
        assert resp.status_code == 200
        data = resp.json()
        coeffs = {c["feature"]: c for c in data["coefficients"]}
        assert abs(coeffs["signal"]["posterior_median"]) > abs(coeffs["noise"]["posterior_median"])
        assert data["prior_version"] == "baseline-ridge-0.1.0"

    def test_can_post_without_P_cited(self):
        rows = [
            {"page_url": "https://a.com/p1", "cluster_id": "a", "features": {"x": 1.0}},
        ]
        body = {"customer_id": "ws_test", "category": "test", "engine": "openai", "rows": rows}
        resp = client.post("/fit", json=body)
        assert resp.status_code == 200
        data = resp.json()
        assert data["n_rows"] == 1
        assert len(data["coefficients"]) == 1


@pytest.mark.skip(reason="Integration: requires fixture JSON files on disk")
class TestFixturePipeline:
    """End-to-end: load fixtures → build_fit_requests → POST /fit → model_fit.

    Enable manually by removing the skip marker when running from repo root.
    """

    def test_fixture_pipeline_returns_model_fit(self):
        import json
        from pathlib import Path
        from src.rows import build_fit_requests

        fix = Path("tests/integration/fixtures")
        measurements = json.loads((fix / "measurements.json").read_text())
        pages = json.loads((fix / "pages.json").read_text())
        companies = json.loads((fix / "companies.json").read_text())

        reqs = build_fit_requests(measurements, pages, companies)
        assert len(reqs) > 0

        for req in reqs:
            payload = FitJobRequest(
                customer_id=req.customer_id,
                category=req.category,
                engine=req.engine,
                rows=req.rows,
            )
            resp = client.post("/fit", json=payload.model_dump())
            assert resp.status_code == 200
            data = FitJobResponse(**resp.json())
            assert data.n_companies >= 1
            assert data.n_rows >= 1
            assert len(data.coefficients) >= 1
            assert data.prior_version == "baseline-ridge-0.1.0"
