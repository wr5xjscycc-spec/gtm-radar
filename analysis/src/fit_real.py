"""Phase-4 real ``model_fit`` handler — the honest replacement for the Phase-0 stub.

The Phase-0 service called :func:`src.dummy.dummy_model_fit` (deterministic, always
all-noise) only to lock the Convex <-> Python wire contract. This module plugs the
*already-written, already-tested* Bayesian brain in behind that exact contract:

    FitRequest.rows  ->  ModelingTable  ->  fit_bayesian_logistic  ->  select_top_hypotheses  ->  ModelFit

Nothing here is new statistics. The regularized-horseshoe fit
(:func:`src.bayes.fit_bayesian_logistic`) and the survivor selection
(:func:`src.hypotheses.select_top_hypotheses`) are unchanged; this file is the
adapter that bridges the wire ``FitRequest`` (assembled, *labeled* rows that already
carry winner/loser labels + P(cited) CI widths) into the ``ModelingTable`` those
functions expect, then re-stamps the customer/fit identity the orchestrator owns.

Honesty preserved end to end: at cold-start EPV the fit is *expected* to shrink most
or all coefficients to noise (``noise_flag``), and ``select_top_hypotheses`` returns
``[]`` when nothing survives. An all-noise real fit is a correct, honest result — not
a failure — and it is distinct from the dummy: it carries the real prior version and
real (wide) credible intervals, not the dummy's deterministic jitter.
"""

from __future__ import annotations

from .bayes import fit_bayesian_logistic
from .contract import FitRequest, ModelFit
from .hypotheses import select_top_hypotheses
from .labeling import ci_weight
from .rows import ModelingTable, RowRecord

# Service-latency sampler settings. Modest draws/tune/chains keep a single /fit job
# responsive; the statistics are identical in form to the higher-draw defaults in
# :func:`src.bayes.fit_bayesian_logistic` (the posterior summary, not the wall time,
# is what the contract carries).
_DRAWS = 300
_TUNE = 300
_CHAINS = 2


def modeling_table_from_request(request: FitRequest) -> ModelingTable:
    """Assemble one ``ModelingTable`` from already-labeled ``FitRequest`` rows.

    Mirrors the per-row construction in :func:`src.rows.build_modeling_tables`
    (rows.py:118): attach the CI-derived certainty ``weight`` (``ci_weight`` of the
    row's P(cited) CI width), keep page/company-namespaced features intact, and DROP
    rows that carry no winner/loser ``label`` — an unlabeled row was never in the
    case-control pool (a ``FitRow`` carries ``p_cited`` but not ``appeared``/``cited``,
    so the label cannot be recomputed here; it must arrive pre-labeled).

    The table is single-slice: category + engine come straight from the request
    (engines are never pooled), and ``n_companies`` is the distinct-domain effective N.
    """
    records: list[RowRecord] = []
    for row in request.rows:
        if row.label is None:  # not in the considered pool -> excluded, not a loser
            continue
        records.append(
            RowRecord(
                page_url=row.page_url,
                company_domain=row.company_domain,
                p_cited=row.p_cited,
                label=row.label,
                weight=ci_weight(row.ci_width),
                features=dict(row.features),
            )
        )

    return ModelingTable(
        category=request.category,
        engine=request.engine,
        rows=records,
        n_companies=len({r.company_domain for r in records}),
        n_rows=len(records),
    )


def real_model_fit(
    request: FitRequest,
    fit_id: str,
    *,
    draws: int = _DRAWS,
    tune: int = _TUNE,
    chains: int = _CHAINS,
) -> ModelFit:
    """Run the real regularized-horseshoe Bayesian fit for one ``FitRequest``.

    Drop-in replacement for :func:`src.dummy.dummy_model_fit` behind the identical
    ``Callable[[FitRequest, str], ModelFit]`` signature the :class:`src.jobs.JobStore`
    expects. Bridges the request to a ``ModelingTable``, fits, selects up to three
    surviving hypotheses, and re-stamps the fit with the caller's ``fit_id`` /
    ``customer_id`` (which the table does not carry).

    ``request.prior_means`` (accumulated measured causal lift; empty for a cold-start
    request) is forwarded into the fit as an informative empirical-Bayes prior. The
    fit itself stamps the ``prior_version``: ``"phase4-reghs-v0"`` when no priors were
    used, or the evidence-counting ``"empirical-reghs-v{n}"`` when they were — never
    the Phase-0 stub version — so we deliberately do NOT overwrite it here.
    """
    table = modeling_table_from_request(request)
    fit = fit_bayesian_logistic(
        table, draws=draws, tune=tune, chains=chains, prior_means=request.prior_means
    )
    top = select_top_hypotheses(fit)
    return fit.model_copy(
        update={
            "id": fit_id,
            "customer_id": request.customer_id,
            "top_hypotheses": top,
        }
    )
