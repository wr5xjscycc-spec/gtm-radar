"""3-tier delivery tests — CMS stub, off-page routing, partner stub."""

from src.delivery import (
    build_cms_payload,
    generate_playbook,
    partner_referral_hook,
    classify_offpage_gap,
    is_off_page_gap,
    OFFPAGE_CHANNEL_MAP,
)
from src.models import CmsPublishPayload, PlaybookStep


class TestClassifyOffpageGap:
    def test_on_page_feature_returns_none(self):
        assert classify_offpage_gap("word_count") is None
        assert classify_offpage_gap("comparison_table") is None
        assert classify_offpage_gap("freshness_days") is None

    def test_off_page_feature_returns_channel(self):
        assert classify_offpage_gap("offpage.reddit_presence") == "reddit"
        assert classify_offpage_gap("offpage.g2_presence") == "g2"
        assert classify_offpage_gap("offpage.wikipedia_presence") == "wikipedia"

    def test_is_off_page_gap(self):
        assert is_off_page_gap("offpage.thirdparty_mentions") is True
        assert is_off_page_gap("word_count") is False

    def test_all_offpage_features_mapped(self):
        from src.rows import OFFPAGE_FEATURE_KEYS
        for k in OFFPAGE_FEATURE_KEYS:
            prefixed = f"offpage.{k}"
            assert prefixed in OFFPAGE_CHANNEL_MAP, f"Missing channel mapping for {prefixed}"


class TestBuildCmsPayload:
    def test_returns_cms_publish_payload(self):
        payload = build_cms_payload(
            page_url="https://acme.com/pricing",
            content_md="# Pricing Guide\n\nHow to price your SaaS.\n\n- Tier 1\n- Tier 2",
        )
        assert isinstance(payload, CmsPublishPayload)
        assert payload.page_url == "https://acme.com/pricing"
        assert "Pricing Guide" in payload.title
        assert "<h1>" in payload.body_html
        assert "<ul>" in payload.body_html

    def test_empty_content_uses_untitled(self):
        payload = build_cms_payload(
            page_url="https://acme.com/p",
            content_md="",
        )
        assert payload.title == "Untitled"

    def test_meta_includes_generator_tag(self):
        payload = build_cms_payload(
            page_url="https://acme.com/p",
            content_md="# Hello",
        )
        assert payload.meta.get("generator") == "gtm-radar-p4"


class TestGeneratePlaybook:
    def test_on_page_feature_routes_to_tier1(self):
        step = generate_playbook("word_count")
        assert step.channel == "on_page"
        assert "Tier-1" in step.action

    def test_reddit_gap_returns_playbook_step(self):
        step = generate_playbook("offpage.reddit_presence")
        assert isinstance(step, PlaybookStep)
        assert step.channel == "reddit"
        assert len(step.action) > 0
        assert "cannot be auto-fixed" in step.rationale

    def test_wikipedia_gap_has_notability_guidance(self):
        step = generate_playbook("offpage.wikipedia_presence")
        assert step.channel == "wikipedia"
        assert "notability" in step.action.lower()

    def test_g2_gap_has_review_action(self):
        step = generate_playbook("offpage.g2_presence")
        assert step.channel == "g2"
        assert "review" in step.action.lower()


class TestPartnerReferralHook:
    def test_returns_dict_with_channel(self):
        hook = partner_referral_hook("offpage.thirdparty_mentions")
        assert isinstance(hook, dict)
        assert hook["channel"] == "earned_press"
        assert "stub" in hook["note"].lower()

    def test_onpage_feature_uses_unknown_channel(self):
        hook = partner_referral_hook("word_count")
        assert hook["feature"] == "word_count"
        assert hook["channel"] == "unknown"
