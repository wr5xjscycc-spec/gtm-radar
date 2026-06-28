"""In-memory async job registry.

Phase-0 scope: the polyglot boundary is designed *async-first* because real
Bayesian fits are slow (Phase-0 gotcha) — submit returns a ``job_id`` and the
caller polls. Here the compute is an instant stub, but the lifecycle
(queued -> running -> complete/failed) is real so the wire contract is locked.

This store is process-local and not durable; Phase 4/5 swaps it for a real queue
(Modal/Fly job, or a Convex-scheduled poll) without changing the HTTP contract.
"""

from __future__ import annotations

import threading
import uuid
from typing import Callable

from .contract import FitJob, FitRequest, ModelFit


class JobStore:
    def __init__(self) -> None:
        self._jobs: dict[str, FitJob] = {}
        self._lock = threading.Lock()

    def create(self) -> str:
        job_id = uuid.uuid4().hex
        with self._lock:
            self._jobs[job_id] = FitJob(job_id=job_id, status="queued")
        return job_id

    def get(self, job_id: str) -> FitJob | None:
        with self._lock:
            return self._jobs.get(job_id)

    def _set(self, job_id: str, **fields) -> None:
        with self._lock:
            job = self._jobs[job_id]
            self._jobs[job_id] = job.model_copy(update=fields)

    def run(
        self,
        job_id: str,
        request: FitRequest,
        compute: Callable[[FitRequest, str], ModelFit],
    ) -> None:
        """Execute ``compute`` for a job, recording status transitions.

        Intended to be invoked off the request path (BackgroundTasks / worker).
        Failures are captured on the job as ``status="failed"`` rather than raised,
        so the poll endpoint can report them honestly.
        """
        self._set(job_id, status="running")
        try:
            result = compute(request, job_id)
            self._set(job_id, status="complete", result=result)
        except Exception as exc:  # noqa: BLE001 - surfaced to the caller via the job
            self._set(job_id, status="failed", error=f"{type(exc).__name__}: {exc}")
