from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime


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


class WeightedFitRow(BaseModel):
    page_url: str
    cluster_id: str
    is_winner: bool
    P_cited: float
    ci_low: float
    ci_high: float
    weight: float
    page_features: dict[str, float]
    company_features: dict[str, float]


class CategoryEngineTable(BaseModel):
    customer_id: str
    category: str
    engine: str
    rows: list[WeightedFitRow]
    n_companies: int
    n_rows: int


class BaselineMetrics(BaseModel):
    accuracy: float
    n_features: int
    n_rows: int
    n_companies: int


class ExperimentPair(BaseModel):
    treatment_page: str
    control_page: str
    match_covars: dict[str, float]


class Experiment(BaseModel):
    customer_id: str
    category: str
    engine: str
    hypothesis: str
    pairs: list[ExperimentPair]
    status: str  # designing | awaiting_publish | running | complete | expired


class LiftResult(BaseModel):
    experiment_id: str
    estimate: float
    ci_low: float
    ci_high: float
    p_value: float
    verdict: str  # worked | no_effect | inconclusive
    claim_rung: int = 2
    computed_at: str = ""


class Intervention(BaseModel):
    feature_changed: str
    category: str
    engine: str
    measured_lift: float
    ci_low: float
    ci_high: float
    experiment_id: str


class DeliverableAsset(BaseModel):
    page_url: str
    content_md: str
    tier: int  # 1 | 2 | 3


class CmsPublishPayload(BaseModel):
    page_url: str
    title: str
    body_html: str
    meta: dict[str, str]


class PlaybookStep(BaseModel):
    channel: str  # g2 | reddit | wikipedia | review_site
    action: str
    rationale: str
