"""Service-level tests: health probe, async job lifecycle, dummy-fit shape."""

from __future__ import annotations

from src.contract import FitJob, FitRequest
from src.dummy import dummy_model_fit


def test_health(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["service"] == "gtm-radar-analysis"


def test_submit_returns_job_id(client, fit_request_payload):
    resp = client.post("/fit", json=fit_request_payload)
    assert resp.status_code == 202
    job = FitJob.model_validate(resp.json())
    assert job.job_id
    assert job.status in {"queued", "running", "complete"}


def test_poll_unknown_job_404(client):
    resp = client.get("/fit/does-not-exist")
    assert resp.status_code == 404


def test_async_job_completes(client, fit_request_payload):
    job_id = FitJob.model_validate(client.post("/fit", json=fit_request_payload).json()).job_id

    # Poll the async contract to a terminal state (the stub is instant; bounded loop
    # keeps it deterministic if compute ever becomes truly background).
    job = _poll_to_terminal(client, job_id)
    assert job.status == "complete", job.error
    assert job.result is not None


def test_invalid_request_rejected(client, fit_request_payload):
    bad = {**fit_request_payload, "rows": []}  # empty rows -> validation error
    resp = client.post("/fit", json=bad)
    assert resp.status_code == 422


def test_dummy_fit_is_honest():
    """A stub claims nothing: every coefficient flagged noise, no hypotheses,
    and effective N is the company count — not the row count."""
    req = FitRequest.model_validate(
        {
            "customer_id": "c1",
            "category": "cat",
            "engine": "openai",
            "rows": [
                {"page_url": "https://a.example/1", "company_domain": "a.example",
                 "p_cited": 0.4, "features": {"f1": 1.0, "f2": 0.0}},
                {"page_url": "https://a.example/2", "company_domain": "a.example",
                 "p_cited": 0.1, "features": {"f1": 0.0, "f2": 1.0}},
                {"page_url": "https://b.example/1", "company_domain": "b.example",
                 "p_cited": 0.3, "features": {"f1": 1.0, "f2": 1.0}},
            ],
        }
    )
    fit = dummy_model_fit(req, fit_id="fit_x")

    assert fit.n_rows == 3
    assert fit.n_companies == 2  # effective N, not 3
    assert {c.feature for c in fit.coefficients} == {"f1", "f2"}
    assert all(c.noise_flag for c in fit.coefficients)
    assert all(c.ci_low < 0 < c.ci_high for c in fit.coefficients)  # CI straddles zero
    assert fit.top_hypotheses == []


def test_dummy_fit_deterministic():
    req = FitRequest.model_validate(
        {
            "customer_id": "c1", "category": "cat", "engine": "openai",
            "rows": [{"page_url": "https://a.example/1", "company_domain": "a.example",
                      "p_cited": 0.4, "features": {"f1": 1.0}}],
        }
    )
    a = dummy_model_fit(req, fit_id="x")
    b = dummy_model_fit(req, fit_id="x")
    assert a.model_dump() == b.model_dump()


def _poll_to_terminal(client, job_id: str, max_polls: int = 50) -> FitJob:
    job = FitJob.model_validate(client.get(f"/fit/{job_id}").json())
    for _ in range(max_polls):
        if job.status in {"complete", "failed"}:
            return job
        job = FitJob.model_validate(client.get(f"/fit/{job_id}").json())
    return job
