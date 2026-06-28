"""The P4 analysis service (FastAPI).

Phase 0: a small HTTP service a Convex action calls over HTTP. Endpoints:

  GET  /health            -> liveness/readiness probe
  POST /fit               -> submit a fit job; returns a FitJob (status "queued")
  GET  /fit/{job_id}      -> poll a fit job; result populated when complete

The fit compute is the Phase-0 stub (:mod:`src.dummy`); Phase 4 replaces it with
the real Bayesian generator behind this same contract.

Run locally:  uvicorn src.service:app --reload
"""

from __future__ import annotations

from fastapi import BackgroundTasks, FastAPI, HTTPException

from .contract import FitJob, FitRequest
from .dummy import dummy_model_fit
from .jobs import JobStore

SERVICE = "gtm-radar-analysis"
VERSION = "0.0.0"

app = FastAPI(title="GTM Radar — P4 Analysis Service", version=VERSION)
_store = JobStore()


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "service": SERVICE, "version": VERSION}


@app.post("/fit", response_model=FitJob, status_code=202)
def submit_fit(request: FitRequest, background: BackgroundTasks) -> FitJob:
    """Accept a fit job and run it off the request path. Returns immediately with
    a ``job_id`` the caller (the Convex action) polls via ``GET /fit/{job_id}``."""
    job_id = _store.create()
    background.add_task(_store.run, job_id, request, dummy_model_fit)
    job = _store.get(job_id)
    assert job is not None  # just created
    return job


@app.get("/fit/{job_id}", response_model=FitJob)
def get_fit(job_id: str) -> FitJob:
    job = _store.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"unknown job_id: {job_id}")
    return job
