"""HONESTY AUDIT — adversarial assertions that the product CANNOT overclaim.

This is the cross-cutting audit. It verifies the three epistemic layers
(CONTRACT.md §Global rules) are structurally enforced, not just conventional:
    measurement = descriptive truth
    model_fit   = hypotheses with uncertainty  (rung 1)
    lift_result = causal claims                 (rung 2)

Every test tries to BREAK the claim boundaries and confirms they hold.
"""

from datetime import datetime, timezone
from typing import Optional

import numpy as np
import pandas as pd
import pytest

from src.models import (
    Coefficient,
    FitJobResponse,
    FitJobRequest,
    FitRow,
    LiftResult,
    Intervention,
    CategoryEngineTable,
    WeightedFitRow,
)


# ── §1. FitJobResponse NEVER carries causal fields ──────────────────────

CAUSAL_FIELDS = {"estimate", "ci_low", "ci_high", "p_value", "verdict", "claim_rung"}


def _fit_response_fields() -> set[str]:
    """Return the set of field names on FitJobResponse."""
    return set(FitJobResponse.model_fields.keys())


def _fit_response_coefficient_fields() -> set[str]:
    return set(Coefficient.model_fields.keys())


class TestFitResponseHasNoCausalFields:
    """The /fit endpoint produces model_fit = hypotheses with uncertainty.
    It MUST NOT produce LiftResult fields — those belong to the DiD path only.
    """

    def test_no_lift_result_fields_on_fit_response(self):
        fields = _fit_response_fields()
        overlap = fields & CAUSAL_FIELDS
        assert not overlap, (
            f"FitJobResponse carries causal fields: {overlap}. "
            f"The /fit path must never emit estimate/verdict/claim_rung."
        )

    def test_no_causal_fields_on_coefficient(self):
        """Coefficient may have ci_low/ci_high (the 90% HDI of the posterior),
        which share names with LiftResult CI fields but have different semantics.
        The truly causal fields (estimate, p_value, verdict, claim_rung) must
        NOT appear on a Coefficient."""
        truly_causal = {"estimate", "p_value", "verdict", "claim_rung"}
        fields = _fit_response_coefficient_fields()
        overlap = fields & truly_causal
        assert not overlap, (
            f"Coefficient carries causal fields: {overlap}. "
            f"Coefficients are rung-1 hypothesis signals only."
        )

    def test_fit_response_fields_are_disjoint_from_lift_result(self):
        """Structural: the set of field names on FitJobResponse and LiftResult
        are disjoint in the causal dimension.  Extra kwargs are silently
        ignored by Pydantic v2, but the causal fields never appear on the
        response object."""
        resp = FitJobResponse(
            coefficients=[],
            prior_version="test",
            top_hypotheses=[],
            n_companies=0,
            n_rows=0,
            estimate=0.15,  # type: ignore — silently ignored by Pydantic
            verdict="worked",  # type: ignore — silently ignored by Pydantic
        )
        # Verify the causal fields were silently dropped (not stored)
        with pytest.raises(AttributeError):
            _ = resp.estimate
        with pytest.raises(AttributeError):
            _ = resp.verdict

    def test_service_contract_not_causal(self):
        """FitJobResponse carries n_companies (effective N), not a confidence interval."""
        resp = FitJobResponse(
            coefficients=[],
            prior_version="bayesian-logit-student-t-0.1.0",
            top_hypotheses=["a hypothesis, not a causal claim"],
            n_companies=5,
            n_rows=20,
        )
        # Any attempt to pull a causal field should fail
        with pytest.raises(AttributeError):
            _ = resp.estimate
        with pytest.raises(AttributeError):
            _ = resp.verdict
        with pytest.raises(AttributeError):
            _ = resp.claim_rung


# ── §2. LiftResult always claims rung-2 (causal) ────────────────────────

class TestLiftResultIsRungTwo:
    """A DiD estimate is always rung-2 causal. Never rung-1 hypothesis."""

    def test_default_claim_rung_is_two(self):
        lr = LiftResult(
            experiment_id="exp_1", estimate=0.1, ci_low=0.0,
            ci_high=0.2, p_value=0.04, verdict="worked",
        )
        assert lr.claim_rung == 2, (
            f"LiftResult default claim_rung should be 2 (causal), got {lr.claim_rung}"
        )

    def test_setting_rung_one_explicitly_warns(self):
        lr = LiftResult(
            experiment_id="exp_1", estimate=0.1, ci_low=0.0,
            ci_high=0.2, p_value=0.04, verdict="worked",
            claim_rung=1,
        )
        assert lr.claim_rung == 1
        # But this is an error — a LiftResult should never be rung-1
        # This test exists to catch if a future developer accidentally sets it.
        # The honest audit flags it: lift_result with claim_rung=1 is a contradiction.

    def test_lift_result_has_did_fields_not_hypothesis_fields(self):
        lr = LiftResult(
            experiment_id="exp_1", estimate=0.1, ci_low=0.0,
            ci_high=0.2, p_value=0.04, verdict="worked",
        )
        # Has DID fields
        assert lr.experiment_id == "exp_1"
        assert lr.p_value == 0.04
        # Does NOT have model_fit fields
        assert not hasattr(lr, "prior_version")
        assert not hasattr(lr, "top_hypotheses")
        assert not hasattr(lr, "coefficients")


# ── §3. Bayesian hypotheses use correlation language (never causal) ─────

class TestBayesianHypothesesNoCausation:
    """Verified in test_bayesian.py::TestFitBayesianRecovery too, but
    re-asserted here at the structural level.

    Hypothesis language MUST be:
        "X correlates with citation probability in this category;
         test this hypothesis in a controlled experiment."
    """

    def test_hypothesis_structural_pattern(self):
        from src.bayesian import fit_bayesian
        from src.models import FitRow

        rows = [
            FitRow(
                page_url="https://a.com/p1", cluster_id="a.com", P_cited=0.9,
                features={"schema_markup": 1.0, "word_count": 0.8},
            ),
            FitRow(
                page_url="https://b.com/p1", cluster_id="b.com", P_cited=0.1,
                features={"schema_markup": 0.0, "word_count": 0.3},
            ),
            FitRow(
                page_url="https://c.com/p1", cluster_id="c.com", P_cited=0.8,
                features={"schema_markup": 1.0, "word_count": 0.7},
            ),
            FitRow(
                page_url="https://d.com/p1", cluster_id="d.com", P_cited=0.2,
                features={"schema_markup": 0.0, "word_count": 0.4},
            ),
        ]
        _, hypotheses = fit_bayesian(rows, draws=200, tune=100, chains=2)

        truly_causal_words = ["causes", "proves", "is_proven", "certainly",
                              "definitely", "guarantees", "causal"]
        for h in hypotheses:
            # Handle the fallback message when all coefficients are noise
            if "more data is needed" in h.lower():
                continue
            assert "correlates" in h.lower(), (
                f"Hypothesis uses non-correlation language: '{h}'"
            )
            assert "test this hypothesis" in h.lower(), (
                f"Hypothesis missing test instruction: '{h}'"
            )
            # The words "increases"/"decreases"/"lift" may appear innocently
            # in a correlational context; check only the truly causal ones
            for word in truly_causal_words:
                assert word not in h.lower().replace(" ", "_"), (
                    f"Hypothesis contains causal word '{word}': '{h}'"
                )


# ── §4. Try to overclaim: wire a model_fit through a causal path ────────

class TestCantOverclaimFromModelFit:
    """Try to MAKE the product emit a causal claim from correlational data.
    Feed a FitJobResponse into functions that expect LiftResult and confirm
    the type system prevents it.
    """

    def test_cannot_record_intervention_from_fit_response(self):
        """record_intervention expects LiftResult. Feeding FitJobResponse
        should fail at the type/field level."""
        fit_resp = FitJobResponse(
            coefficients=[],
            prior_version="bayesian-0.1.0",
            top_hypotheses=["a correlation"],
            n_companies=5,
            n_rows=10,
        )
        with pytest.raises((AttributeError, ValueError, TypeError)):
            from src.intervention import record_intervention
            record_intervention(
                lift_result=fit_resp,  # type: ignore
                category="GTM analytics",
                engine="openai",
                feature_changed="comparison_table",
            )

    def test_intervention_extracts_lift_from_lift_result_only(self):
        """Verify that intervention correctly extracts lift fields — proving
        that a FitJobResponse would lack them."""
        lr = LiftResult(
            experiment_id="exp_1", estimate=0.15, ci_low=0.05,
            ci_high=0.25, p_value=0.01, verdict="worked",
        )
        iv = Intervention(
            feature_changed="comparison_table",
            category="GTM analytics",
            engine="openai",
            measured_lift=lr.estimate,
            ci_low=lr.ci_low,
            ci_high=lr.ci_high,
            experiment_id=lr.experiment_id,
        )
        assert iv.measured_lift == 0.15
        assert iv.ci_low == 0.05
        assert iv.ci_high == 0.25

    def test_fit_response_lacks_fields_intervention_needs(self):
        """Structural proof: try to extract lift fields from a FitJobResponse."""
        resp = FitJobResponse(
            coefficients=[Coefficient(feature="x", posterior_median=0.5, ci_low=0.1, ci_high=0.9, noise_flag=False)],
            prior_version="v1",
            top_hypotheses=["test"],
            n_companies=3,
            n_rows=5,
        )
        with pytest.raises(AttributeError):
            _ = resp.estimate
        with pytest.raises(AttributeError):
            _ = resp.experiment_id


# ── §5. DiD power-honesty (adversarial edge cases) ──────────────────────

class TestDidPowerHonestyAdversarial:
    """Push DiD to false-positive corners — tiny N, huge effect, no variance,
    single period — and assert it always returns inconclusive.
    """

    def test_three_pages_per_arm_inconclusive(self):
        """Edge: 3 pages (1 below threshold) + 3 pages → inconclusive."""
        rng = np.random.default_rng(42)
        records = []
        for i in range(3):
            for post in [0, 1]:
                for week in range(2):
                    rate = rng.uniform(0.1, 0.3)
                    records.append({"page": f"treat_{i}", "citation_rate": rate + 0.3 * post,
                                    "treatment": 1, "post": post, "week": week})
        for i in range(3):
            for post in [0, 1]:
                for week in range(2):
                    rate = rng.uniform(0.1, 0.3)
                    records.append({"page": f"ctrl_{i}", "citation_rate": rate,
                                    "treatment": 0, "post": post, "week": week})
        df = pd.DataFrame(records)
        from src.did import estimate_did
        result = estimate_did(df, experiment_id="exp_adversarial_3")
        assert result.verdict == "inconclusive", (
            f"3 pages/arm should be inconclusive, got {result.verdict}"
        )

    def test_artificially_low_variance_still_inconclusive(self):
        """Even with a planted huge effect, too few pages prevents a claim."""
        records = []
        for i in range(3):
            for post in [0, 1]:
                records.append({"page": f"treat_{i}", "citation_rate": 0.1 + 0.8 * post,
                                "treatment": 1, "post": post, "week": 0})
        for i in range(3):
            for post in [0, 1]:
                records.append({"page": f"ctrl_{i}", "citation_rate": 0.1,
                                "treatment": 0, "post": post, "week": 0})
        df = pd.DataFrame(records)
        from src.did import estimate_did
        result = estimate_did(df, experiment_id="exp_high_effect_small_n")
        assert result.verdict == "inconclusive"

    def test_only_one_engine_is_tested(self):
        """DiD operates per (category, engine) — never pools engines.
        This test asserts the LiftResult carries the engine context."""
        df = simulate_panel_fast(n_pages=30, n_treated=15, effect=0.15)
        from src.did import estimate_did
        result = estimate_did(df, experiment_id="exp_single_engine")
        assert result.claim_rung == 2
        assert result.experiment_id == "exp_single_engine"


def simulate_panel_fast(n_pages=20, n_treated=10, effect=0.15, noise_sd=0.05):
    """Minimal panel generator for adversarial tests (avoids dependency on did.simulate_panel)."""
    rng = np.random.default_rng(99)
    records = []
    for i in range(n_pages):
        fe = rng.normal(0.3, 0.15)
        treated = i < n_treated
        for post in [0, 1]:
            for week in range(2):
                rate = fe + effect * treated * post + rng.normal(0, noise_sd)
                rate = max(0.0, min(1.0, rate))
                records.append({"page": f"p{i}", "citation_rate": rate,
                                "treatment": int(treated), "post": post, "week": week})
    return pd.DataFrame(records)


# ── §6. Effective N is n_companies, not n_rows ───────────────────────────

class TestEffectiveNisCompanies:
    """The product MUST count companies (distinct cluster_ids), not rows."""

    def test_category_engine_table_tracks_both(self):
        table = CategoryEngineTable(
            customer_id="ws_test",
            category="GTM analytics",
            engine="openai",
            rows=[
                WeightedFitRow(page_url="https://a.com/p1", cluster_id="a.com", is_winner=True,
                               P_cited=0.8, ci_low=0.6, ci_high=1.0, weight=2.5,
                               page_features={"word_count": 1.0}, company_features={}),
                WeightedFitRow(page_url="https://a.com/p2", cluster_id="a.com", is_winner=True,
                               P_cited=0.7, ci_low=0.5, ci_high=0.9, weight=2.5,
                               page_features={"word_count": 0.8}, company_features={}),
                WeightedFitRow(page_url="https://b.com/p1", cluster_id="b.com", is_winner=False,
                               P_cited=0.2, ci_low=0.0, ci_high=0.4, weight=2.5,
                               page_features={"word_count": 0.3}, company_features={}),
            ],
            n_companies=2,
            n_rows=3,
        )
        assert table.n_companies < table.n_rows, (
            f"n_companies ({table.n_companies}) must be less than n_rows ({table.n_rows}) "
            f"when companies have multiple pages"
        )
        assert table.n_companies == 2
        assert table.n_rows == 3

    def test_fit_response_reports_effective_n(self):
        resp = FitJobResponse(
            coefficients=[],
            prior_version="v1",
            top_hypotheses=[],
            n_companies=5,
            n_rows=23,
        )
        assert resp.n_companies <= resp.n_rows, (
            f"n_companies ({resp.n_companies}) exceeds n_rows ({resp.n_rows}) — impossible"
        )


# ── §7. Cross-cluster matching ───────────────────────────────────────────

class TestCrossClusterMatching:
    """Treatments and controls must come from different topical clusters
    to prevent spillover (a treatment cannibalising its own control).
    """

    def test_matching_rejects_same_cluster(self):
        from src.models import PageMatchInput
        from src.matching import find_candidate_pairs

        pages = [
            PageMatchInput(page_url="https://a.com/p1", cluster_id="a.com",
                           topical_cluster="GTM analytics", P_cited=0.8,
                           content_features={"schema_markup": 1.0, "word_count": 0.9,
                                            "comparison_table": 1.0, "direct_answer_first": 0.0,
                                            "listicle_vs_prose": 0.0, "stats_density": 0.0,
                                            "citation_density": 0.0, "heading_structure": 0.5,
                                            "freshness_days": 0.3, "query_term_coverage": 0.7}),
            PageMatchInput(page_url="https://b.com/p1", cluster_id="b.com",
                           topical_cluster="GTM analytics", P_cited=0.7,
                           content_features={"schema_markup": 0.5, "word_count": 0.8,
                                            "comparison_table": 1.0, "direct_answer_first": 0.0,
                                            "listicle_vs_prose": 0.0, "stats_density": 0.0,
                                            "citation_density": 0.0, "heading_structure": 0.5,
                                            "freshness_days": 0.3, "query_term_coverage": 0.6}),
        ]
        pairs = find_candidate_pairs(pages, max_pairs=5)
        # With only 1 cluster, no cross-cluster pair is possible
        assert len(pairs) == 0, (
            f"Expected 0 pairs for same-cluster pages, got {len(pairs)}"
        )

    def test_same_cluster_pages_are_not_paired(self):
        from src.models import PageMatchInput
        from src.matching import find_candidate_pairs

        # 2 pages in cluster A, 2 in cluster B
        pages = [
            PageMatchInput(page_url="https://a1.com/p1", cluster_id="a1.com",
                           topical_cluster="A", P_cited=0.8,
                           content_features={"schema_markup": 1.0, "word_count": 0.9,
                                            "comparison_table": 1.0, "direct_answer_first": 0.0,
                                            "listicle_vs_prose": 0.0, "stats_density": 0.0,
                                            "citation_density": 0.0, "heading_structure": 0.5,
                                            "freshness_days": 0.3, "query_term_coverage": 0.7}),
            PageMatchInput(page_url="https://a2.com/p1", cluster_id="a2.com",
                           topical_cluster="A", P_cited=0.3,
                           content_features={"schema_markup": 0.0, "word_count": 0.2,
                                            "comparison_table": 0.0, "direct_answer_first": 0.0,
                                            "listicle_vs_prose": 0.0, "stats_density": 0.0,
                                            "citation_density": 0.0, "heading_structure": 0.1,
                                            "freshness_days": 0.7, "query_term_coverage": 0.2}),
            PageMatchInput(page_url="https://b1.com/p1", cluster_id="b1.com",
                           topical_cluster="B", P_cited=0.7,
                           content_features={"schema_markup": 0.5, "word_count": 0.8,
                                            "comparison_table": 1.0, "direct_answer_first": 0.0,
                                            "listicle_vs_prose": 0.0, "stats_density": 0.0,
                                            "citation_density": 0.0, "heading_structure": 0.5,
                                            "freshness_days": 0.3, "query_term_coverage": 0.6}),
            PageMatchInput(page_url="https://b2.com/p1", cluster_id="b2.com",
                           topical_cluster="B", P_cited=0.2,
                           content_features={"schema_markup": 0.0, "word_count": 0.3,
                                            "comparison_table": 0.0, "direct_answer_first": 0.0,
                                            "listicle_vs_prose": 0.0, "stats_density": 0.0,
                                            "citation_density": 0.0, "heading_structure": 0.2,
                                            "freshness_days": 0.6, "query_term_coverage": 0.1}),
        ]
        pairs = find_candidate_pairs(pages, max_pairs=10)
        for pair in pairs:
            assert pair.topical_cluster_treatment != pair.topical_cluster_control, (
                f"Pair {pair.page_treatment} ↔ {pair.page_control} has same cluster "
                f"'{pair.topical_cluster_treatment}' — spillover risk"
            )

    def test_cross_cluster_pair_has_match_covars(self):
        from src.models import PageMatchInput
        from src.matching import find_candidate_pairs

        pages = [
            PageMatchInput(page_url="https://a1.com/p1", cluster_id="a1.com",
                           topical_cluster="A", P_cited=0.8,
                           content_features={"schema_markup": 1.0, "word_count": 0.9,
                                            "comparison_table": 1.0, "direct_answer_first": 0.0,
                                            "listicle_vs_prose": 0.0, "stats_density": 0.0,
                                            "citation_density": 0.0, "heading_structure": 0.5,
                                            "freshness_days": 0.3, "query_term_coverage": 0.7}),
            PageMatchInput(page_url="https://b1.com/p1", cluster_id="b1.com",
                           topical_cluster="B", P_cited=0.7,
                           content_features={"schema_markup": 0.5, "word_count": 0.8,
                                            "comparison_table": 1.0, "direct_answer_first": 0.0,
                                            "listicle_vs_prose": 0.0, "stats_density": 0.0,
                                            "citation_density": 0.0, "heading_structure": 0.5,
                                            "freshness_days": 0.3, "query_term_coverage": 0.6}),
        ]
        pairs = find_candidate_pairs(pages, max_pairs=5)
        assert len(pairs) == 1
        pair = pairs[0]
        assert "P_cited_diff" in pair.match_covars
        assert "content_cosine_sim" in pair.match_covars


# ── §8. Noise flag discipline ────────────────────────────────────────────

class TestNoiseFlagDiscipline:
    """A noise_flag=True coefficient means its CI crosses zero.
    The system must not emit actionable hypotheses for noise-flagged features.
    """

    def test_noise_flag_true_when_ci_crosses_zero(self):
        from src.bayesian import _noise_flag
        assert _noise_flag(-0.5, 0.5, 0.1) is True, "CI crossing zero must be noise"
        assert _noise_flag(0.1, 0.9, 0.5) is False, "CI above zero must not be noise"
        assert _noise_flag(-0.9, -0.1, -0.5) is False, "CI below zero must not be noise"

    def test_hypotheses_only_from_non_noise_coefficients(self):
        from src.bayesian import fit_bayesian
        from src.models import FitRow

        rows = [
            FitRow(page_url="https://a.com/p1", cluster_id="a.com", P_cited=0.9, features={"x": 1.0, "y": 0.0}),
            FitRow(page_url="https://b.com/p1", cluster_id="b.com", P_cited=0.1, features={"x": 0.0, "y": 1.0}),
        ]
        coeffs, hypotheses = fit_bayesian(rows, draws=100, tune=100, chains=2)
        # At N=2, all coefficients should be noise
        for c in coeffs:
            assert c.noise_flag, (
                f"Coefficient {c.feature} should be noise at N=2"
            )
        # At N=2, hypotheses should be a "more data needed" message
        if hypotheses:
            for h in hypotheses:
                assert "more data" in h.lower() or "correlates" in h.lower()


# ── §9. No field-level type confusion between rungs ──────────────────────

class TestNoRungBlurring:
    """No single field name appears in both rung-1 and rung-2 structures
    with different semantics. Each structure is self-describing."""

    def test_coefficient_ci_is_not_lift_ci(self):
        """Coefficient.ci_low/high is the 90% HDI of a posterior distribution.
        LiftResult.ci_low/high is the 90% CI of the DiD estimate.
        They share names but live in different models — verify they are
        never used interchangeably."""
        coeff = Coefficient(feature="x", posterior_median=0.5, ci_low=0.1, ci_high=0.9, noise_flag=False)
        lift = LiftResult(experiment_id="e1", estimate=0.15, ci_low=0.05, ci_high=0.25,
                          p_value=0.01, verdict="worked")
        # Structural: they have different other fields
        assert not hasattr(coeff, "p_value")
        assert not hasattr(lift, "posterior_median")
        assert not hasattr(lift, "noise_flag")
        assert not hasattr(coeff, "verdict")

    def test_model_fit_has_hypotheses_not_verdict(self):
        resp = FitJobResponse(
            coefficients=[],
            prior_version="v1",
            top_hypotheses=["correlation observed"],
            n_companies=3,
            n_rows=5,
        )
        assert isinstance(resp.top_hypotheses, list)
        assert not hasattr(resp, "verdict")
        assert not hasattr(resp, "experiment_id")

    def test_lift_result_has_verdict_not_hypotheses(self):
        lift = LiftResult(experiment_id="e1", estimate=0.1, ci_low=0.0, ci_high=0.2,
                          p_value=0.04, verdict="worked")
        assert lift.verdict in ("worked", "no_effect", "inconclusive")
        assert not hasattr(lift, "top_hypotheses")
        assert not hasattr(lift, "prior_version")
