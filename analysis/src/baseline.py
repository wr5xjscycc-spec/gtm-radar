"""scikit-learn baseline — a frequentist YARDSTICK, explicitly NOT the shipped model.

The shipped model is the Phase-4 Bayesian hypothesis generator (weakly-informative
priors + R2D2 shrinkage). This module fits an ordinary L2 logistic regression on a
binarized outcome only to sanity-check that the assembly pipeline produces rows a
classifier can learn from. It makes **no causal claim** and is never written to a
``model_fit`` the product renders — honesty discipline is part of this lane.

The ``ModelFit`` returned here is a yardstick rendering of the linear coefficients,
not a posterior. Its credible interval is a crude **Wald band** (coef ± 1.96·SE)
computed from the logistic Hessian on the standardized design. The band is
*approximate*: it ignores the L2 penalty that actually produced the coefficients,
so it overstates certainty slightly — fine for a yardstick, useless for a claim.
"""

from __future__ import annotations

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import cross_val_score
from sklearn.preprocessing import StandardScaler

from .contract import BaselineMetrics, Coefficient, FitRequest, ModelFit

# Minimum rows before attempting any cross-validated AUC; below this the estimate
# is noise, so we report `inconclusive` rather than a fabricated number.
_MIN_ROWS_FOR_CV = 8


def _finite(value: float, fallback: float = 0.0) -> float:
    """Scrub NaN/inf so the ModelFit stays JSON-serializable (Convex can't parse NaN)."""
    return float(value) if np.isfinite(value) else fallback


def _wald_se(design: np.ndarray, prob: np.ndarray) -> np.ndarray:
    """Crude logistic Wald SEs from the Hessian; ``pinv`` + clamps keep it finite.

    ``design`` includes an intercept column. Returns one SE per design column.
    """
    weights = prob * (1.0 - prob)
    xtwx = design.T @ (weights[:, None] * design)
    cov = np.linalg.pinv(xtwx)  # pinv survives singular Hessians at tiny N / separation
    diag = np.clip(np.diag(cov), 0.0, None)  # negative diag (numerical) -> 0 before sqrt
    return np.sqrt(diag)


def _noise_coefficients(features: list[str]) -> list[Coefficient]:
    """All-noise coefficient set for the degenerate (single-class / no-feature) case."""
    return [
        Coefficient(feature=f, posterior_median=0.0, ci_low=-1.0, ci_high=1.0, noise_flag=True)
        for f in features
    ]


def _model_fit(request: FitRequest, features: list[str], coefficients: list[Coefficient]) -> ModelFit:
    return ModelFit(
        id=f"baseline-{request.engine}-{request.category}",
        customer_id=request.customer_id,
        category=request.category,
        engine=request.engine,
        coefficients=coefficients,
        prior_version=request.prior_version,
        top_hypotheses=[],  # a yardstick proposes no hypotheses — that's Phase 4's job
        n_companies=request.n_companies(),
        n_rows=len(request.rows),
    )


def fit_baseline(request: FitRequest) -> tuple[BaselineMetrics, ModelFit]:
    """Fit the L2-logistic yardstick on ``p_cited >= 0.5`` and return (metrics, ModelFit).

    Degrades gracefully at tiny N: a single outcome class (or no features) yields an
    all-noise ModelFit and an ``inconclusive`` metrics record instead of crashing.
    """
    features = request.feature_names()
    n_rows = len(request.rows)
    n_companies = request.n_companies()

    x = np.array(
        [[float(row.features.get(name, 0.0)) for name in features] for row in request.rows],
        dtype=float,
    ).reshape(n_rows, len(features))
    y = np.array([1 if row.p_cited >= 0.5 else 0 for row in request.rows], dtype=int)

    # Degenerate: can't fit logistic regression without two classes or any feature.
    if len(features) == 0 or len(np.unique(y)) < 2:
        majority = float(np.mean(y)) if n_rows else 0.0
        metrics = BaselineMetrics(
            n_rows=n_rows,
            n_companies=n_companies,
            n_features=len(features),
            in_sample_accuracy=max(majority, 1.0 - majority) if n_rows else 0.0,
            cv_auc=None,
            cv_folds=None,
            inconclusive=True,
            note="single outcome class or no features — yardstick can claim nothing",
        )
        return metrics, _model_fit(request, features, _noise_coefficients(features))

    scaler = StandardScaler()
    xs = scaler.fit_transform(x)

    clf = LogisticRegression(C=1.0)  # default L2 — the red-team warns coefs blow up unregularized
    clf.fit(xs, y)
    coefs = clf.coef_[0]
    in_sample_accuracy = float(clf.score(xs, y))

    # Wald band from the standardized design (with intercept column).
    design = np.hstack([np.ones((n_rows, 1)), xs])
    prob = clf.predict_proba(xs)[:, 1]
    se = _wald_se(design, prob)[1:]  # drop intercept SE

    coefficients: list[Coefficient] = []
    for name, coef, std_err in zip(features, coefs, se):
        median = _finite(coef)
        band = _finite(1.96 * std_err, fallback=abs(median) + 1.0)
        ci_low, ci_high = median - band, median + band
        coefficients.append(
            Coefficient(
                feature=name,
                posterior_median=median,
                ci_low=_finite(ci_low),
                ci_high=_finite(ci_high),
                noise_flag=bool(ci_low <= 0.0 <= ci_high),
            )
        )

    cv_auc: float | None = None
    cv_folds: int | None = None
    if n_rows >= _MIN_ROWS_FOR_CV:
        min_class = int(min(np.bincount(y)))
        folds = min(3, min_class)
        if folds >= 2:
            try:
                scores = cross_val_score(
                    LogisticRegression(C=1.0), xs, y, cv=folds, scoring="roc_auc"
                )
                mean = float(np.mean(scores))
                if np.isfinite(mean):
                    cv_auc, cv_folds = mean, folds
            except ValueError:
                cv_auc = None  # CV not estimable at this N/class balance

    metrics = BaselineMetrics(
        n_rows=n_rows,
        n_companies=n_companies,
        n_features=len(features),
        in_sample_accuracy=in_sample_accuracy,
        cv_auc=cv_auc,
        cv_folds=cv_folds,
        inconclusive=cv_auc is None,
        note="frequentist yardstick (L2 logistic); not the shipped model, no causal claim",
    )
    return metrics, _model_fit(request, features, coefficients)
