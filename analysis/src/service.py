from fastapi import FastAPI
from src.models import FitJobRequest, FitJobResponse, Coefficient, HealthResponse

app = FastAPI(title="gtm-radar-analysis", version="0.0.0")


@app.get("/health", response_model=HealthResponse)
async def health():
    return HealthResponse(status="ok")


@app.post("/fit", response_model=FitJobResponse)
async def fit(req: FitJobRequest):
    rows = req.rows
    cluster_ids = {r.cluster_id for r in rows}
    n_companies = len(cluster_ids)
    n_rows = len(rows)

    features = sorted({k for r in rows for k in r.features})
    coefficients = [
        Coefficient(
            feature=f,
            posterior_median=0.0,
            ci_low=0.0,
            ci_high=0.0,
            noise_flag=True,
        )
        for f in features
    ]

    return FitJobResponse(
        coefficients=coefficients,
        prior_version="dummy-0.0.0",
        top_hypotheses=[],
        n_companies=n_companies,
        n_rows=n_rows,
    )
