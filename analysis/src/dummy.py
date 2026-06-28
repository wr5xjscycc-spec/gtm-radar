"""Phase-0 dummy fit.

This is a STUB, not statistics. Its only job is to prove the Convex <-> Python
round-trip with a well-formed ``model_fit``. The real Bayesian hypothesis
generator (weakly-informative priors + R2D2 shrinkage) lands in Phase 4 and will
replace :func:`dummy_model_fit` behind the same contract.

Honesty is wired in even at the stub: a stub knows nothing, so every coefficient
is flagged as noise (credible interval crosses zero) and ``top_hypotheses`` is
empty. A Phase-0 stub that claims a signal would be the exact overclaim the
red-team warns against. The one thing computed for real is ``n_companies``
(effective N), because getting that right from row one is non-negotiable.
"""

from __future__ import annotations

import hashlib

from .contract import Coefficient, FitRequest, ModelFit


def _stable_jitter(seed: str) -> float:
    """Deterministic small number in [-0.05, 0.05) from a string seed.

    Deterministic (no RNG) so tests and CI are reproducible. Tiny magnitude with a
    CI that always straddles zero — the value is meaningless on purpose.
    """
    digest = hashlib.sha256(seed.encode()).digest()
    # map first 4 bytes -> [0, 1) then center to [-0.05, 0.05)
    unit = int.from_bytes(digest[:4], "big") / 0xFFFFFFFF
    return (unit - 0.5) * 0.1


def dummy_model_fit(request: FitRequest, fit_id: str) -> ModelFit:
    """Produce a deterministic, honestly-empty ``model_fit`` from request rows."""
    features = request.feature_names()
    coefficients: list[Coefficient] = []
    for feature in features:
        median = _stable_jitter(f"{request.engine}:{request.category}:{feature}")
        # CI always brackets zero -> nothing is claimable from a stub.
        spread = abs(median) + 0.1
        coefficients.append(
            Coefficient(
                feature=feature,
                posterior_median=median,
                ci_low=median - spread,
                ci_high=median + spread,
                noise_flag=True,
            )
        )

    return ModelFit(
        id=fit_id,
        customer_id=request.customer_id,
        category=request.category,
        engine=request.engine,
        coefficients=coefficients,
        prior_version=request.prior_version,
        top_hypotheses=[],  # a stub proposes no hypotheses
        n_companies=request.n_companies(),
        n_rows=len(request.rows),
    )
