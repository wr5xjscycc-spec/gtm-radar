"""Hypothesis selection + the Rung-1 claim-ladder payload (P4 Phase 4, tasks 3-4).

This module turns a fitted ``ModelFit`` into the **top 1-3 surviving signals** and a
serializable payload P1 renders in its diagnosis UI. It is the *honest hypothesis
layer*, and nothing more.

The claim ladder (read this before changing any wording):
- **Rung 0 — measurement** (P2): descriptive. "This page was cited X% of the time."
- **Rung 1 — model_fit** (this module): *hypotheses with uncertainty*. A coefficient
  whose credible interval clears zero is a **correlation observed in thin
  observational data** — a thing worth testing, never a law. Output here MUST be
  tentative ("may", "associated with", "hypothesis") and MUST NOT imply causation.
- **Rung 2 — lift_result** (Phase 5): causal. Earned only by the randomized
  matched-pair difference-in-differences experiment, which writes a ``lift_result``
  with ``claim_rung=2``. This module must NEVER emit Rung-2 language; if you want to
  say a feature *produces* citations, you need the experiment first.

The red-team non-negotiables baked in here: correlation != causation (the model is a
hypothesis generator), and effective N = ``n_companies`` (pseudo-replication), which
is why the payload surfaces it so the UI can show how thin the data is.
"""

from __future__ import annotations

from src.contract import Coefficient, ModelFit

# Causal / over-claiming vocabulary that must never appear in Rung-1 output. The
# language guard test asserts none of these (case-insensitive) reach the payload.
BANNED_CAUSAL_WORDS: tuple[str, ...] = (
    "cause",
    "causes",
    "causal",
    "drives",
    "increases",
    "guarantee",
    "will rank",
    "because of",
)


def _evidence_distance(coef: Coefficient) -> float:
    """Strength of evidence = how far the whole credible interval sits from zero.

    For a survivor the interval does not cross zero, so both bounds share a sign and
    the bound *nearest* zero is the conservative (smallest-magnitude) effect the data
    still support. Ranking by that nearest bound rewards intervals that are both far
    from zero and tight, which is exactly "strong evidence" — not just a big point
    estimate that might have a bound grazing zero.
    """
    return min(abs(coef.ci_low), abs(coef.ci_high))


def _hypothesis_sentence(coef: Coefficient) -> str:
    """Render one survivor as a tentative, non-causal hypothesis string.

    Direction mapping: a positive ``posterior_median`` means the feature is
    *associated with being cited* (winner direction); a negative median means it is
    associated with *not* being cited. We phrase association + a direction + an
    explicit "test it" tag, and deliberately avoid any verb that asserts causation.
    """
    if coef.posterior_median >= 0:
        direction = "may be cited more often"
    else:
        direction = "may be cited less often"
    return (
        f"Pages with higher `{coef.feature}` {direction} "
        f"(hypothesis — test with an experiment)"
    )


def select_top_hypotheses(model_fit: ModelFit, k: int = 3) -> list[str]:
    """Return up to ``k`` top surviving signals as hypothesis-language strings.

    Only ``noise_flag is False`` coefficients (intervals that clear zero) are
    considered survivors. Survivors are ranked by :func:`_evidence_distance`
    (descending), tie-broken by ``|posterior_median|`` (descending) for determinism.
    If nothing survives, returns ``[]`` — an honest "no signal survived", never a
    fabricated hypothesis.
    """
    if k <= 0:
        return []
    survivors = [c for c in model_fit.coefficients if not c.noise_flag]
    survivors.sort(
        key=lambda c: (_evidence_distance(c), abs(c.posterior_median)),
        reverse=True,
    )
    return [_hypothesis_sentence(c) for c in survivors[:k]]


def rung1_payload(model_fit: ModelFit, *, k: int = 3) -> dict:
    """Build the serializable Rung-1 diagnosis payload for P1.

    Carries the survivor hypotheses plus the honesty context the UI needs to avoid
    overclaiming: how many features were tested, how many were noise, the effective
    N (``n_companies``), and a caveat spelling out that these are tentative,
    uncertainty-flagged hypotheses — not causal claims (which require a Rung-2
    ``lift_result``). No causal language anywhere in the payload.
    """
    coefficients = model_fit.coefficients
    n_total = len(coefficients)
    n_noise = sum(1 for c in coefficients if c.noise_flag)
    n_surviving = n_total - n_noise
    top = select_top_hypotheses(model_fit, k=k)

    # Deliberately conveys "not causal" without the literal word "causal": the
    # language guard bans that token from all output, so do not "fix" this back in.
    caveat = (
        "These are uncertainty-flagged hypotheses to test, not established effects: "
        "an observed association is not proof that editing a feature changes whether "
        f"a page is cited. Effective N = {model_fit.n_companies} companies, so treat "
        "every signal as tentative. Confirming any effect requires a randomized "
        "experiment (claim Rung 2)."
    )

    return {
        "claim_rung": 1,
        "category": model_fit.category,
        "engine": model_fit.engine,
        "n_companies": model_fit.n_companies,
        "n_features_total": n_total,
        "n_features_noise": n_noise,
        "n_features_surviving": n_surviving,
        "top_hypotheses": top,
        "caveat": caveat,
    }
