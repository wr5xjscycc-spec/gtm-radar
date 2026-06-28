"""Phase-5 experiment design + randomization (P4 Phase 5, task 1).

WHY a randomized matched-pair design: a single-group before/after on a treated
page is confounded — the LLM model drifts, search seasonality moves citation
rates, and the customer's *other* SEO work bleeds in. None of those is the page
edit we shipped, yet all of them land in a naive pre/post delta, so the number
cannot earn causal language. Pairing each treated page with a **matched control**
and differencing (DiD) cancels the shared drift; **randomizing** which page of a
matched pair is treated removes selection bias (we don't get to pick the page
that was going to improve anyway). That combination is what lets the downstream
``lift_result`` legitimately carry ``claim_rung == 2``.

The controls are matched on the candidate pairs from :func:`src.matching.match_pairs`,
which pairs pages *across* topical clusters (the spillover guard): a control that
answers a different query cannot be cannibalized by its treated partner.

**Invisible-control convention:** within each :class:`ExperimentPair`, only
``treatment_page`` is ever edited/published; ``control_page`` is held unchanged
and is never surfaced to the customer (it exists purely to absorb drift). We also
stamp ``control_visibility="invisible"`` into ``match_covars`` so the convention
travels with the record.
"""

from __future__ import annotations

import numpy as np

from .contract import Experiment, ExperimentPair, ExperimentStatus
from .matching import Pair, match_pairs


def randomize_assignment(pair: Pair, rng: np.random.Generator) -> tuple[str, str]:
    """Coin-flip which page of a matched candidate becomes treatment.

    Returns ``(treatment_page, control_page)``. The candidate's slot order is an
    artifact of match ordering, not a random assignment — so we re-randomize here
    rather than inherit it. Deterministic given ``rng`` (a seeded Generator).
    """
    pages = (pair.treatment_page, pair.control_page)
    flip = int(rng.integers(0, 2))
    return pages[flip], pages[1 - flip]


def _pair_record(pair: Pair, treatment: str, control: str, target_feature: str | None) -> ExperimentPair:
    """Build an :class:`ExperimentPair`, re-keying arm-specific covars to the FINAL
    (post-flip) assignment so rate/cluster/content labels always match the arm they
    name. Carrying the candidate's keys verbatim would mislabel the swapped pairs.
    """
    # Per-page view from the candidate, indexed by URL so a coin-flip swap can't
    # desync a rate from its page.
    by_page = {
        pair.treatment_page: {
            "p_cited": pair.match_covars.get("treatment_p_cited"),
            "content_type": pair.match_covars.get("treatment_content_type"),
            "cluster": pair.cluster_a,
        },
        pair.control_page: {
            "p_cited": pair.match_covars.get("control_p_cited"),
            "content_type": pair.match_covars.get("control_content_type"),
            "cluster": pair.cluster_b,
        },
    }
    t, c = by_page[treatment], by_page[control]
    covars: dict[str, float | str] = {
        "treatment_p_cited": t["p_cited"],
        "control_p_cited": c["p_cited"],
        "abs_rate_gap": pair.match_covars.get("abs_rate_gap"),  # symmetric — swap-safe
        "treatment_content_type": t["content_type"],
        "control_content_type": c["content_type"],
        "treatment_cluster": t["cluster"],
        "control_cluster": c["cluster"],
        "control_visibility": "invisible",
    }
    if target_feature is not None:
        covars["target_feature"] = target_feature
    return ExperimentPair(
        treatment_page=treatment,
        control_page=control,
        match_covars={k: v for k, v in covars.items() if v is not None},
    )


def design_experiment(
    measurements: list[dict],
    pages: list[dict],
    companies: list[dict],
    *,
    customer_id: str,
    engine: str,
    baseline_window: str,
    post_window: str,
    experiment_id: str,
    target_feature: str | None = None,
    n_pairs: int = 8,
    seed: int = 0,
    status: ExperimentStatus = "designing",
) -> Experiment:
    """Design a randomized matched-pair experiment from a ``model_fit`` hypothesis.

    ``target_feature`` is the top hypothesis being tested (recorded per pair so the
    downstream ``intervention`` row knows its ``feature_changed``); the matching
    itself does not depend on it.

    Selects up to ``n_pairs`` (the card asks for 6–10) cross-cluster matched
    candidates via :func:`match_pairs`; if fewer qualify, returns fewer (an honest
    under-powered design beats a fabricated one). For each candidate, a SEEDED
    numpy Generator coin-flips which page is treatment — so assignment is random
    yet fully reproducible from ``seed``.
    """
    candidates = match_pairs(measurements, pages, companies, engine=engine, max_pairs=n_pairs)

    rng = np.random.default_rng(seed)
    pairs = [
        _pair_record(c, *randomize_assignment(c, rng), target_feature)
        for c in candidates
    ]

    return Experiment(
        id=experiment_id,
        customer_id=customer_id,
        pairs=pairs,
        baseline_window=baseline_window,
        post_window=post_window,
        status=status,
    )
