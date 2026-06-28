"""The fit-job wire contract between the Convex action (TypeScript) and this
Python analysis service.

This is the *serialization boundary* the Phase-0 card tells us to nail down first
(`docs/phase-cards/P4-Intelligence-and-Loop.md` §Phase 0 gotcha). A Convex action
serializes a ``FitRequest`` to JSON, POSTs it, polls for the job, and deserializes
a ``ModelFit`` to write back as the ``model_fit`` record from ``docs/CONTRACT.md``.

Pydantic v2 gives us validation + stable JSON (camel/snake stays snake_case to match
the Convex record field names exactly — joins break silently on a renamed field).
"""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator

Engine = Literal["openai", "perplexity", "gemini"]
JobStatus = Literal["queued", "running", "complete", "failed"]


class FitRow(BaseModel):
    """One assembled page-level modeling row.

    The unit is the *page*; the cluster is the *company* (``company_domain``).
    Carrying the cluster id on every row from Phase 0 is non-negotiable: effective
    N = number of companies, not rows, and retrofitting the cluster id later is
    painful (Phase 1 card, Phase 3 gotcha).
    """

    page_url: str
    company_domain: str = Field(..., description="cluster id; effective-N unit")
    p_cited: float = Field(..., ge=0.0, le=1.0, description="outcome: a rate, not a coin flip")
    ci_width: Optional[float] = Field(
        default=None, description="width of P(cited) CI; lets the model down-weight noisy labels"
    )
    label: Optional[Literal["winner", "loser"]] = None
    features: dict[str, float] = Field(default_factory=dict)


class FitRequest(BaseModel):
    """A request to fit one (category, engine) slice. Never pool engines (~11% overlap)."""

    customer_id: str
    category: str
    engine: Engine
    prior_version: str = "phase0-dummy-v0"
    rows: list[FitRow]
    # Optional explicit feature list; if omitted we take the union of keys across rows.
    features: Optional[list[str]] = None

    @field_validator("rows")
    @classmethod
    def _non_empty(cls, v: list[FitRow]) -> list[FitRow]:
        if not v:
            raise ValueError("FitRequest.rows must be non-empty")
        return v

    def feature_names(self) -> list[str]:
        if self.features:
            return list(self.features)
        names: set[str] = set()
        for row in self.rows:
            names.update(row.features.keys())
        return sorted(names)

    def n_companies(self) -> int:
        """Effective N = distinct companies (pseudo-replication guard)."""
        return len({row.company_domain for row in self.rows})


class Coefficient(BaseModel):
    """One feature's posterior summary. Mirrors a ``model_fit.coefficients[]`` entry."""

    feature: str
    posterior_median: float
    ci_low: float
    ci_high: float
    noise_flag: bool = Field(
        ..., description="True when the credible interval crosses zero (nothing claimable)"
    )

    @field_validator("ci_high")
    @classmethod
    def _ordered(cls, ci_high: float, info) -> float:
        ci_low = info.data.get("ci_low")
        if ci_low is not None and ci_high < ci_low:
            raise ValueError("ci_high must be >= ci_low")
        return ci_high


class ModelFit(BaseModel):
    """The ``model_fit`` record this lane writes (``docs/CONTRACT.md`` #6).

    Epistemic layer = *hypotheses with uncertainty*. This record must never carry
    causal language; causation is earned only by a ``lift_result`` (Phase 5).
    """

    id: str
    customer_id: str
    category: str
    engine: Engine
    coefficients: list[Coefficient]
    prior_version: str
    top_hypotheses: list[str] = Field(default_factory=list)
    n_companies: int = Field(..., description="effective N — surfaced so the UI shows how thin the data is")
    n_rows: int


class FitJob(BaseModel):
    """Async job envelope. Submit returns one of these (status ``queued``); poll
    returns it with ``result`` populated once ``status == "complete"``."""

    job_id: str
    status: JobStatus
    result: Optional[ModelFit] = None
    error: Optional[str] = None
