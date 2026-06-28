from fastapi import FastAPI

from src.models import FitJobRequest, FitJobResponse, HealthResponse
from src.baseline import fit_baseline

app = FastAPI(title="gtm-radar-analysis", version="0.1.0")


@app.get("/health", response_model=HealthResponse)
async def health():
    return HealthResponse(status="ok")


@app.post("/fit", response_model=FitJobResponse)
async def fit(req: FitJobRequest):
    rows = req.rows
    cluster_ids = {r.cluster_id for r in rows}
    n_companies = len(cluster_ids)
    n_rows = len(rows)

    coefficients, top_hypotheses, _metrics = fit_baseline(
        rows, prior_version="baseline-ridge-0.1.0"
    )

    return FitJobResponse(
        coefficients=coefficients,
        prior_version="baseline-ridge-0.1.0",
        top_hypotheses=top_hypotheses,
        n_companies=n_companies,
        n_rows=n_rows,
    )
