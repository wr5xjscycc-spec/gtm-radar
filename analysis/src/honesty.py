"""The honesty audit — the guard that lets the product survive a hostile demo
question (P4 Phase 6, task 3; the mandatory honesty assertion in ``docs/TESTING.md``).

The whole credibility of this product is "we don't overclaim." That promise is
enforced by **three epistemic layers**, each allowed to speak only at its rung:

- **Rung 0 — measurement** (P2): *descriptive*. "This page was cited X% of the
  time." A fact about what was observed; no claim about why.
- **Rung 1 — model_fit** (P4 Phase 4): *hypotheses with uncertainty*. A
  coefficient whose credible interval clears zero is a **correlation observed in
  thin observational data** — a thing worth testing, never a law. ``model_fit``
  language must stay tentative and must NOT imply causation. A ``model_fit``
  carries no ``estimate``/``verdict``/``claim_rung==2`` — it cannot, structurally,
  be a causal claim.
- **Rung 2 — lift_result** (P4 Phase 5): *causal*. Earned ONLY by the randomized
  matched-pair difference-in-differences experiment, which writes a ``lift_result``
  with ``claim_rung == 2``. Causal language is impossible without a ``lift_result``.

Why this module is load-bearing: the red-team's central finding is that the one
honest, real, not-already-shipped thing is **causal lift measurement via the closed
loop**. Coefficients from observational data do NOT justify "add X to win"
(correlation != causation). The single way to destroy this product is to let a
``model_fit`` coefficient masquerade as a causal claim. These audits are the
mechanical proof that it cannot: causal output (``lift_result``) is emitted only
from the randomized DiD path, never from ``model_fit`` coefficients.

The audits accept either pydantic models (``contract.ModelFit`` / ``LiftResult`` /
``Intervention``) or plain dicts. That duality is deliberate: the pydantic models
already enforce the happy path (``noise_flag`` required, CI ordered, ``Verdict``
constrained, no causal fields on ``ModelFit``), so a *doctored* over-claim can only
arrive as a dict. The audits must catch it there.
"""

from __future__ import annotations

from typing import Any, Optional

from src.hypotheses import BANNED_CAUSAL_WORDS

# Fields whose presence on a record asserts a Rung-2 causal claim. On a model_fit
# (Rung 1) any of these is a smuggled over-claim; a real ModelFit has none of them.
_CAUSAL_CLAIM_FIELDS: tuple[str, ...] = ("estimate", "verdict", "claim_rung")


def _get(obj: Any, key: str, default: Any = None) -> Any:
    """Read ``key`` from either a pydantic model (attribute) or a dict.

    The audits police both shapes, so every field access goes through here — a
    doctored over-claim usually arrives as a dict with extra keys a model could
    never hold.
    """
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _contains_banned_word(text: str) -> Optional[str]:
    """Return the first banned causal word found in ``text`` (case-insensitive), or
    ``None``. Same substring check the Rung-1 language guard uses, applied here so
    the audit polices the identical vocabulary."""
    low = text.lower()
    for word in BANNED_CAUSAL_WORDS:
        if word in low:
            return word
    return None


def _has_causal_claim_field(obj: Any) -> list[str]:
    """List the causal-claim fields present on ``obj``.

    ``claim_rung`` only counts as a causal assertion at rung 2 — a ``claim_rung: 1``
    on a model_fit is honest self-labelling, not an over-claim.
    """
    found: list[str] = []
    for field in _CAUSAL_CLAIM_FIELDS:
        value = _get(obj, field, None)
        if value is None:
            continue
        if field == "claim_rung":
            if int(value) >= 2:
                found.append(field)
        else:
            found.append(field)
    return found


def audit_model_fit(model_fit: Any) -> dict:
    """Assert a ``model_fit`` stays on the hypothesis layer (Rung 1).

    Checks: (a) every coefficient carries a ``noise_flag``; (b) ``top_hypotheses``
    contain no banned causal words; (c) — the load-bearing one — the record carries
    NO causal-claim field (``estimate``/``verdict``/``claim_rung>=2``). A real
    ``ModelFit`` passes (a) and (c) by construction; (c) only ever fires on a
    doctored dict trying to smuggle a causal claim onto the hypothesis layer.

    Returns ``{"ok": bool, "violations": [str, ...]}``.
    """
    violations: list[str] = []

    coefficients = _get(model_fit, "coefficients", []) or []
    for i, coef in enumerate(coefficients):
        if _get(coef, "noise_flag", None) is None:
            feature = _get(coef, "feature", f"#{i}")
            violations.append(
                f"coefficient {feature!r} has no noise_flag (every coefficient "
                "must be flagged signal-or-noise)"
            )

    for hypothesis in _get(model_fit, "top_hypotheses", []) or []:
        banned = _contains_banned_word(str(hypothesis))
        if banned:
            violations.append(
                f"top_hypothesis carries banned causal word {banned!r}: {hypothesis!r}"
            )

    for field in _has_causal_claim_field(model_fit):
        violations.append(
            f"model_fit carries causal-claim field {field!r}; a model_fit is "
            "Rung-1 (hypotheses) and can never assert causation"
        )

    return {"ok": not violations, "violations": violations}


def audit_lift_result(lift_result: Any, *, claimed_verdict: Optional[str] = None) -> dict:
    """Audit a ``lift_result`` — the only record allowed to speak causally (Rung 2).

    Checks: ``claim_rung == 2``; ``verdict`` in {worked, no_effect, inconclusive};
    CI ordered (``ci_low <= ci_high``). And the presentation guard: if the measured
    ``verdict`` is ``inconclusive`` but the caller presents it as ``worked``
    (``claimed_verdict``), that is dressing "can't tell yet" as a win — flagged.

    Returns ``{"ok": bool, "violations": [str, ...]}``.
    """
    violations: list[str] = []

    rung = _get(lift_result, "claim_rung", None)
    if rung is None or int(rung) != 2:
        violations.append(
            f"lift_result claim_rung is {rung!r}, expected 2 (a causal claim is "
            "Rung 2)"
        )

    verdict = _get(lift_result, "verdict", None)
    if verdict not in ("worked", "no_effect", "inconclusive"):
        violations.append(f"lift_result verdict {verdict!r} is not a valid verdict")

    ci_low = _get(lift_result, "ci_low", None)
    ci_high = _get(lift_result, "ci_high", None)
    if ci_low is not None and ci_high is not None and float(ci_low) > float(ci_high):
        violations.append(f"CI is mis-ordered: ci_low={ci_low} > ci_high={ci_high}")

    if verdict == "inconclusive" and claimed_verdict == "worked":
        violations.append(
            "an inconclusive lift_result is being presented as 'worked' — "
            "'can't tell yet' must never be dressed as a win"
        )

    return {"ok": not violations, "violations": violations}


def assert_no_causation_without_experiment(
    *,
    model_fit: Any = None,
    lift_result: Any = None,
    claimed_verdict: Optional[str] = None,
) -> dict:
    """The headline guard: no causal claim may exist without a backing DiD experiment.

    A causal claim is asserted when any of these is true:
    - a ``model_fit`` carries a causal-claim field (``estimate``/``verdict``/
      ``claim_rung>=2``) — a Rung-1 record reaching for Rung-2 language;
    - the caller presents a verdict of ``"worked"`` (``claimed_verdict``);
    - a ``lift_result`` is supplied (it is by definition a causal record).

    The claim is *backed* only by a ``lift_result`` whose ``claim_rung == 2`` and
    whose ``verdict == "worked"`` (i.e. a real randomized-DiD positive result). A
    ``model_fit`` can NEVER back a causal claim — it is structurally Rung 1. So:
    a causal claim sourced from a ``model_fit`` with no ``lift_result`` is always a
    violation; that is exactly the over-claim this product must make impossible.

    Returns ``{"ok": bool, "violations": [str, ...]}``. See
    :func:`assert_no_causation_without_experiment_strict` for the raising variant.
    """
    violations: list[str] = []

    # Does a valid, positive Rung-2 lift_result exist to back any causal claim?
    backing_ok = False
    if lift_result is not None:
        audit = audit_lift_result(lift_result, claimed_verdict=claimed_verdict)
        rung = _get(lift_result, "claim_rung", None)
        verdict = _get(lift_result, "verdict", None)
        backing_ok = audit["ok"] and rung is not None and int(rung) == 2 and verdict == "worked"
        violations.extend(audit["violations"])

    # A model_fit reaching for causal language is an over-claim regardless of any
    # lift_result: the model_fit itself can never be the causal source.
    if model_fit is not None:
        for field in _has_causal_claim_field(model_fit):
            violations.append(
                f"causal-claim field {field!r} found on a model_fit — coefficients "
                "are Rung-1 hypotheses and can never yield a causal claim; only a "
                "randomized-DiD lift_result can"
            )

    # The caller presents a win; it is only honest if backed by a worked lift_result.
    if claimed_verdict == "worked" and not backing_ok:
        violations.append(
            "a 'worked' causal claim was made without a backing rung-2 lift_result "
            "from the randomized DiD path"
        )

    return {"ok": not violations, "violations": violations}


def assert_no_causation_without_experiment_strict(
    *,
    model_fit: Any = None,
    lift_result: Any = None,
    claimed_verdict: Optional[str] = None,
) -> None:
    """Raising variant of :func:`assert_no_causation_without_experiment`.

    Raises ``AssertionError`` listing the violations when a causal claim is not
    backed by a randomized-DiD ``lift_result``. Use as a hard guard in code paths
    that must never emit unbacked causation.
    """
    result = assert_no_causation_without_experiment(
        model_fit=model_fit,
        lift_result=lift_result,
        claimed_verdict=claimed_verdict,
    )
    if not result["ok"]:
        raise AssertionError(
            "no-causation-without-experiment violated: " + "; ".join(result["violations"])
        )


def _infer_record_kind(record: Any) -> str:
    """Infer a record's epistemic kind from its *structure*, not its self-reported
    ``claim_rung``.

    Trusting ``claim_rung`` would be circular — a doctored record lies about its
    rung, and that lie is exactly what the ladder audit must catch. So we read the
    shape instead: an ``intervention`` has ``measured_lift`` + ``experiment_id``; a
    ``lift_result`` has ``estimate`` + ``verdict``; a ``model_fit`` has
    ``coefficients`` / ``top_hypotheses``.
    """
    if _get(record, "measured_lift", None) is not None and _get(record, "experiment_id", None) is not None:
        return "intervention"
    if _get(record, "estimate", None) is not None and _get(record, "verdict", None) is not None:
        return "lift_result"
    if _get(record, "coefficients", None) is not None or _get(record, "top_hypotheses", None) is not None:
        return "model_fit"
    return "unknown"


# The rung each structurally-identified record is allowed to claim. A model_fit is
# Rung 1; lift_result and the intervention it mirrors are Rung 2.
_RUNG_FOR_KIND: dict[str, int] = {
    "model_fit": 1,
    "lift_result": 2,
    "intervention": 2,
}


def audit_claim_ladder(records: list) -> dict:
    """Audit a mixed list of model_fit / lift_result / intervention records.

    For each record, infer its kind from structure and assert its self-reported
    ``claim_rung`` (where present) does not exceed the rung its data supports: a
    ``model_fit`` claiming Rung 2 is rejected (coefficients can't carry a causal
    claim), an unknown-shaped record is flagged, and any record whose ``claim_rung``
    overshoots its structural rung is flagged.

    Returns ``{"ok": bool, "violations": [str, ...]}``.
    """
    violations: list[str] = []

    for i, record in enumerate(records):
        kind = _infer_record_kind(record)
        if kind == "unknown":
            violations.append(f"record #{i} has no recognizable epistemic shape")
            continue

        allowed_rung = _RUNG_FOR_KIND[kind]
        claimed = _get(record, "claim_rung", None)
        if claimed is not None and int(claimed) > allowed_rung:
            violations.append(
                f"record #{i} ({kind}) claims rung {int(claimed)} but its data only "
                f"supports rung {allowed_rung}"
            )

        # A model_fit-shaped record carrying any causal-claim field is over-claiming
        # even if it omits an explicit claim_rung.
        if kind == "model_fit":
            for field in _has_causal_claim_field(record):
                violations.append(
                    f"record #{i} (model_fit) carries causal-claim field {field!r}; "
                    "a hypothesis record can never assert causation"
                )

    return {"ok": not violations, "violations": violations}
