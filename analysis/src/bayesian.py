"""Bayesian hypothesis generator — Beta regression with R2D2-style shrinkage.

Outcome: P_cited (rate per page row, squeezed to (0, 1) for Beta likelihood).
Features: standardized continuous predictors per row.
Clustering: by company (cluster_id) — effective N is n_companies, not n_rows.
Prior: Student-t(3) global-local shrinkage (horseshoe-like) with Normal coefficients.
"""

import numpy as np
import pymc as pm
import pytensor.tensor as pt

from src.models import Coefficient, FitRow
from src.rows import assemble_fit_rows_to_frame


def _hdi(samples: np.ndarray, prob: float = 0.9) -> tuple[np.ndarray, np.ndarray]:
    """Highest-density interval for each column. Falls back to percentile for 1D."""
    if samples.ndim == 1:
        samples = samples.reshape(-1, 1)
    n = samples.shape[0]
    sorted_samples = np.sort(samples, axis=0)
    interval_len = max(1, int(prob * n))
    lows = np.empty(samples.shape[1])
    highs = np.empty(samples.shape[1])
    for j in range(samples.shape[1]):
        col = sorted_samples[:, j]
        best_start = 0
        best_width = np.inf
        for i in range(n - interval_len + 1):
            width = col[i + interval_len - 1] - col[i]
            if width < best_width:
                best_width = width
                best_start = i
        lows[j] = col[best_start]
        highs[j] = col[best_start + interval_len - 1]
    return lows, highs


def _noise_flag(ci_low: float, ci_high: float, median: float, threshold: float = 0.01) -> bool:
    """True when the credible interval crosses zero or the median is tiny."""
    return (ci_low <= 0.0 <= ci_high) or abs(median) < threshold


def fit_bayesian(
    rows: list[FitRow],
    prior_version: str = "bayesian-logit-student-t-0.1.0",
    seed: int = 42,
    draws: int = 500,
    tune: int = 500,
    chains: int = 2,
) -> tuple[list[Coefficient], list[str]]:
    """Beta regression with R2D2-style shrinkage on standardized predictors.

    Returns (coefficients, top_hypotheses).
    """
    if not rows:
        return [], []

    X, y, feature_names, cluster_ids = assemble_fit_rows_to_frame(rows)
    K = X.shape[1]
    n_companies = len(set(cluster_ids))

    if y is None or len(set(round(v, 4) for v in y)) < 2 or K == 0 or n_companies < 2:
        coeffs = [
            Coefficient(feature=f, posterior_median=0.0, ci_low=0.0, ci_high=0.0, noise_flag=True)
            for f in feature_names
        ]
        return coeffs, []

    eps = 1e-4
    y_squeezed = y * (1.0 - 2.0 * eps) + eps

    X_mean = X.mean(axis=0)
    X_std_val = X.std(axis=0)
    X_std_val[X_std_val == 0.0] = 1.0
    X_scaled = (X - X_mean) / X_std_val

    with pm.Model():
        alpha = pm.Normal("alpha", mu=0, sigma=1)
        tau_global = pm.HalfStudentT("tau_global", nu=3, sigma=1)
        lam_local = pm.HalfStudentT("lam_local", nu=3, sigma=1, shape=K)
        beta = pm.Normal("beta", mu=0, sigma=tau_global * lam_local, shape=K)
        phi = pm.HalfNormal("phi", sigma=5)
        mu = pm.math.sigmoid(alpha + pt.dot(X_scaled, beta))
        pm.Beta("obs", mu=mu, nu=phi, observed=y_squeezed)
        trace = pm.sample(draws=draws, tune=tune, chains=chains, random_seed=seed, progressbar=False)

    beta_samples = trace.posterior["beta"].values
    beta_combined = beta_samples.reshape(-1, K) if beta_samples.ndim == 3 else beta_samples

    medians = np.median(beta_combined, axis=0)
    ci_low, ci_high = _hdi(beta_combined, prob=0.9)

    coeffs = []
    for i, name in enumerate(feature_names):
        noise = _noise_flag(float(ci_low[i]), float(ci_high[i]), float(medians[i]))
        coeffs.append(
            Coefficient(
                feature=name,
                posterior_median=float(medians[i]),
                ci_low=float(ci_low[i]),
                ci_high=float(ci_high[i]),
                noise_flag=noise,
            )
        )

    non_noise = sorted(
        [c for c in coeffs if not c.noise_flag],
        key=lambda c: abs(c.posterior_median),
        reverse=True,
    )
    hypotheses = []
    for c in non_noise[:3]:
        direction = "increases" if c.posterior_median > 0 else "decreases"
        hypotheses.append(
            f"{c.feature} correlates with citation probability in this category "
            f"({direction}, posterior median={c.posterior_median:.3f}); "
            f"test this hypothesis in a controlled experiment."
        )

    if not hypotheses and coeffs:
        strongest = max(coeffs, key=lambda c: abs(c.posterior_median))
        hypotheses.append(
            f"{strongest.feature} shows the strongest signal in this category "
            f"but the 90% credible interval crosses zero; more data is needed."
        )

    return coeffs, hypotheses
