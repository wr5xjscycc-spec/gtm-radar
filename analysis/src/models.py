from pydantic import BaseModel, Field
from typing import Optional


class FitRow(BaseModel):
    page_url: str
    cluster_id: str
    P_cited: Optional[float] = None
    features: dict[str, float]


class FitJobRequest(BaseModel):
    customer_id: str
    category: str
    engine: str
    rows: list[FitRow]


class Coefficient(BaseModel):
    feature: str
    posterior_median: float
    ci_low: float
    ci_high: float
    noise_flag: bool


class FitJobResponse(BaseModel):
    coefficients: list[Coefficient]
    prior_version: str
    top_hypotheses: list[str]
    n_companies: int
    n_rows: int


class AsyncFitJobStatus(BaseModel):
    job_id: str
    status: str


class HealthResponse(BaseModel):
    status: str


class PageMatchInput(BaseModel):
    page_url: str
    cluster_id: str
    topical_cluster: str
    P_cited: Optional[float] = None
    content_features: dict[str, float]


class MatchPair(BaseModel):
    page_treatment: str
    page_control: str
    topical_cluster_treatment: str
    topical_cluster_control: str
    distance: float
    match_covars: dict[str, float]


class BaselineMetrics(BaseModel):
    accuracy: float
    n_features: int
    n_rows: int
    n_companies: int
