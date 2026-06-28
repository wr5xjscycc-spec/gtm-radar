"""Phase-5 integration: the closed loop end-to-end.

Two checks:
1. fixtures -> design_experiment produces a valid randomized matched-pair Experiment.
2. a planted-lift panel runs through the full moat loop:
   design -> DiD (estimate_lift) -> record_intervention -> deliver,
   and the honesty invariant holds: the causal claim lives ONLY in the
   lift_result (claim_rung == 2), and the moat row mirrors it.

Phase-5 DoD: ship-vs-hold runs and returns an honest causal lift report
(estimate + CI + verdict); the intervention moat table starts filling.
"""

from __future__ import annotations

import json
from pathlib import Path

from src.contract import (
    Experiment,
    ExperimentPair,
    Intervention,
    LiftResult,
)
from src.delivery import deliver, route_delivery
from src.did import estimate_lift
from src.experiment import design_experiment
from src.moat import append_intervention, record_intervention

FIXTURES = Path(__file__).parent / "fixtures"


def _load(name: str) -> list[dict]:
    return json.loads((FIXTURES / name).read_text())


def test_design_experiment_from_fixtures():
    exp = design_experiment(
        _load("measurement.json"),
        _load("page.json"),
        _load("company.json"),
        customer_id="ws_seed_001",
        engine="openai",
        baseline_window="2026-05",
        post_window="2026-06",
        experiment_id="exp_seed_1",
        target_feature="page__comparison_table",
        n_pairs=8,
        seed=0,
    )
    assert isinstance(exp, Experiment)
    for p in exp.pairs:
        assert p.treatment_page != p.control_page


def _planted_panel(exp: Experiment, *, lift: float, periods: int = 3) -> list[dict]:
    """Synthesize windowed measurements with a real treatment effect post-publish."""
    rows: list[dict] = []
    treat = {p.treatment_page for p in exp.pairs}
    base = 0.30
    for pair in exp.pairs:
        for page in (pair.treatment_page, pair.control_page):
            for window in ("baseline", "post"):
                for k in range(periods):
                    bump = lift if (page in treat and window == "post") else 0.0
                    # tiny deterministic per-period variation for within-arm variance
                    val = base + bump + 0.01 * k
                    rows.append({
                        "page_url": page, "engine": "openai", "window_tag": window,
                        "period": f"{window}-w{k}", "P_cited": round(val, 4),
                        "cited": val > 0.5, "ts": f"2026-0{5 if window=='baseline' else 6}-0{k+1}T00:00:00Z",
                    })
    return rows


def _synthetic_experiment(n_pairs: int = 6) -> Experiment:
    pairs = [
        ExperimentPair(
            treatment_page=f"https://t{i}.example/p",
            control_page=f"https://c{i}.example/p",
            match_covars={"abs_rate_gap": 0.02},
        )
        for i in range(n_pairs)
    ]
    return Experiment(
        id="exp_synth_1", customer_id="ws_1", pairs=pairs,
        baseline_window="2026-05",
        post_window="2026-06",
        status="running",
    )


def test_closed_loop_with_planted_lift():
    exp = _synthetic_experiment(n_pairs=6)
    panel = _planted_panel(exp, lift=0.20)

    lift = estimate_lift(
        exp, panel, engine="openai", computed_at="2026-06-30T00:00:00Z", lift_id="lift_1"
    )
    assert isinstance(lift, LiftResult)
    assert lift.claim_rung == 2  # the ONLY record allowed to be causal
    assert lift.estimate > 0  # correct sign for the planted positive lift
    assert lift.ci_low <= 0.20 <= lift.ci_high  # true lift inside the CI
    assert lift.verdict == "worked"

    # Moat: the intervention row mirrors the lift_result (no independent causal source).
    intervention = record_intervention(
        lift_result=lift, feature_changed="page__comparison_table",
        category="ai-sales-tools", engine="openai",
        intervention_id="int_1", recorded_at="2026-06-30T01:00:00Z",
    )
    assert isinstance(intervention, Intervention)
    assert intervention.measured_lift == lift.estimate
    assert intervention.experiment_id == exp.id

    store = append_intervention([], intervention)
    assert len(store) == 1


def test_power_honesty_in_loop():
    """Too few pairs -> inconclusive, not a fabricated win, even with a big gap."""
    exp = _synthetic_experiment(n_pairs=1)
    panel = _planted_panel(exp, lift=0.40)
    lift = estimate_lift(
        exp, panel, engine="openai", computed_at="t", lift_id="lift_2", min_pairs_for_power=4
    )
    assert lift.verdict == "inconclusive"


def test_delivery_routes_offpage_away_from_page_edit():
    """An off-page gap must NOT be delivered as a Tier-1 page edit."""
    assert route_delivery("page__comparison_table") == "tier1_page_edit"
    assert route_delivery("company__g2_presence") == "tier2_playbook"

    called = {"llm": 0, "cms": 0}
    def fake_llm(*a, **k): called["llm"] += 1; return "content"
    def fake_cms(*a, **k): called["cms"] += 1; return "https://cms/x"

    out = deliver(["company__g2_presence"], ["best crm"], llm=fake_llm, cms=fake_cms)
    # off-page → playbook/referral, never a generated+published page asset
    assert called["llm"] == 0 and called["cms"] == 0
    assert all(o.get("tier") != "tier1_page_edit" for o in out)
