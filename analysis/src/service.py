"""The P4 analysis service (FastAPI).

A small HTTP service the Convex actions call over HTTP. Endpoints:

  GET  /health                     -> liveness/readiness probe
  POST /fit                        -> submit a Bayesian fit job; returns a FitJob (queued)
  GET  /fit/{job_id}               -> poll a fit job; ModelFit populated when complete
  POST /estimate-lift              -> submit a DiD causal-lift job; returns a LiftJob (queued)
  GET  /estimate-lift/{job_id}     -> poll a lift job; LiftResult populated when complete

Both compute paths are the *real* Phase-4 brain, plugged in behind the same
async wire contract the Phase-0 stub established (submit returns a ``job_id`` the
Convex action polls):

  * ``/fit`` runs the regularized-horseshoe Bayesian logistic generator
    (:func:`src.fit_real.real_model_fit` -> :func:`src.bayes.fit_bayesian_logistic`).
  * ``/estimate-lift`` runs the randomized matched-pair difference-in-differences
    estimator (:func:`src.did.estimate_lift`) — the only causal (Rung-2) record.

The fits are slow, so each runs off the request path via ``BackgroundTasks`` and an
in-memory job store (``JobStore`` for fits, ``LiftJobStore`` for lifts).

Run locally:  uvicorn src.service:app --reload
"""

from __future__ import annotations

import threading
import uuid
from typing import Callable, Optional

from fastapi import BackgroundTasks, FastAPI, HTTPException
from pydantic import BaseModel

from .contract import Experiment, FitJob, FitRequest, JobStatus, LiftResult
from .did import estimate_lift
from .fit_real import real_model_fit
from .jobs import JobStore

SERVICE = "gtm-radar-analysis"
VERSION = "0.1.0"

app = FastAPI(title="GTM Radar — P4 Analysis Service", version=VERSION)
_store = JobStore()


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "service": SERVICE, "version": VERSION}


# --- /fit : real Bayesian model_fit ------------------------------------------
@app.post("/fit", response_model=FitJob, status_code=202)
def submit_fit(request: FitRequest, background: BackgroundTasks) -> FitJob:
    """Accept a fit job and run the real Bayesian fit off the request path. Returns
    immediately with a ``job_id`` the caller (the Convex ``runFit`` action) polls via
    ``GET /fit/{job_id}``."""
    job_id = _store.create()
    background.add_task(_store.run, job_id, request, real_model_fit)
    job = _store.get(job_id)
    assert job is not None  # just created
    return job


@app.get("/fit/{job_id}", response_model=FitJob)
def get_fit(job_id: str) -> FitJob:
    job = _store.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"unknown job_id: {job_id}")
    return job


# --- /estimate-lift : real difference-in-differences causal lift --------------
class LiftRequest(BaseModel):
    """Wire request for the DiD estimator. Mirrors :func:`src.did.estimate_lift`'s
    arguments: a randomized matched-pair ``Experiment`` plus the windowed
    (baseline + post) ``measurements`` to estimate the causal lift over.

    ``measurements`` are passed through as raw dicts exactly as ``did`` expects
    (``page_url``/``engine``/``window_tag``/``P_cited``|``cited``/``ts`` ...); the
    estimator filters to ``engine`` and to the experiment's pages itself."""

    experiment: Experiment
    measurements: list[dict]
    engine: str = "openai"
    computed_at: str
    lift_id: str


class LiftJob(BaseModel):
    """Async envelope for a lift job — the lift-side analogue of :class:`FitJob`.
    Submit returns one with ``status="queued"``; poll returns it with ``result``
    (a :class:`~src.contract.LiftResult`) populated once ``status == "complete"``."""

    job_id: str
    status: JobStatus
    result: Optional[LiftResult] = None
    error: Optional[str] = None


class LiftJobStore:
    """In-memory async job registry for lift jobs.

    A parallel of :class:`src.jobs.JobStore`, kept separate because that store's
    envelope (:class:`FitJob`) is typed to ``ModelFit``; a lift job carries a
    ``LiftResult``. Same lifecycle (queued -> running -> complete/failed), same
    process-local / non-durable scope (Phase 4/5 swaps in a real queue without
    changing the HTTP contract)."""

    def __init__(self) -> None:
        self._jobs: dict[str, LiftJob] = {}
        self._lock = threading.Lock()

    def create(self) -> str:
        job_id = uuid.uuid4().hex
        with self._lock:
            self._jobs[job_id] = LiftJob(job_id=job_id, status="queued")
        return job_id

    def get(self, job_id: str) -> LiftJob | None:
        with self._lock:
            return self._jobs.get(job_id)

    def _set(self, job_id: str, **fields) -> None:
        with self._lock:
            job = self._jobs[job_id]
            self._jobs[job_id] = job.model_copy(update=fields)

    def run(
        self,
        job_id: str,
        request: LiftRequest,
        compute: Callable[[LiftRequest, str], LiftResult],
    ) -> None:
        """Execute ``compute`` for a lift job, recording status transitions.
        Failures are captured on the job as ``status="failed"`` (the DiD estimator
        itself never crashes on a degenerate panel — it returns ``inconclusive``)."""
        self._set(job_id, status="running")
        try:
            result = compute(request, job_id)
            self._set(job_id, status="complete", result=result)
        except Exception as exc:  # noqa: BLE001 - surfaced to the caller via the job
            self._set(job_id, status="failed", error=f"{type(exc).__name__}: {exc}")


_lift_store = LiftJobStore()


def _compute_lift(request: LiftRequest, job_id: str) -> LiftResult:
    """Adapter: run the real DiD estimator for one ``LiftRequest``. ``lift_id`` and
    ``computed_at`` come from the request (the caller owns the record identity), not
    from the internal ``job_id``."""
    return estimate_lift(
        request.experiment,
        request.measurements,
        engine=request.engine,
        computed_at=request.computed_at,
        lift_id=request.lift_id,
    )


@app.post("/estimate-lift", response_model=LiftJob, status_code=202)
def submit_lift(request: LiftRequest, background: BackgroundTasks) -> LiftJob:
    """Accept a lift job and run the real DiD estimate off the request path. Returns
    immediately with a ``job_id`` the caller (the Convex ``runLift`` action) polls via
    ``GET /estimate-lift/{job_id}``."""
    job_id = _lift_store.create()
    background.add_task(_lift_store.run, job_id, request, _compute_lift)
    job = _lift_store.get(job_id)
    assert job is not None  # just created
    return job


@app.get("/estimate-lift/{job_id}", response_model=LiftJob)
def get_lift(job_id: str) -> LiftJob:
    job = _lift_store.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"unknown job_id: {job_id}")
    return job
