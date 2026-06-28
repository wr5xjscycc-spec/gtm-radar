"""DiD estimation — difference-in-differences with page-clustered SEs.

Specification:
    citation_rate ~ treatment * post + C(page) + C(week)

with page-clustered standard errors (statsmodels OLS).

Honesty discipline:
    - Power-honesty: at small N (< 4 pages in either group), return
      verdict="inconclusive".
    - Never fabricate significance — the CI must exclude zero AND the
      p-value must be ≤ 0.05 for any directional verdict.
"""

from datetime import datetime, timezone
from typing import Optional

import numpy as np
import pandas as pd
from statsmodels.formula.api import ols

from src.models import LiftResult, ExperimentPair


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _run_ols_did(
    df: pd.DataFrame,
) -> tuple[float, float, float, float, Optional[str]]:
    """Estimate DiD with OLS and page-clustered SEs.

    Returns (estimate, ci_low, ci_high, p_value, warning).
    Returns (0, 0, 0, 1, reason) on failure or power violation.
    """
    n_treated = df.loc[df["treatment"] == 1, "page"].nunique()
    n_control = df.loc[df["treatment"] == 0, "page"].nunique()

    if n_treated < 4 or n_control < 4:
        return (0.0, 0.0, 0.0, 1.0, "inconclusive: fewer than 4 pages per arm")

    n_periods = df["post"].nunique()
    if n_periods < 2:
        return (0.0, 0.0, 0.0, 1.0, "inconclusive: fewer than 2 time periods")

    try:
        formula = "citation_rate ~ treatment * post + C(page)"
        if "week" in df.columns and df["week"].nunique() > 1:
            formula += " + C(week)"

        model = ols(formula, data=df)
        fit = model.fit(cov_type="cluster", cov_kwds={"groups": df["page"]})

        estimate = float(fit.params.get("treatment:post", 0.0))

        try:
            se = fit.bse.get("treatment:post", 1.0)
            ci_low = estimate - 1.96 * se
            ci_high = estimate + 1.96 * se
        except Exception:
            return (estimate, estimate, estimate, 1.0, "inconclusive: SE not available")

        try:
            p_value = float(fit.pvalues.get("treatment:post", 1.0))
        except Exception:
            p_value = 1.0

        return (estimate, ci_low, ci_high, p_value, None)

    except Exception as exc:
        return (0.0, 0.0, 0.0, 1.0, f"inconclusive: model failed ({exc})")


def _compute_verdict(
    estimate: float,
    ci_low: float,
    ci_high: float,
    p_value: float,
    warning: Optional[str],
) -> str:
    """Return verdict: worked | no_effect | inconclusive."""
    if warning is not None:
        return "inconclusive"

    if p_value > 0.05:
        return "inconclusive"

    if ci_low <= 0.0 <= ci_high:
        return "inconclusive"

    if estimate > 0:
        return "worked"

    if estimate < 0:
        return "no_effect"

    return "inconclusive"


def estimate_did(
    df: pd.DataFrame,
    experiment_id: str,
) -> LiftResult:
    """Estimate causal lift via difference-in-differences.

    Parameters
    ----------
    df : pd.DataFrame
        Panel with columns:
            page        — page identifier (str)
            citation_rate — P_cited (float, 0-1)
            treatment   — 1 for treated pages, 0 for control (int)
            post        — 1 for post-treatment window, 0 for baseline (int)
            week        — optional week label (int/str, used for week FE)
        Must have at least 2 pages per arm and 2 time periods.
    experiment_id : str
        Reference to the parent experiment record.

    Returns
    -------
    LiftResult with estimate, CI, p_value, verdict, claim_rung=2.
    """
    estimate, ci_low, ci_high, p_value, warning = _run_ols_did(df)
    verdict = _compute_verdict(estimate, ci_low, ci_high, p_value, warning)

    return LiftResult(
        experiment_id=experiment_id,
        estimate=estimate,
        ci_low=ci_low,
        ci_high=ci_high,
        p_value=p_value,
        verdict=verdict,
        claim_rung=2,
        computed_at=_now_iso(),
    )


def simulate_panel(
    n_pages: int = 20,
    n_treated: int = 10,
    effect: float = 0.15,
    noise_sd: float = 0.05,
    n_weeks: int = 2,
    seed: int = 42,
) -> pd.DataFrame:
    """Generate a synthetic DiD panel with a known treatment effect.

    Useful for testing recovery.
    """
    rng = np.random.default_rng(seed)
    records: list[dict] = []

    for i in range(n_pages):
        page_fe = rng.normal(0.3, 0.15)
        treated = i < n_treated
        for week in range(n_weeks):
            for post in [0, 1]:
                rate = page_fe
                if treated and post:
                    rate += effect
                rate += rng.normal(0, noise_sd)
                rate = max(0.0, min(1.0, rate))

                records.append(
                    {
                        "page": f"page_{i}",
                        "citation_rate": rate,
                        "treatment": 1 if treated else 0,
                        "post": post,
                        "week": week,
                    }
                )

    return pd.DataFrame(records)
