import json
import pytest
from fastapi.testclient import TestClient
from src.service import app
from src.models import FitJobRequest, FitJobResponse

client = TestClient(app)


def test_health():
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


class TestFit:
    FIXTURE_PATH = "tests/integration/fixtures/measurements.json"

    def _make_row(self, page_url: str, cluster_id: str, **feats) -> dict:
        return {"page_url": page_url, "cluster_id": cluster_id, "features": feats}

    def test_fit_returns_valid_model_fit(self):
        rows = [
            self._make_row("https://acme.com/pricing", "acme.com", comparison_table=1.0, word_count=0.75),
            self._make_row("https://acme.com/about", "acme.com", comparison_table=0.0, word_count=0.50),
            self._make_row("https://competitor.com/pricing", "competitor.com", comparison_table=1.0, word_count=0.90),
        ]
        body = {"customer_id": "ws_acme", "category": "GTM analytics", "engine": "openai", "rows": rows}
        resp = client.post("/fit", json=body)

        assert resp.status_code == 200
        data = resp.json()
        assert "coefficients" in data
        assert data["n_rows"] == 3
        assert data["prior_version"] == "dummy-0.0.0"
        assert isinstance(data["top_hypotheses"], list)

    def test_n_companies_equals_distinct_clusters(self):
        rows = [
            self._make_row("https://a.com/p1", "company_a", feat=1.0),
            self._make_row("https://a.com/p2", "company_a", feat=2.0),
            self._make_row("https://b.com/p1", "company_b", feat=3.0),
            self._make_row("https://c.com/p1", "company_c", feat=4.0),
        ]
        body = {"customer_id": "ws_test", "category": "test", "engine": "openai", "rows": rows}
        resp = client.post("/fit", json=body)

        assert resp.status_code == 200
        data = resp.json()
        assert data["n_companies"] == 3
        assert data["n_rows"] == 4

    def test_single_company_n_companies_is_one(self):
        rows = [
            self._make_row("https://acme.com/p1", "acme.com", feat=1.0),
            self._make_row("https://acme.com/p2", "acme.com", feat=2.0),
        ]
        body = {"customer_id": "ws_test", "category": "test", "engine": "openai", "rows": rows}
        resp = client.post("/fit", json=body)
        assert resp.json()["n_companies"] == 1

    def test_coefficients_match_feature_names(self):
        rows = [
            self._make_row("https://a.com/p1", "a", alpha=0.5, beta=0.3),
            self._make_row("https://b.com/p1", "b", alpha=0.7, gamma=0.1),
        ]
        body = {"customer_id": "ws_test", "category": "test", "engine": "openai", "rows": rows}
        resp = client.post("/fit", json=body)
        features = {c["feature"] for c in resp.json()["coefficients"]}
        assert features == {"alpha", "beta", "gamma"}

    def test_request_response_round_trip(self):
        rows = [
            self._make_row("https://a.com/p1", "a", x=1.0),
            self._make_row("https://b.com/p1", "b", y=2.0),
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
