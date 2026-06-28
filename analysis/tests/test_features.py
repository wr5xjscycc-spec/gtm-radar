"""Phase-2 feature-pipeline tests (records built inline — no fixtures/ dependency)."""

from __future__ import annotations

import pandas as pd

from src.features import (
    assert_company_features_inherit,
    build_feature_frame,
    split_feature_kinds,
)


def _company(domain: str, *, g2: bool = True, backlinks: float = 0.5) -> dict:
    return {
        "domain": domain,
        "name": domain.split(".")[0],
        "role": "competitor",
        "firmographics": {
            "headcount_growth": 0.2,
            "tech_stack": ["next", "vercel"],  # list -> dropped, but count derived
        },
        "offpage": {"g2_presence": g2, "backlink_density": backlinks},
    }


def _page(company_domain: str, url: str, *, word_count: int = 1200) -> dict:
    return {
        "company_domain": company_domain,
        "url": url,
        "role": "candidate",
        "content_features": {
            "word_count": word_count,
            "schema_markup": True,
            "comparison_table": False,
            "listicle_vs_prose": "prose",  # string -> dropped
        },
    }


def _records() -> tuple[list[dict], list[dict]]:
    companies = [_company("acme.com"), _company("globex.com")]
    pages = [
        _page("acme.com", "https://acme.com/pricing"),
        _page("acme.com", "https://acme.com/features"),  # 2nd page -> pseudo-replication
        # messy company_domain (the JOIN KEY) must still resolve to globex.com
        _page("https://WWW.Globex.com/", "https://www.globex.com/home/"),
    ]
    return pages, companies


def test_one_row_per_page_with_namespaced_features():
    pages, companies = _records()
    frame = build_feature_frame(pages, companies)
    assert len(frame) == 3
    assert set(frame["page_url"]) == {
        "acme.com/pricing",
        "acme.com/features",
        "globex.com/home",
    }
    row = frame[frame["page_url"] == "acme.com/pricing"].iloc[0]
    assert row["page__word_count"] == 1200.0
    assert row["page__schema_markup"] == 1.0  # bool -> 1.0
    assert row["company__headcount_growth"] == 0.2
    assert row["company__g2_presence"] == 1.0  # bool -> 1.0


def test_join_uses_normalized_domain_key():
    pages, companies = _records()
    frame = build_feature_frame(pages, companies)
    globex = frame[frame["page_url"] == "globex.com/home"].iloc[0]
    # messy "https://WWW.Globex.com/" company_domain resolved to globex.com and
    # picked up globex's company features
    assert globex["company_domain"] == "globex.com"
    assert globex["company__backlink_density"] == 0.5


def test_non_numeric_company_field_dropped_and_count_derived():
    pages, companies = _records()
    frame = build_feature_frame(pages, companies)
    assert "company__tech_stack" not in frame.columns  # raw list never present
    assert "page__listicle_vs_prose" not in frame.columns  # raw string never present
    # the list is converted to a documented numeric instead of being lost
    assert (frame["company__tech_stack_count"] == 2.0).all()


def test_split_feature_kinds_partitions_by_prefix():
    pages, companies = _records()
    frame = build_feature_frame(pages, companies)
    page_cols, company_cols = split_feature_kinds(frame)
    assert all(c.startswith("page__") for c in page_cols)
    assert all(c.startswith("company__") for c in company_cols)
    assert "page__word_count" in page_cols
    assert "company__g2_presence" in company_cols
    # identity columns are not features
    assert "page_url" not in page_cols + company_cols
    assert "company_domain" not in page_cols + company_cols


def test_company_features_inherit_ok_when_consistent():
    pages, companies = _records()
    frame = build_feature_frame(pages, companies)
    report = assert_company_features_inherit(frame)
    assert report["ok"] is True
    assert report["violations"] == []


def test_company_features_inherit_flags_planted_violation():
    pages, companies = _records()
    frame = build_feature_frame(pages, companies)
    # plant a mismatch: acme's two pages now disagree on a company feature
    acme_idx = frame.index[frame["company_domain"] == "acme.com"].tolist()
    frame.loc[acme_idx[0], "company__backlink_density"] = 0.99
    report = assert_company_features_inherit(frame)
    assert report["ok"] is False
    offenders = {(v["company_domain"], v["feature"]) for v in report["violations"]}
    assert ("acme.com", "company__backlink_density") in offenders


def test_missing_company_page_dropped_and_recorded():
    companies = [_company("acme.com")]
    pages = [
        _page("acme.com", "https://acme.com/pricing"),
        _page("orphan.com", "https://orphan.com/blog"),  # no matching company
    ]
    frame = build_feature_frame(pages, companies)
    assert set(frame["page_url"]) == {"acme.com/pricing"}
    assert frame.attrs["dropped_pages"] == ["orphan.com/blog"]


def test_inherit_check_handles_empty_frame():
    frame = build_feature_frame([], [])
    assert isinstance(frame, pd.DataFrame)
    assert assert_company_features_inherit(frame) == {"ok": True, "violations": []}
