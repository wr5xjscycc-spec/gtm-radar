"""Hierarchical-model graduation path — moving from per-category Beta regression
to cross-category partial pooling.

Current state (cold start, 1–5 categories, <100 companies):
    Per-(category, engine) Beta regression with R2D2 shrinkage (bayesian.py).
    Each category is fit independently — no information flows between categories.
    Works well at small N because the R2D2 prior provides strong shrinkage.

Graduation threshold (~15+ categories, ~300+ companies):
    Switch to a mixed-effects (hierarchical) model:
        y_ij ~ Beta(mu_ij, phi)
        logit(mu_ij) = alpha + X_ij @ beta
                     + u_category[i] + u_engine[j] + u_company[k]
        u_category ~ Normal(0, sigma_category)  # random intercept per category
        u_engine   ~ Normal(0, sigma_engine)     # random intercept per answer engine
        u_company  ~ Normal(0, sigma_company)    # random intercept per company

    Key benefit: partial pooling shrinks per-category estimates toward the
    global mean, reducing variance in low-N categories while preserving signal
    in high-N categories. A category with only 3 companies borrows information
    from categories with 30+ companies.

Tension / honesty note:
    Partial pooling *reduces* per-category specificity. The estimate for a
    given category is pulled toward the grand mean. This is a feature (variance
    reduction) but also a limitation — if category GTM analytics has genuinely
    different dynamics from category ABM platforms, pooling will attenuate
    the difference. At the threshold (~15 categories) the data is rich enough
    to estimate between-category variance and let the pooling be data-driven
    (not aggressive).

    Effective-N still matters: the model clusters on company, not page. A
    category with 3 companies × 10 pages is *not* 30 observations.

Implementation stub (not a full model — documents the interface + next steps):

    class HierarchicalFitResult(NamedTuple):
        coefficients: list[Coefficient]
        random_effects: dict[str, dict[str, float]]  # e.g. {"category": {"GTM analytics": 0.3, ...}}
        variance_components: dict[str, float]  # sigma_category, sigma_engine, sigma_company
        top_hypotheses: list[str]

    def fit_hierarchical(
        rows: list[FitRow],
        category_map: dict[str, str],       # page_url -> category
        engine_map: dict[str, str],          # page_url -> engine
        prior_version: str = "hierarchical-beta-0.1.0",
        seed: int = 42,
    ) -> HierarchicalFitResult:
        \"""Mixed-effects Beta regression with partial pooling.

        Requires: multiple categories (>= ~15) with >= 2 companies each, and
        at least 2 engines in the data.

        PyMC implementation sketch:
            with pm.Model():
                alpha = pm.Normal("alpha", 0, 1)
                beta  = pm.Normal("beta", 0, tau * lam, shape=K)

                # Random intercepts
                sigma_cat = pm.HalfNormal("sigma_category", 1)
                u_cat = pm.Normal("u_category", 0, sigma_cat, shape=n_categories)

                sigma_eng = pm.HalfNormal("sigma_engine", 1)
                u_eng = pm.Normal("u_engine", 0, sigma_eng, shape=n_engines)

                sigma_comp = pm.HalfNormal("sigma_company", 1)
                u_comp = pm.Normal("u_company", 0, sigma_comp, shape=n_companies)

                phi = pm.HalfNormal("phi", 5)
                eta = alpha + X @ beta
                     + u_cat[cat_idx] + u_eng[eng_idx] + u_comp[comp_idx]
                mu = pm.math.sigmoid(eta)
                pm.Beta("obs", mu=mu, nu=phi, observed=y)

        Returns coefficients (fixed effects) + variance components + random
        effect estimates per category/engine/company.
        \"""
        ...  # TODO: implement when data crosses threshold
        raise NotImplementedError(
            "Hierarchical model requires ~15+ categories and ~300+ companies. "
            "See scale_path.py docs for the graduation plan."
        )
"""