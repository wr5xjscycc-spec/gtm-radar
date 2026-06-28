"""Delivery routing + asset generation/publish tests (P4 Phase 5).

LLM and CMS calls are external; every test injects a fake callable, so by
construction no network is touched (the real callables are never provided).
"""

from __future__ import annotations

import pytest

from src.delivery import (
    TIER1,
    TIER2,
    TIER3,
    deliver,
    generate_asset,
    make_playbook,
    partner_referral,
    publish_to_cms,
    route_delivery,
)


class FakeLLM:
    """Records each prompt; returns deterministic content. Stands in for gpt-4o."""

    def __init__(self) -> None:
        self.prompts: list[str] = []

    def __call__(self, prompt: str) -> str:
        self.prompts.append(prompt)
        return f"GENERATED::{prompt[:20]}"


class FakeCMS:
    """Records each published asset; returns a publish result. Stands in for a CMS."""

    def __init__(self) -> None:
        self.published: list[dict] = []

    def __call__(self, asset: dict) -> dict:
        self.published.append(asset)
        return {"url": f"https://cms.example/{asset['feature']}", "status": "published"}


# --- routing ---------------------------------------------------------------


def test_route_page_feature_is_tier1():
    assert route_delivery("page__comparison_table") == TIER1
    assert route_delivery("page__faq_block") == TIER1


def test_route_offpage_company_features_are_tier2():
    assert route_delivery("company__g2_presence") == TIER2
    assert route_delivery("company__reddit_presence") == TIER2
    assert route_delivery("company__wikipedia_presence") == TIER2


def test_route_earned_media_subset_is_tier3():
    # the documented tier3 subset: backlinks / press / earned-media PR gaps
    assert route_delivery("company__backlink_authority") == TIER3
    assert route_delivery("company__press_mentions") == TIER3


def test_route_unknown_namespace_raises():
    with pytest.raises(ValueError):
        route_delivery("weird_feature_no_prefix")


# --- tier-1 asset generation + publish (injected fakes) --------------------


def test_generate_asset_uses_injected_llm():
    llm = FakeLLM()
    asset = generate_asset("page__comparison_table", ["best crm", "crm vs"], llm=llm)

    assert llm.prompts, "the injected llm must have been called"
    assert asset["feature"] == "page__comparison_table"
    assert asset["tier"] == TIER1
    assert asset["queries"] == ["best crm", "crm vs"]
    assert asset["content"].startswith("GENERATED::")


def test_generate_asset_refuses_offpage_feature():
    llm = FakeLLM()
    with pytest.raises(ValueError):
        generate_asset("company__g2_presence", ["q"], llm=llm)
    assert not llm.prompts, "must reject before calling the llm"


def test_generate_asset_requires_injected_llm():
    with pytest.raises(ValueError):
        generate_asset("page__comparison_table", ["q"], llm=None)


def test_publish_to_cms_uses_injected_cms():
    cms = FakeCMS()
    asset = {"feature": "page__comparison_table", "tier": TIER1, "content": "x"}
    event = publish_to_cms(asset, cms=cms)

    assert cms.published == [asset], "the injected cms must have been called with the asset"
    assert event["asset"] is asset
    assert event["url"] == "https://cms.example/page__comparison_table"
    assert event["status"] == "published"
    assert event["published_at"]


def test_publish_requires_injected_cms():
    with pytest.raises(ValueError):
        publish_to_cms({"feature": "page__x"}, cms=None)


# --- deterministic tier-2 / tier-3 -----------------------------------------


def test_make_playbook_is_offpage_guidance():
    pb = make_playbook("company__g2_presence")
    assert pb["tier"] == TIER2
    assert pb["feature"] == "company__g2_presence"
    assert pb["steps"]
    assert "content" not in pb  # never a page asset


def test_partner_referral_is_tier3():
    ref = partner_referral("company__backlink_authority")
    assert ref["tier"] == TIER3
    assert ref["feature"] == "company__backlink_authority"
    assert "content" not in ref


# --- orchestration: mixed on/off-page (anti-overclaim guard) ---------------


def test_deliver_routes_mixed_features_correctly():
    llm, cms = FakeLLM(), FakeCMS()
    results = deliver(
        [
            "page__comparison_table",
            "company__g2_presence",
            "company__backlink_authority",
        ],
        queries=["best tool", "tool vs"],
        llm=llm,
        cms=cms,
    )
    by_feature = {r["feature"]: r for r in results}

    # tier-1: generated + published page asset
    t1 = by_feature["page__comparison_table"]
    assert t1["tier"] == TIER1
    assert t1["asset"]["content"].startswith("GENERATED::")
    assert t1["publish"]["status"] == "published"

    # tier-2: playbook, NOT a page-edit asset
    t2 = by_feature["company__g2_presence"]
    assert t2["tier"] == TIER2
    assert "asset" not in t2 and "content" not in t2

    # tier-3: partner referral, NOT a page-edit asset
    t3 = by_feature["company__backlink_authority"]
    assert t3["tier"] == TIER3
    assert "asset" not in t3 and "content" not in t3


def test_deliver_offpage_never_produces_tier1_asset():
    # The core honesty guard: only the on-page feature gets the llm/cms treatment.
    llm, cms = FakeLLM(), FakeCMS()
    results = deliver(
        ["company__g2_presence", "company__press_mentions"],
        queries=["q"],
        llm=llm,
        cms=cms,
    )
    assert all(r["tier"] != TIER1 for r in results)
    assert not llm.prompts, "no off-page feature may trigger asset generation"
    assert not cms.published, "no off-page feature may be published as a page edit"


def test_deliver_extracts_feature_from_hypothesis_sentence():
    llm, cms = FakeLLM(), FakeCMS()
    sentence = (
        "Pages with higher `page__comparison_table` may be cited more often "
        "(hypothesis — test with an experiment)"
    )
    (result,) = deliver([sentence], queries=["q"], llm=llm, cms=cms)
    assert result["feature"] == "page__comparison_table"
    assert result["tier"] == TIER1
