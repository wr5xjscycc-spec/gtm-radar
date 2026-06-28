"""Matching tests — cross-cluster candidate pair generation."""

import pytest
from src.models import PageMatchInput, FitRow
from src.matching import find_candidate_pairs, build_match_inputs_from_fit_rows


def _page(page_url, cluster_id, topical_cluster, p_cited=None, **cf):
    return PageMatchInput(
        page_url=page_url,
        cluster_id=cluster_id,
        topical_cluster=topical_cluster,
        P_cited=p_cited,
        content_features=cf,
    )


class TestFindCandidatePairs:
    def test_empty_pages_returns_empty(self):
        assert find_candidate_pairs([]) == []

    def test_single_page_returns_empty(self):
        p = _page("https://a.com/p", "a.com", "cluster_A", 0.5, word_count=100)
        assert find_candidate_pairs([p]) == []

    def test_two_pages_same_cluster_returns_empty(self):
        pages = [
            _page("https://a.com/p1", "a.com", "cluster_A", 0.9, word_count=100),
            _page("https://a.com/p2", "a.com", "cluster_A", 0.1, word_count=200),
        ]
        pairs = find_candidate_pairs(pages)
        assert len(pairs) == 0

    def test_two_pages_cross_cluster_returns_pair(self):
        pages = [
            _page("https://a.com/p1", "a.com", "cluster_A", 0.9, word_count=100),
            _page("https://b.com/p1", "b.com", "cluster_B", 0.1, word_count=200),
        ]
        pairs = find_candidate_pairs(pages)
        assert len(pairs) == 1
        pair = pairs[0]
        assert pair.topical_cluster_treatment != pair.topical_cluster_control
        assert "P_cited_diff" in pair.match_covars

    def test_all_pairs_are_cross_cluster(self):
        pages = [
            _page("https://a.com/p1", "a.com", "GTM", 0.9, word_count=100),
            _page("https://a.com/p2", "a.com", "GTM", 0.7, word_count=150),
            _page("https://b.com/p1", "b.com", "Analytics", 0.3, word_count=200),
            _page("https://b.com/p2", "b.com", "Analytics", 0.1, word_count=250),
            _page("https://c.com/p1", "c.com", "SEO", 0.5, word_count=180),
            _page("https://c.com/p2", "c.com", "SEO", 0.4, word_count=220),
        ]
        pairs = find_candidate_pairs(pages, max_pairs=10)
        assert len(pairs) >= 1
        for p in pairs:
            assert p.topical_cluster_treatment != p.topical_cluster_control, (
                f"Same-cluster pair: {p}"
            )

    def test_no_page_appears_twice(self):
        pages = [
            _page("https://a.com/p1", "a.com", "GTM", 0.9, word_count=100),
            _page("https://a.com/p2", "a.com", "GTM", 0.7, word_count=150),
            _page("https://b.com/p1", "b.com", "Analytics", 0.3, word_count=200),
            _page("https://b.com/p2", "b.com", "Analytics", 0.1, word_count=250),
        ]
        pairs = find_candidate_pairs(pages, max_pairs=10)
        used = set()
        for p in pairs:
            assert p.page_treatment not in used
            assert p.page_control not in used
            used.add(p.page_treatment)
            used.add(p.page_control)

    def test_match_covars_included(self):
        pages = [
            _page("https://a.com/p1", "a.com", "A", 0.9, word_count=100, comparison_table=1.0),
            _page("https://b.com/p1", "b.com", "B", 0.1, word_count=200, comparison_table=0.0),
        ]
        pairs = find_candidate_pairs(pages)
        assert len(pairs) == 1
        cov = pairs[0].match_covars
        assert "P_cited_diff" in cov
        assert "content_cosine_sim" in cov

    def test_max_pairs_respected(self):
        pages = [
            _page(f"https://{c}.com/p", f"{c}.com", f"cluster_{i}",
                  0.5 + (i % 3) * 0.2, word_count=100 + i * 10)
            for i, c in enumerate(["a", "b", "c", "d", "e", "f", "g", "h"])
        ]
        pairs = find_candidate_pairs(pages, max_pairs=3)
        assert len(pairs) <= 3

    def test_no_P_cited_still_matches(self):
        pages = [
            _page("https://a.com/p1", "a.com", "A", word_count=100),
            _page("https://b.com/p1", "b.com", "B", word_count=200),
        ]
        pairs = find_candidate_pairs(pages)
        assert len(pairs) == 1

    def test_from_fit_rows(self):
        rows = [
            FitRow(page_url="https://a.com/p1", cluster_id="a.com", P_cited=0.9,
                   features={"word_count": 100, "offpage.x": 5.0}),
            FitRow(page_url="https://b.com/p1", cluster_id="b.com", P_cited=0.1,
                   features={"word_count": 200, "offpage.x": 3.0}),
        ]
        inputs = build_match_inputs_from_fit_rows(rows)
        assert len(inputs) == 2
        assert inputs[0].page_url == "https://a.com/p1"
        assert "word_count" in inputs[0].content_features
        assert "offpage.x" not in inputs[0].content_features
