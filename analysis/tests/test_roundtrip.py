"""Phase-0 headline test: the Convex <-> Python <-> Convex round-trip (mocked).

DoD (P4 Phase 0): "Convex -> Python -> Convex round-trip works with a dummy fit."

P1 owns the real Convex action, so here we *simulate* it in-process: build a
``FitRequest`` from the seed fixture (the assembled rows a Convex action would
hold), POST over the in-process ASGI transport (no network in CI), poll the async
job, deserialize the ``ModelFit``, and assert it is a valid ``model_fit`` record
that Convex could store (JSON round-trippable, all contract fields, effective N
correct). This proves the polyglot boundary and the serialization contract.
"""

from __future__ import annotations

import json

from src.contract import FitJob, FitRequest, ModelFit


def convex_action_run_fit(client, assembled_rows: dict) -> dict:
    """Stand-in for the P1 Convex action that orchestrates a fit.

    Mirrors exactly what the TS action will do over HTTP:
      1. validate/serialize the fit request,
      2. POST /fit and read back a job_id,
      3. poll GET /fit/{job_id} until terminal,
      4. return the model_fit as a plain dict to persist as a Convex record.
    """
    request = FitRequest.model_validate(assembled_rows)
    payload = json.loads(request.model_dump_json())  # JSON crosses the wire

    submit = client.post("/fit", json=payload)
    assert submit.status_code == 202, submit.text
    job_id = FitJob.model_validate(submit.json()).job_id

    job = FitJob(job_id=job_id, status="queued")
    for _ in range(50):
        job = FitJob.model_validate(client.get(f"/fit/{job_id}").json())
        if job.status in {"complete", "failed"}:
            break
    assert job.status == "complete", f"fit did not complete: {job.error}"
    assert job.result is not None
    # What the Convex action writes back as the `model_fit` record:
    return json.loads(job.result.model_dump_json())


def test_convex_python_roundtrip(client, fit_request_payload):
    record = convex_action_run_fit(client, fit_request_payload)

    # The write-back is a valid model_fit per docs/CONTRACT.md #6.
    fit = ModelFit.model_validate(record)
    assert fit.customer_id == fit_request_payload["customer_id"]
    assert fit.category == fit_request_payload["category"]
    assert fit.engine == fit_request_payload["engine"]

    # Effective N = distinct company domains in the fixture (acme, globex, initech).
    expected_companies = len({r["company_domain"] for r in fit_request_payload["rows"]})
    assert fit.n_companies == expected_companies == 3
    assert fit.n_rows == len(fit_request_payload["rows"]) == 4

    # One coefficient per feature present in the rows.
    feature_union = set()
    for r in fit_request_payload["rows"]:
        feature_union.update(r["features"].keys())
    assert {c.feature for c in fit.coefficients} == feature_union

    # Honesty: a dummy fit asserts nothing causal/claimable.
    assert all(c.noise_flag for c in fit.coefficients)
    assert fit.top_hypotheses == []


def test_record_is_convex_serializable(client, fit_request_payload):
    """The returned record must survive a JSON round-trip (what Convex stores)."""
    record = convex_action_run_fit(client, fit_request_payload)
    assert json.loads(json.dumps(record)) == record
