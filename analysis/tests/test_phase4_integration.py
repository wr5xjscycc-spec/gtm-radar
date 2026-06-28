"""Phase-4 integration: fixtures -> modeling table -> Bayesian fit -> Rung-1.

Drives the full day-1 pipeline on real fixture data: build a per-(category,engine)
modeling table (Phase 3), fit the honest Bayesian generator (Phase 4 core), then
select top hypotheses + emit the Rung-1 claim-ladder payload.

Phase-4 DoD: a real, honestly-uncertain ranked gap list + top hypothesis, with the
overwhelming majority of features flagged as noise at this tiny N.

This test samples with PyMC, so it is marked slow-ish; one table only to bound CI.
"""

from __future__ import annotations

import json
from pathlib import Path

from src.bayes import fit_bayesian_logistic
from src.contract import ModelFit
from src.hypotheses import BANNED_CAUSAL_WORDS, rung1_payload, select_top_hypotheses
from src.rows import build_modeling_tables

FIXTURES = Path(__file__).parent / "fixtures"


def _load(name: str) -> list[dict]:
    return json.loads((FIXTURES / name).read_text())


def _tables():
    records = {
        "measurements": _load("measurement.json") + _load("measurement_crm.json"),
        "pages": _load("page.json") + _load("page_crm.json"),
        "companies": _load("company.json") + _load("company_crm.json"),
    }
    return build_modeling_tables(**records)


def test_day1_pipeline_end_to_end():
    tables = _tables()
    table = tables[("ai-sales-tools", "openai")]

    fit = fit_bayesian_logistic(table, draws=300, tune=300, chains=2, seed=0)
    assert isinstance(fit, ModelFit)
    assert fit.coefficients, "no coefficients produced"
    assert fit.n_companies == table.n_companies  # effective N carried through
    assert json.loads(fit.model_dump_json())  # Convex-serializable

    # Honesty: at EPV~1-3 the overwhelming majority of features must be noise.
    noise = sum(c.noise_flag for c in fit.coefficients)
    assert noise / len(fit.coefficients) >= 0.7

    # Rung-1: hypotheses are tentative and carry NO causal language.
    top = select_top_hypotheses(fit, k=3)
    assert len(top) <= 3
    payload = rung1_payload(fit, k=3)
    assert payload["claim_rung"] == 1
    assert payload["n_companies"] == fit.n_companies
    assert payload["caveat"]

    blob = " ".join(top + [payload["caveat"]]).lower()
    for banned in BANNED_CAUSAL_WORDS:
        assert banned.lower() not in blob, f"causal word leaked: {banned!r}"


def test_no_coefficient_blows_up_on_real_data():
    """Shrinkage holds on the real (thin) fixture table — no separation blow-up."""
    table = _tables()[("crm-software", "perplexity")]
    fit = fit_bayesian_logistic(table, draws=300, tune=300, chains=2, seed=0)
    assert all(abs(c.posterior_median) < 20 for c in fit.coefficients)
