"""Service-level tests: health probe, async job lifecycle, dummy-fit shape, and
the REAL wired paths (Bayesian ``/fit`` and DiD ``/estimate-lift``)."""

from __future__ import annotations

import numpy as np

from src.contract import Experiment, ExperimentPair, FitJob, FitRequest, LiftResult
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


# --- REAL /fit (Bayesian) — proves the dummy stub is unplugged ---------------
def test_fit_endpoint_runs_the_real_bayesian_path(client, fit_request_payload):
    """``/fit`` on the seed fixture must run the REAL regularized-horseshoe fit, not
    the Phase-0 stub. The fixture is intentionally thin (4 rows / 3 companies), so at
    cold-start EPV the horseshoe honestly shrinks every coefficient to noise — forcing
    a "signal" here would be the exact overclaim the design forbids. We therefore
    assert the real path *ran*, via two things the dummy can never produce:

      1. ``prior_version == "phase4-reghs-v0"`` — the bulletproof distinguisher. The
         dummy passes the request's ``prior_version`` ("phase0-dummy-v0") straight
         through; only the real fit stamps the horseshoe version.
      2. Real (wide) credible intervals — the dummy's CIs are a tiny deterministic
         jitter (width <= ~0.3 by construction); the real posterior at N=3-4 is wide
         (width >> 1). A coefficient with CI width > 1.0 is impossible for the stub.
    """
    submit = FitJob.model_validate(client.post("/fit", json=fit_request_payload).json())
    job = _poll_to_terminal(client, submit.job_id)

    assert job.status == "complete", job.error
    fit = job.result
    assert fit is not None

    # (1) Real prior version — the stub would have echoed "phase0-dummy-v0".
    assert fit.prior_version == "phase4-reghs-v0"
    assert fit.prior_version != fit_request_payload["prior_version"]

    # Real assembly: one coefficient per labeled-row feature; honest effective N.
    feature_names = {
        f for r in fit_request_payload["rows"] for f in r["features"]
    }
    assert {c.feature for c in fit.coefficients} == feature_names
    assert fit.n_companies == 3  # acme + globex + initech (acme appears twice)
    assert fit.n_rows == 4

    # (2) Real credible intervals (wide at tiny N) — structurally impossible for the
    # dummy's bounded jitter. This is the "real CIs present" proof, NOT a signal claim.
    assert any((c.ci_high - c.ci_low) > 1.0 for c in fit.coefficients)
    for c in fit.coefficients:
        assert c.ci_low <= c.ci_high  # contract invariant holds on the real output

    # Honest at this N: all-noise / empty hypotheses is a correct result, not a bug.
    assert isinstance(fit.top_hypotheses, list)


# --- REAL /estimate-lift (DiD) ------------------------------------------------
_BASE_WEEKS = ["2026-05-04", "2026-05-11"]
_POST_WEEKS = ["2026-06-01", "2026-06-08"]


def _lift_experiment(n_pairs: int, exp_id: str = "exp_svc") -> Experiment:
    pairs = [
        ExperimentPair(
            treatment_page=f"https://t{i}.example/p",
            control_page=f"https://c{i}.example/p",
        )
        for i in range(n_pairs)
    ]
    return Experiment(
        id=exp_id, customer_id="cust_svc", pairs=pairs,
        baseline_window="2026-05", post_window="2026-06",
    )


def _lift_panel(exp: Experiment, *, lift: float, rng, base: float = 0.30,
                noise: float = 0.02, engine: str = "openai") -> list[dict]:
    """Windowed measurements with a known treatment lift in the post window (mirrors
    the proven ``test_did`` simulator: both arms share baseline + common time shock,
    so the only systematic post divergence is ``lift``)."""
    rows: list[dict] = []
    for pair in exp.pairs:
        for page, is_treat in ((pair.treatment_page, 1), (pair.control_page, 0)):
            for window, weeks in (("baseline", _BASE_WEEKS), ("post", _POST_WEEKS)):
                post = 1 if window == "post" else 0
                for week in weeks:
                    mean = base + lift * is_treat * post
                    val = float(np.clip(mean + rng.normal(0.0, noise), 0.0, 1.0))
                    rows.append({
                        "page_url": page, "engine": engine, "window_tag": window,
                        "P_cited": val, "ts": f"{week}T10:00:00Z",
                    })
    return rows


def _poll_lift_to_terminal(client, job_id: str, max_polls: int = 50):
    body = client.get(f"/estimate-lift/{job_id}").json()
    for _ in range(max_polls):
        if body["status"] in {"complete", "failed"}:
            break
        body = client.get(f"/estimate-lift/{job_id}").json()
    return body


def test_estimate_lift_endpoint_returns_a_real_lift_result(client):
    """``/estimate-lift`` must run the REAL DiD estimator end-to-end and return a
    causal ``LiftResult``. We plant a known +0.20 lift over 10 matched pairs (the same
    configuration ``test_did`` proves recovers a ``worked`` verdict), POST it, poll the
    async job to completion, and assert a real Rung-2 result — not a stub."""
    rng = np.random.default_rng(42)
    exp = _lift_experiment(n_pairs=10)
    measurements = _lift_panel(exp, lift=0.20, rng=rng)

    payload = {
        "experiment": exp.model_dump(),
        "measurements": measurements,
        "engine": "openai",
        "computed_at": "2026-06-15T00:00:00Z",
        "lift_id": "lift_svc_1",
    }

    submit = client.post("/estimate-lift", json=payload)
    assert submit.status_code == 202
    job_id = submit.json()["job_id"]

    body = _poll_lift_to_terminal(client, job_id)
    assert body["status"] == "complete", body.get("error")

    lift = LiftResult.model_validate(body["result"])
    assert lift.id == "lift_svc_1"
    assert lift.experiment_id == "exp_svc"
    assert lift.claim_rung == 2  # the causal record
    assert lift.computed_at == "2026-06-15T00:00:00Z"
    # Real estimator output (planted +0.20 lift): a genuine, significant positive lift.
    assert lift.estimate > 0
    assert lift.p_value is not None
    assert lift.verdict == "worked"


def test_estimate_lift_unknown_job_404(client):
    resp = client.get("/estimate-lift/does-not-exist")
    assert resp.status_code == 404


def test_estimate_lift_degenerate_is_inconclusive_not_crash(client):
    """An empty panel must degrade to a real ``inconclusive`` LiftResult (the honest
    "can't tell"), proving the endpoint surfaces the estimator's degeneracy guards
    rather than failing the job."""
    exp = _lift_experiment(n_pairs=4, exp_id="exp_deg")
    payload = {
        "experiment": exp.model_dump(),
        "measurements": [],
        "engine": "openai",
        "computed_at": "2026-06-15T00:00:00Z",
        "lift_id": "lift_deg",
    }
    job_id = client.post("/estimate-lift", json=payload).json()["job_id"]
    body = _poll_lift_to_terminal(client, job_id)
    assert body["status"] == "complete", body.get("error")
    lift = LiftResult.model_validate(body["result"])
    assert lift.verdict == "inconclusive"
    assert lift.ci_low < 0 < lift.ci_high  # wide sentinel = "we know nothing yet"
