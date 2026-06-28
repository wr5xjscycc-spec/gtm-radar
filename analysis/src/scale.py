"""Phase-6 scale path: graduation from the cold-start pooled model to a
hierarchical mixed-effects model (P4 Phase 6, task 1).

This module is the **graduation plan**, not the graduated model. The day-1
generator (:mod:`src.bayes`) fits a *pooled* regularized-horseshoe logistic per
(category, engine) over ~20–40 effective units (companies), with EPV≈1–3 — so it
shrinks aggressively and flags 80–90% of coefficients as noise. That is correct at
cold start, but it cannot share strength across categories/engines or separate
within-company from between-company variation. The graduation target fixes that:

- **Mixed-effects (hierarchical) model** with **random effects for company,
  category, and engine** plus a shared fixed-effects core. Partial pooling lets
  each category borrow strength from the others — categories with thin data are
  pulled toward the global mean, categories with rich data keep their specificity.
- **Effective N is still the number of companies** (pseudo-replication; fact #2).
  The company random effect is what makes the clustering explicit instead of an
  after-the-fact SE correction — but it does not manufacture information that the
  company count does not contain.

**The tension (why this is gated, not just "more model"):** partial pooling
*shrinks per-category specificity* — that is the whole point, and the risk. To
identify the between-group variance components (the random-effect variances) you
need **enough clusters**: too few categories or companies and the variance
parameters are unidentified, the partial pooling collapses to either full pooling
(everything is the global mean) or no pooling (the cold-start model, but noisier).
So graduation is **threshold-gated** on cluster counts, not on calendar time.

The thresholds (:data:`MIN_CATEGORIES`, :data:`MIN_COMPANIES`) come straight from
the card: roughly **15+ categories / 300+ companies**. :func:`ready_for_hierarchical`
is the real, testable gate. :func:`fit_hierarchical_model` is an explicit stub that
raises :class:`NotImplementedError` — we do **not** fake a hierarchical fit, because
a hierarchical fit run below its identifiability threshold is worse than honest
cold-start shrinkage (it would report false between-group structure).

See ``SCALE.md`` for the full narrative, including the deferred AI-Overviews
capture path (task 4).
"""

from __future__ import annotations

from typing import NoReturn

# Graduation thresholds (P4 Phase 6, task 1). Below either, the pooled cold-start
# model in src.bayes is the honest choice; the hierarchical variance components are
# not identifiable with fewer clusters than this.
MIN_CATEGORIES: int = 15  # need enough category clusters to estimate between-category variance
MIN_COMPANIES: int = 300  # effective N (companies, not rows) for the company random effect


def ready_for_hierarchical(*, n_categories: int, n_companies: int) -> dict:
    """Gate the move from the pooled cold-start model to the hierarchical model.

    Returns ``{"ready": bool, "reasons": [...]}``. ``ready`` is True only when
    **both** thresholds are met (cluster counts identify the random-effect
    variances); otherwise ``reasons`` explains exactly what is short. ``reasons``
    is empty when ready.
    """
    reasons: list[str] = []
    if n_categories < MIN_CATEGORIES:
        reasons.append(
            f"too few categories to identify between-category variance: "
            f"{n_categories} < {MIN_CATEGORIES}"
        )
    if n_companies < MIN_COMPANIES:
        reasons.append(
            f"too few companies (effective N) for the company random effect: "
            f"{n_companies} < {MIN_COMPANIES}"
        )
    return {"ready": not reasons, "reasons": reasons}


def fit_hierarchical_model(tables: object, *, seed: int = 0) -> NoReturn:
    """Stub for the graduated hierarchical mixed-effects model (NOT built yet).

    When built, this will fit a single partial-pooling model **across** the
    per-(category, engine) ``ModelingTable``s with **random effects for company,
    category, and engine** and a shared fixed-effects core, replacing the
    independent pooled fits in :func:`src.bayes.fit_bayesian_logistic`. Partial
    pooling shares strength across categories while still treating the company as
    the effective-N cluster.

    It is deliberately unimplemented: identifying the between-group variance
    components needs the cluster counts in :data:`MIN_CATEGORIES` /
    :data:`MIN_COMPANIES` (check with :func:`ready_for_hierarchical` first). Below
    that, a hierarchical fit reports variance structure it cannot actually
    identify — strictly worse than honest cold-start shrinkage — so we raise
    instead of faking it.
    """
    raise NotImplementedError(
        "Hierarchical mixed-effects model (company/category/engine random effects "
        "with partial pooling) is not built yet: identifying the between-group "
        "variance components requires the cluster counts in MIN_CATEGORIES / "
        "MIN_COMPANIES. Use ready_for_hierarchical(...) to check, and "
        "fit_bayesian_logistic for the cold-start pooled fit until then."
    )
