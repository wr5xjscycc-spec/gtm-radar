"""Asset generation + 3-tier delivery routing (P4 Phase 5, tasks 4-6).

The diagnosis-delivery gap (red-team, Phase-5 gotcha)
-----------------------------------------------------
A page edit can only fix an *on-page* gap. The model also surfaces *off-page*
gaps — weak G2/Reddit/Wikipedia presence, thin reviews, missing backlinks/press.
Auto-generating a page and publishing it does **nothing** for those: pretending a
page edit closes an off-page gap is exactly the dishonesty the whole product is
built to avoid. So delivery routes by *where the gap lives*, not by what is
convenient to automate:

- **Tier-1 — page edit** (``page__*``): on-page, auto-fixable. Generate an
  AEO-optimized asset and one-click publish to the CMS.
- **Tier-2 — playbook** (``company__*`` off-page, e.g. G2/Reddit/Wikipedia/
  reviews): a page edit cannot fix this; we hand the customer structured, manual
  guidance instead.
- **Tier-3 — partner referral** (``company__*`` earned-media/PR subset, e.g.
  backlinks/press): not even a playbook the customer runs solo — these need
  outreach/PR, so we route to a partner referral.

Honest routing is the point: an off-page feature must never come back as a
Tier-1 page-edit asset.

The feature-namespacing convention is load-bearing: ``page__*`` is on-page and
auto-fixable; ``company__*`` is off-page/company-level and is not.

All external calls (LLM asset generation, CMS publish) are **dependency-
injected** callables so unit tests pass fakes and never touch the network.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Callable, Optional, Union

TIER1 = "tier1_page_edit"
TIER2 = "tier2_playbook"
TIER3 = "tier3_partner_referral"

PAGE_PREFIX = "page__"
COMPANY_PREFIX = "company__"

# Off-page earned-media/PR stems. These ``company__*`` gaps cannot be closed by a
# customer running a playbook alone — they need outreach/PR — so they route to a
# partner referral (Tier-3) rather than a Tier-2 self-serve playbook.
TIER3_STEMS: tuple[str, ...] = ("backlink", "press", "earned_media", "pr_")

# Matches a feature token wherever it sits in a hypothesis sentence, e.g. the
# backtick-wrapped token in "Pages with higher `page__comparison_table` may ...".
_FEATURE_TOKEN = re.compile(r"(page__|company__)[a-z0-9_]+")

# A feature name, or a hypothesis sentence carrying one (see ``_extract_feature``).
HypothesisInput = Union[str]


def route_delivery(feature: str) -> str:
    """Return the delivery tier for a hypothesis feature.

    Mapping (the prefix decides on-page vs off-page):
    - ``page__*``                       -> ``tier1_page_edit``   (auto-fixable)
    - ``company__*`` with a PR/earned   -> ``tier3_partner_referral``
      stem (backlink/press/earned_media/pr_)
    - any other ``company__*``          -> ``tier2_playbook``    (off-page, manual)

    Raises ``ValueError`` on an unknown namespace — guessing a tier for an
    unrecognized feature would risk silently auto-"fixing" an off-page gap.
    """
    if feature.startswith(PAGE_PREFIX):
        return TIER1
    if feature.startswith(COMPANY_PREFIX):
        stem = feature[len(COMPANY_PREFIX) :]
        if any(s in stem for s in TIER3_STEMS):
            return TIER3
        return TIER2
    raise ValueError(
        f"unknown feature namespace: {feature!r} "
        f"(expected '{PAGE_PREFIX}' or '{COMPANY_PREFIX}')"
    )


def _extract_feature(item: str) -> str:
    """Pull the feature token out of a raw feature name or a hypothesis sentence.

    Accepts either a bare ``page__x`` / ``company__x`` token or a full hypothesis
    string (which embeds the token in backticks). Raises if no token is found.
    """
    match = _FEATURE_TOKEN.search(item)
    if match is None:
        raise ValueError(f"no page__/company__ feature token found in {item!r}")
    return match.group(0)


def generate_asset(
    feature: str,
    queries: list[str],
    *,
    llm: Optional[Callable[[str], str]] = None,
) -> dict:
    """Tier-1 only: generate an AEO-optimized page asset for ``feature`` + queries.

    ``llm`` is an injected callable ``(prompt) -> content``; tests pass a fake so
    no real model is ever called. Refuses non-Tier-1 features — generating a page
    for an off-page gap is the overclaim this module exists to prevent.
    """
    tier = route_delivery(feature)
    if tier != TIER1:
        raise ValueError(
            f"generate_asset is Tier-1 only; {feature!r} routes to {tier} — "
            "a page edit cannot fix an off-page gap"
        )
    if llm is None:
        raise ValueError("generate_asset requires an injected `llm` callable")

    prompt = (
        "Write an AEO-optimized page section that answers these queries "
        f"and strengthens the on-page signal '{feature}'.\nQueries: "
        f"{'; '.join(queries)}"
    )
    content = llm(prompt)
    return {
        "feature": feature,
        "tier": tier,
        "queries": list(queries),
        "content": content,
    }


def publish_to_cms(
    asset: dict,
    *,
    cms: Optional[Callable[[dict], dict]] = None,
) -> dict:
    """Tier-1 one-click publish via an injected ``cms`` callable.

    ``cms`` is ``(asset) -> {"url", "status", ...}``; tests pass a fake so no real
    CMS is hit. Returns a publish-event dict.
    """
    if cms is None:
        raise ValueError("publish_to_cms requires an injected `cms` callable")
    result = cms(asset)
    return {
        "asset": asset,
        "url": result.get("url"),
        "status": result.get("status", "published"),
        "published_at": datetime.now(timezone.utc).isoformat(),
    }


def make_playbook(feature: str) -> dict:
    """Tier-2: deterministic, no external calls. Structured manual guidance for an
    off-page ``company__*`` gap a page edit cannot fix (G2/Reddit/Wikipedia/...)."""
    gap = feature[len(COMPANY_PREFIX) :] if feature.startswith(COMPANY_PREFIX) else feature
    return {
        "feature": feature,
        "tier": TIER2,
        "gap_type": "off_page",
        "steps": [
            f"Audit current off-page presence for '{gap}'.",
            f"Plan owned actions to strengthen '{gap}' (profiles, reviews, edits).",
            "Track the off-page signal over the next measurement window.",
        ],
        "rationale": (
            f"'{feature}' is an off-page signal; a page edit cannot move it, so "
            "this is manual self-serve guidance rather than an auto-published asset."
        ),
    }


def partner_referral(feature: str) -> dict:
    """Tier-3: deterministic, no external calls. Earned-media/PR gaps (backlinks/
    press) that need outreach — routed to a partner rather than a self-serve play."""
    gap = feature[len(COMPANY_PREFIX) :] if feature.startswith(COMPANY_PREFIX) else feature
    return {
        "feature": feature,
        "tier": TIER3,
        "partner_type": "earned_media_pr",
        "action": f"Refer to a PR/earned-media partner to address '{gap}'.",
        "rationale": (
            f"'{feature}' is an earned-media/PR gap; it cannot be self-served via a "
            "page edit or a playbook, so it routes to a partner referral."
        ),
    }


def deliver(
    hypotheses: list[HypothesisInput],
    queries: list[str],
    *,
    llm: Optional[Callable[[str], str]] = None,
    cms: Optional[Callable[[dict], dict]] = None,
) -> list[dict]:
    """Route each hypothesis to its tier and produce the right artifact.

    ``hypotheses`` items are feature names (``page__x`` / ``company__x``) or full
    hypothesis sentences carrying such a token (see ``_extract_feature``).

    - Tier-1 -> generate the asset (injected ``llm``) and publish it (injected
      ``cms``); the result carries ``asset`` + ``publish``.
    - Tier-2 -> a playbook dict.
    - Tier-3 -> a partner-referral dict.

    Every result dict carries ``feature`` and ``tier``. By construction an
    off-page feature never yields a Tier-1 page-edit asset (the anti-overclaim
    guard): its result has the Tier-2/3 tier and no generated page content.
    """
    results: list[dict] = []
    for item in hypotheses:
        feature = _extract_feature(item)
        tier = route_delivery(feature)
        if tier == TIER1:
            asset = generate_asset(feature, queries, llm=llm)
            publish = publish_to_cms(asset, cms=cms)
            results.append(
                {"feature": feature, "tier": tier, "asset": asset, "publish": publish}
            )
        elif tier == TIER2:
            results.append(make_playbook(feature))
        else:  # TIER3
            results.append(partner_referral(feature))
    return results
