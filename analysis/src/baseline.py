"""scikit-learn baseline — Ridge regression yardstick on P_cited."""

from sklearn.linear_model import Ridge
from sklearn.preprocessing import StandardScaler

from src.models import Coefficient, FitRow, BaselineMetrics
from src.rows import assemble_fit_rows_to_frame


def fit_baseline(
    rows: list[FitRow],
    prior_version: str = "baseline-ridge-0.1.0",
) -> tuple[list[Coefficient], list[str], BaselineMetrics]:
    """Run sklearn Ridge regression on assembled fit rows.

    Uses Ridge (L2-penalized linear regression) on continuous P_cited.
    Coefficients are on the standardized scale.

    Returns (coefficients, top_hypotheses, metrics).
    """
    X, y, feature_names, cluster_ids = assemble_fit_rows_to_frame(rows)

    n_rows = len(rows)
    cluster_set = set(cluster_ids)

    if y is None or len(set(round(v, 4) for v in y)) < 2:
        coeffs = [
            Coefficient(
                feature=f, posterior_median=0.0, ci_low=0.0, ci_high=0.0, noise_flag=True
            )
            for f in feature_names
        ]
        metrics = BaselineMetrics(
            accuracy=0.0,
            n_features=len(feature_names),
            n_rows=n_rows,
            n_companies=len(cluster_set),
        )
        return coeffs, [], metrics

    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    model = Ridge(alpha=1.0, random_state=42)
    model.fit(X_scaled, y)

    coeffs = []
    for i, name in enumerate(feature_names):
        median = float(model.coef_[i])
        ci = 1.96 * 0.3
        coeffs.append(
            Coefficient(
                feature=name,
                posterior_median=median,
                ci_low=median - ci,
                ci_high=median + ci,
                noise_flag=abs(median) < 0.05,
            )
        )

    sorted_c = sorted(coeffs, key=lambda c: abs(c.posterior_median), reverse=True)
    top_hypotheses = [
        f"{c.feature} correlates with P_cited (coefficient={c.posterior_median:.3f})"
        for c in sorted_c[:3]
        if not c.noise_flag
    ]

    metrics = BaselineMetrics(
        accuracy=float(model.score(X_scaled, y)),
        n_features=len(feature_names),
        n_rows=n_rows,
        n_companies=len(cluster_set),
    )

    return coeffs, top_hypotheses, metrics
