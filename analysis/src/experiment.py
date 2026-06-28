"""Experiment design — select page pairs, randomize treatment, emit experiment record."""

from typing import Optional
import numpy as np

from src.models import (
    Experiment,
    ExperimentPair,
    FitRow,
    PageMatchInput,
)
from src.matching import find_candidate_pairs, build_match_inputs_from_fit_rows


def design_experiment(
    rows: list[FitRow],
    customer_id: str,
    category: str,
    engine: str,
    hypothesis: str,
    n_pairs: int = 8,
    seed: int = 42,
    topical_clusters: Optional[dict[str, str]] = None,
) -> Experiment:
    """Design a randomized matched-pair experiment from a model_fit hypothesis.

    1. Build PageMatchInputs from rows (cross-cluster matching).
    2. Find candidate pairs via nearest-neighbour matching.
    3. Select the top *n_pairs* pairs.
    4. Randomize which side is treatment (coin flip per pair).
    5. Return the Experiment record.

    Parameters
    ----------
    rows : list of FitRow
        Page-level rows with features and P_cited.
    customer_id, category, engine : str
        Scope identifiers from the model_fit.
    hypothesis : str
        The top hypothesis to test.
    n_pairs : int
        Number of treatment/control pairs (default 8).
    seed : int
        RNG seed for reproducible randomization.
    topical_clusters : dict of page_url → topical_cluster, optional
        Override cluster assignment for spillover guard.
    """
    inputs = build_match_inputs_from_fit_rows(rows, topical_clusters)
    candidates = find_candidate_pairs(inputs, max_pairs=n_pairs)

    if not candidates:
        return Experiment(
            customer_id=customer_id,
            category=category,
            engine=engine,
            hypothesis=hypothesis,
            pairs=[],
            status="designing",
        )

    rng = np.random.default_rng(seed)
    pairs: list[ExperimentPair] = []
    for c in candidates:
        if rng.random() < 0.5:
            treatment = c.page_treatment
            control = c.page_control
        else:
            treatment = c.page_control
            control = c.page_treatment

        pairs.append(
            ExperimentPair(
                treatment_page=treatment,
                control_page=control,
                match_covars=dict(c.match_covars),
            )
        )

    return Experiment(
        customer_id=customer_id,
        category=category,
        engine=engine,
        hypothesis=hypothesis,
        pairs=pairs,
        status="designing",
    )


def build_fit_rows_from_experiment(
    experiment: Experiment,
    all_rows: list[FitRow],
) -> tuple[list[FitRow], list[FitRow]]:
    """Split *all_rows* into treatment and control groups per experiment pairs.

    Returns (treatment_rows, control_rows).
    """
    treatment_urls: set[str] = {p.treatment_page for p in experiment.pairs}
    control_urls: set[str] = {p.control_page for p in experiment.pairs}

    treatment_rows = [r for r in all_rows if r.page_url in treatment_urls]
    control_rows = [r for r in all_rows if r.page_url in control_urls]

    return treatment_rows, control_rows
