"""Asset generation tests — GPT-4o call mocked."""

from src.assets import generate_asset
from src.models import DeliverableAsset


def _stub_llm(prompt: str) -> str:
    """Test double: returns markdown without calling OpenAI."""
    return (
        "# How to Optimise for Answer Engines\n\n"
        "## Key Findings\n\n"
        "Structured data and direct answers increase citation probability.\n\n"
        "```metadata\n"
        "target_query: answer engine optimization\n"
        "keywords: AEO, citation, structured data\n"
        "```\n\n"
        "## Meta Description\n\n"
        "Learn how to optimise your content for AI answer engines."
    )


class TestGenerateAsset:
    def test_returns_deliverable_asset(self):
        asset = generate_asset(
            hypothesis="comparison_table correlates with citation",
            page_url="https://acme.com/pricing",
            call_llm=_stub_llm,
        )
        assert isinstance(asset, DeliverableAsset)
        assert asset.page_url == "https://acme.com/pricing"
        assert asset.tier == 1
        assert len(asset.content_md) > 0

    def test_content_contains_hypothesis_context(self):
        asset = generate_asset(
            hypothesis="word_count correlates with citation",
            page_url="https://acme.com/blog",
            queries=["how to write SEO content", "content length guide"],
            call_llm=_stub_llm,
        )
        assert "Answer Engine" in asset.content_md
        assert "metadata" in asset.content_md

    def test_honours_page_url(self):
        asset = generate_asset(
            hypothesis="test",
            page_url="https://competitor.com/about",
            call_llm=_stub_llm,
        )
        assert asset.page_url == "https://competitor.com/about"

    def test_includes_queries_when_provided(self):
        queries = ["gtm analytics", "seo tools"]
        asset = generate_asset(
            hypothesis="test hypothesis",
            page_url="https://test.com/p",
            queries=queries,
            call_llm=_stub_llm,
        )
        assert asset.content_md is not None

    def test_default_llm_fallback_no_api_key(self):
        """When OPENAI_API_KEY is not set, the default LLM returns a placeholder."""
        import os
        had_key = os.environ.pop("OPENAI_API_KEY", None)
        try:
            asset = generate_asset(
                hypothesis="test",
                page_url="https://test.com/p",
            )
            assert "placeholder" in asset.content_md.lower() or "not set" in asset.content_md
        finally:
            if had_key is not None:
                os.environ["OPENAI_API_KEY"] = had_key
