"""Phase-4 Bayesian generator tests — synthetic data with KNOWN ground truth.

This is how we test *honesty*, not just correctness: we plant a signal and assert
the model recovers its sign without flagging it noise, assert pure-noise features
are flagged, and assert the prior prevents coefficient blow-up at EPV≈1–3. We
assert sign + flags, never exact magnitudes (those are not the product's claim).
"""

from __future__ import annotations

import numpy as np

from src.bayes import fit_bayesian_logistic
from src.rows import ModelingTable, RowRecord

# Modest sampler settings: fixed seed + cores=1 keep runtime small and deterministic.
_DRAWS = 400
_TUNE = 800


def _table(
    x: np.ndarray,
    y: np.ndarray,
    feature_names: list[str],
    *,
    category: str = "cat",
    engine: str = "openai",
) -> ModelingTable:
    """Build a ModelingTable inline: one row per company (companies == rows)."""
    rows: list[RowRecord] = []
    for i in range(x.shape[0]):
        rows.append(
            RowRecord(
                page_url=f"https://ex{i}.com/p",
                company_domain=f"ex{i}.com",  # distinct company per row => n_companies == n_rows
                p_cited=0.9 if y[i] == 1 else 0.1,
                label="winner" if y[i] == 1 else "loser",
                weight=1.0,
                features={name: float(x[i, j]) for j, name in enumerate(feature_names)},
            )
        )
    return ModelingTable(
        category=category,
        engine=engine,
        rows=rows,
        n_companies=len({r.company_domain for r in rows}),
        n_rows=len(rows),
    )


def _by_feature(fit) -> dict:
    return {c.feature: c for c in fit.coefficients}


def test_recovery_plants_signal_and_flags_noise() -> None:
    """ONE strong feature drives the outcome; the rest are pure noise.

    Assert the true feature has the correct SIGN and is NOT flagged noise, and that
    every pure-noise feature IS flagged. Magnitudes are not asserted.
    """
    rng = np.random.default_rng(1)
    n, d = 24, 5
    names = [f"page__f{j}" for j in range(d)]
    x = rng.normal(size=(n, d))
    true = np.zeros(d)
    true[0] = 3.5  # strong positive effect on the log-odds
    # Stochastic labels through the logistic link (NOT a hard threshold) so the
    # data does not perfectly separate — separation would inflate the posterior.
    p = 1.0 / (1.0 + np.exp(-(x @ true)))
    y = (rng.random(n) < p).astype(int)
    assert len(np.unique(y)) == 2  # sanity: the plant produced both classes

    fit = fit_bayesian_logistic(_table(x, y, names), draws=_DRAWS, tune=_TUNE, seed=0)
    coefs = _by_feature(fit)

    assert fit.prior_version == "phase4-reghs-v0"
    assert fit.n_companies == n and fit.n_rows == n
    assert fit.top_hypotheses == []  # a separate module fills this

    true_coef = coefs["page__f0"]
    assert true_coef.posterior_median > 0  # correct sign recovered
    assert true_coef.noise_flag is False  # the real signal survives shrinkage
    assert true_coef.ci_low > 0  # 90% CI excludes zero

    for j in range(1, d):
        assert coefs[f"page__f{j}"].noise_flag is True  # pure noise -> flagged


def test_shrinkage_no_blowup_at_small_n() -> None:
    """EPV≈1–3: few rows, many features. The prior must prevent any coefficient
    from blowing up, and most features must be flagged noise."""
    rng = np.random.default_rng(2)
    n, d = 8, 12  # EPV ≈ n/d well under 1 -> separation-prone without shrinkage
    names = [f"f{j}" for j in range(d)]
    x = rng.normal(size=(n, d))
    # A weak effect just to guarantee both classes exist; nothing is truly learnable.
    p = 1.0 / (1.0 + np.exp(-(0.8 * x[:, 0])))
    y = (rng.random(n) < p).astype(int)
    if len(np.unique(y)) < 2:
        y[0] = 1 - y[0]  # force two classes deterministically

    fit = fit_bayesian_logistic(_table(x, y, names), draws=300, tune=700, seed=0)

    assert len(fit.coefficients) == d
    # No blow-up: every posterior median stays bounded despite tiny N.
    assert all(abs(c.posterior_median) < 20.0 for c in fit.coefficients)
    assert all(np.isfinite(c.ci_low) and np.isfinite(c.ci_high) for c in fit.coefficients)
    # Most coefficients are noise at this data density (expect ~80–90%).
    flagged = sum(c.noise_flag for c in fit.coefficients)
    assert flagged >= int(0.8 * d)


def test_degenerate_inputs_return_valid_modelfit() -> None:
    """Single-class, too-few-rows, and no-feature tables must not crash."""
    names = ["page__a", "company__b"]

    # Single outcome class: all winners.
    x = np.random.default_rng(3).normal(size=(6, len(names)))
    y = np.ones(6, dtype=int)
    fit = fit_bayesian_logistic(_table(x, y, names), draws=100, tune=100, seed=0)
    assert len(fit.coefficients) == len(names)
    assert all(c.noise_flag for c in fit.coefficients)

    # n_rows < 2.
    x1 = np.random.default_rng(4).normal(size=(1, len(names)))
    fit_thin = fit_bayesian_logistic(_table(x1, np.array([1]), names), draws=100, tune=100, seed=0)
    assert all(c.noise_flag for c in fit_thin.coefficients)

    # No usable features (empty feature dicts -> empty union).
    rows = [
        RowRecord(
            page_url=f"https://e{i}.com",
            company_domain=f"e{i}.com",
            p_cited=0.5,
            label="winner" if i % 2 == 0 else "loser",
            weight=1.0,
            features={},
        )
        for i in range(4)
    ]
    no_feat = ModelingTable(category="c", engine="openai", rows=rows, n_companies=4, n_rows=4)
    fit_nf = fit_bayesian_logistic(no_feat, draws=100, tune=100, seed=0)
    assert fit_nf.coefficients == []
    assert fit_nf.n_rows == 4


def test_zero_variance_column_dropped() -> None:
    """A constant predictor carries no information and is dropped (not returned)."""
    rng = np.random.default_rng(5)
    n = 16
    names = ["page__var", "page__const"]
    x = np.column_stack([rng.normal(size=n), np.full(n, 7.0)])  # second column constant
    p = 1.0 / (1.0 + np.exp(-(2.0 * x[:, 0])))
    y = (rng.random(n) < p).astype(int)
    if len(np.unique(y)) < 2:
        y[0] = 1 - y[0]

    fit = fit_bayesian_logistic(_table(x, y, names), draws=200, tune=400, seed=0)
    returned = {c.feature for c in fit.coefficients}
    assert "page__const" not in returned  # dropped
    assert "page__var" in returned


def test_determinism_same_seed_same_output() -> None:
    """Fixed seed + cores=1 => byte-identical posterior summaries across runs."""
    rng = np.random.default_rng(6)
    n, d = 14, 4
    names = [f"f{j}" for j in range(d)]
    x = rng.normal(size=(n, d))
    p = 1.0 / (1.0 + np.exp(-(2.5 * x[:, 0])))
    y = (rng.random(n) < p).astype(int)
    if len(np.unique(y)) < 2:
        y[0] = 1 - y[0]
    table = _table(x, y, names)

    a = fit_bayesian_logistic(table, draws=200, tune=400, seed=0)
    b = fit_bayesian_logistic(table, draws=200, tune=400, seed=0)
    for ca, cb in zip(a.coefficients, b.coefficients):
        assert ca.posterior_median == cb.posterior_median
        assert ca.ci_low == cb.ci_low and ca.ci_high == cb.ci_high


# --- Step D: informative empirical-Bayes priors (closing the alpha loop) --------
def test_prior_mean_moves_posterior_toward_measured_lift() -> None:
    """The decisive loop test: feeding a measured lift back in as ``prior_means``
    pulls that feature's posterior toward the lift, on data where the feature is
    otherwise noise. Same table + same seed, with-prior vs empty.

    This is exactly the "hypotheses get SHARPER from proprietary measured data" claim:
    the prior must (a) raise the posterior median and (b) be able to push the credible
    interval off zero (noise -> claimable) — and the empty fit must NOT, proving the
    movement comes from the prior, not the data.
    """
    rng = np.random.default_rng(11)
    n, d = 10, 3
    names = [f"page__f{j}" for j in range(d)]
    x = rng.normal(size=(n, d))
    # f0 carries essentially no signal; a faint f1 effect just guarantees two classes.
    p = 1.0 / (1.0 + np.exp(-(0.3 * x[:, 1])))
    y = (rng.random(n) < p).astype(int)
    if len(np.unique(y)) < 2:
        y[0] = 1 - y[0]
    table = _table(x, y, names)

    with_prior = fit_bayesian_logistic(
        table, draws=300, tune=600, seed=0, prior_means={"page__f0": 6.0}
    )
    empty = fit_bayesian_logistic(table, draws=300, tune=600, seed=0)

    w = _by_feature(with_prior)["page__f0"]
    e = _by_feature(empty)["page__f0"]

    # (a) the prior actually moves the posterior toward the +6 measured lift.
    assert w.posterior_median > e.posterior_median + 1.0
    assert w.posterior_median > 1.0
    # (b) the measured lift SHARPENS the hypothesis: CI clears zero -> not noise...
    assert w.ci_low > 0.0
    assert w.noise_flag is False
    # ...while the empty fit leaves f0 as un-claimable noise (no data signal to find).
    assert e.noise_flag is True

    # prior_version encodes that one measured prior was used; empty keeps the constant.
    assert with_prior.prior_version == "empirical-reghs-v1"
    assert empty.prior_version == "phase4-reghs-v0"


def test_prior_on_one_feature_does_not_manufacture_signal_elsewhere() -> None:
    """The offset is strictly per-feature (mu_j == 0 for unlisted features), so a
    strong prior on f0 must NOT fabricate a claim on a different, prior-less,
    signal-less feature: f1/f2 stay shrink-to-zero noise in both fits.

    (Their posteriors do shift slightly — coefficients are fit jointly against one
    likelihood — but the prior leaks no false signal: they remain noise-flagged.)"""
    rng = np.random.default_rng(12)
    n, d = 10, 3
    names = [f"page__f{j}" for j in range(d)]
    x = rng.normal(size=(n, d))
    p = 1.0 / (1.0 + np.exp(-(0.3 * x[:, 1])))
    y = (rng.random(n) < p).astype(int)
    if len(np.unique(y)) < 2:
        y[0] = 1 - y[0]
    table = _table(x, y, names)

    with_prior = _by_feature(
        fit_bayesian_logistic(table, draws=300, tune=600, seed=0, prior_means={"page__f0": 6.0})
    )
    empty = _by_feature(fit_bayesian_logistic(table, draws=300, tune=600, seed=0))

    for f in ("page__f1", "page__f2"):
        assert empty[f].noise_flag is True  # no signal, no prior -> noise
        assert with_prior[f].noise_flag is True  # prior on f0 didn't leak a claim here
        assert abs(with_prior[f].posterior_median) < 1.0  # no spurious large coefficient


def test_prior_version_reflects_accumulated_evidence() -> None:
    """``prior_version`` encodes how many measured priors fed the fit. Checked on the
    degenerate (n_rows<2) path so it is fast and sampling-free, yet still exercises the
    version-threading through every return path."""
    names = ["page__a", "page__b"]
    thin = _table(np.random.default_rng(7).normal(size=(1, 2)), np.array([1]), names)

    # Empty prior -> the constant horseshoe version (unchanged behavior).
    assert fit_bayesian_logistic(thin, draws=50, tune=50).prior_version == "phase4-reghs-v0"
    # Two accumulated priors -> the evidence-counting empirical version.
    v2 = fit_bayesian_logistic(
        thin, draws=50, tune=50, prior_means={"page__a": 0.5, "page__b": -0.3}
    )
    assert v2.prior_version == "empirical-reghs-v2"
    # Degenerate guards intact: still all-noise regardless of priors.
    assert all(c.noise_flag for c in v2.coefficients)


def test_no_prior_paths_are_equivalent() -> None:
    """Backward compat: omitting ``prior_means``, passing ``None``, and passing ``{}``
    all take the identical shrink-to-zero path -> byte-identical output."""
    rng = np.random.default_rng(13)
    n, d = 12, 3
    names = [f"f{j}" for j in range(d)]
    x = rng.normal(size=(n, d))
    p = 1.0 / (1.0 + np.exp(-(2.0 * x[:, 0])))
    y = (rng.random(n) < p).astype(int)
    if len(np.unique(y)) < 2:
        y[0] = 1 - y[0]
    table = _table(x, y, names)

    default = fit_bayesian_logistic(table, draws=150, tune=300, seed=0)
    none = fit_bayesian_logistic(table, draws=150, tune=300, seed=0, prior_means=None)
    empty = fit_bayesian_logistic(table, draws=150, tune=300, seed=0, prior_means={})

    assert default.prior_version == none.prior_version == empty.prior_version == "phase4-reghs-v0"
    for cd, cn, ce in zip(default.coefficients, none.coefficients, empty.coefficients):
        assert cd.posterior_median == cn.posterior_median == ce.posterior_median
        assert cd.ci_low == cn.ci_low == ce.ci_low
        assert cd.ci_high == cn.ci_high == ce.ci_high
