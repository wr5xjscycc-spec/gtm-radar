"""Case-control labeling for the winner/loser modeling pool (P4 Phase 3).

The non-negotiable intelligence fact this module enforces: a **loser is a page that
was *considered-but-not-cited*, not an arbitrary uncited page**. An LLM answer
retrieves/considers a small candidate set per query; pages outside that set were
never in contention, so treating them as "losers" would compare winners against a
near-infinite pool of irrelevant URLs and manufacture signal that isn't there
(selection bias). A valid control must have been *retrieved/considered* — i.e. it
``appeared`` — but lost the citation. Pages that never appeared are EXCLUDED from
the pool entirely, not labeled "loser".

Mapping (per ``measurement``: ``appeared`` bool, ``cited`` bool):
- ``cited=True``                  -> "winner"
- ``appeared=True, cited=False``  -> "loser"  (considered, lost)
- ``appeared=False``              -> None     (out of contention; excluded)
"""

from __future__ import annotations

from typing import Optional


def case_control_label(appeared: bool, cited: bool) -> Optional[str]:
    """Map a single (appeared, cited) outcome to a case-control label.

    Returns ``None`` for not-considered pages so callers drop them from the pool —
    a None here means "excluded", which is distinct from "loser".
    """
    if cited:
        return "winner"
    if appeared:
        return "loser"
    return None


def label_measurement(measurement: dict) -> Optional[str]:
    """Apply :func:`case_control_label` to a raw ``measurement`` record.

    Missing ``appeared``/``cited`` are treated as False (a record that asserts
    neither was retrieved nor cited).
    """
    return case_control_label(bool(measurement.get("appeared")), bool(measurement.get("cited")))


def ci_weight(ci_width: Optional[float]) -> float:
    """Certainty weight for a row's P(cited) label: ``1 / (1 + ci_width)``.

    Wider credible interval => noisier P(cited) estimate => smaller weight, so the
    later fit trusts well-measured rows more. Weight is 1.0 when the width is
    ``None`` (unknown / single run) or 0.0 (a perfectly certain estimate), and
    decreases monotonically as the width grows. Negative widths are clamped to 0.
    """
    if ci_width is None or ci_width <= 0.0:
        return 1.0
    return 1.0 / (1.0 + ci_width)
