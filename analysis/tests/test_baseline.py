"""Phase-1 baseline-yardstick tests (records built inline — no fixtures/ dependency)."""

from __future__ import annotations

from src.assembly import build_fit_request
from src.baseline import fit_baseline
from src.contract import FitRequest, FitRow, ModelFit


def _request(rows: list[FitRow]) -> FitRequest:
    return FitRequest(
        customer_id="cust-1",
        category="crm",
        engine="openai",
        prior_version="phase1-baseline-v0",
        rows=rows,
    )


def _learnable_rows(n: int = 12) -> list[FitRow]:
    """Two features, outcome separable on f1 so the classifier has something to fit."""
    rows: list[FitRow] = []
    for i in range(n):
        high = i >= n // 2
        rows.append(
            FitRow(
                page_url=f"acme.com/p{i}",
                company_domain=f"co{i % 4}.com",  # 4 companies -> effective N < rows
                p_cited=0.8 if high else 0.2,
                features={"page__f1": float(i), "company__c1": float(i % 2)},
            )
        )
    return rows


def test_fit_baseline_returns_valid_modelfit_with_one_coef_per_feature():
    request = _request(_learnable_rows())
    metrics, fit = fit_baseline(request)

    assert isinstance(fit, ModelFit)
    feature_names = request.feature_names()
    assert len(fit.coefficients) == len(feature_names)
    assert {c.feature for c in fit.coefficients} == set(feature_names)
    assert all(isinstance(c.noise_flag, bool) for c in fit.coefficients)
    assert fit.n_rows == len(request.rows)
    assert fit.n_companies == request.n_companies() == 4
    assert fit.top_hypotheses == []

    # NaN/inf would pass pydantic but break Convex JSON — assert it round-trips.
    restored = ModelFit.model_validate_json(fit.model_dump_json())
    assert len(restored.coefficients) == len(feature_names)

    assert metrics.n_features == len(feature_names)
    assert 0.0 <= metrics.in_sample_accuracy <= 1.0


def test_fit_baseline_degrades_gracefully_at_tiny_n():
    # Single outcome class (all losers) + 2 rows: must not crash, must be inconclusive.
    rows = [
        FitRow(page_url="acme.com/a", company_domain="acme.com", p_cited=0.1, features={"page__f1": 1.0}),
        FitRow(page_url="acme.com/b", company_domain="acme.com", p_cited=0.2, features={"page__f1": 2.0}),
    ]
    metrics, fit = fit_baseline(_request(rows))

    assert isinstance(fit, ModelFit)
    assert metrics.inconclusive is True
    assert metrics.cv_auc is None
    assert len(fit.coefficients) == 1
    assert all(c.noise_flag for c in fit.coefficients)
    # still JSON-clean
    ModelFit.model_validate_json(fit.model_dump_json())


def test_phase1_dod_assembled_rows_flow_into_baseline_fit():
    """DoD: real-shaped records -> assembled rows -> baseline fit -> valid model_fit."""
    companies = [
        {"domain": f"co{i}.com", "firmographics": {"headcount_growth": 0.1 * i},
         "offpage": {"g2_presence": i % 2 == 0}}
        for i in range(6)
    ]
    pages = [{"company_domain": f"co{i}.com", "url": f"https://co{i}.com/p",
              "content_features": {"word_count": 500 + 100 * i, "schema_markup": i % 2 == 0}}
             for i in range(6)]
    measurements = [{"engine": "openai", "page_url": f"https://co{i}.com/p",
                     "p_cited": 0.8 if i >= 3 else 0.2,
                     "ci_low": 0.1, "ci_high": 0.3} for i in range(6)]

    request = build_fit_request(
        measurements, pages, companies,
        customer_id="cust-1", category="crm", engine="openai",
    )
    assert request.n_companies() == 6
    feature_names = request.feature_names()
    assert any(n.startswith("page__") for n in feature_names)
    assert any(n.startswith("company__") for n in feature_names)

    metrics, fit = fit_baseline(request)
    assert isinstance(fit, ModelFit)
    assert len(fit.coefficients) == len(feature_names)
    assert metrics.n_companies == 6
    ModelFit.model_validate_json(fit.model_dump_json())
