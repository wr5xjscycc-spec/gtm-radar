"""Phase-2 integration: matching + feature pipeline over the real seed fixtures.

Unit tests build records inline; this one drives `matching.match_pairs` and
`features.build_feature_frame` from the actual `tests/fixtures/*.json` (the
stand-in P2/P3 records) to prove the modules, the fixture cluster structure, and
the Phase-1 assembly all agree.

Phase-2 DoD: "real rows assemble; matching produces sensible candidate pairs on
test data" + context (company) features inherit per company.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.features import (
    assert_company_features_inherit,
    build_feature_frame,
    split_feature_kinds,
)
from src.matching import Pair, derive_topical_clusters, match_pairs

FIXTURES = Path(__file__).parent / "fixtures"


def _load(name: str) -> list[dict]:
    return json.loads((FIXTURES / name).read_text())


@pytest.fixture
def records() -> dict[str, list[dict]]:
    return {
        "measurements": _load("measurement.json"),
        "pages": _load("page.json"),
        "companies": _load("company.json"),
    }


def test_fixtures_have_two_topical_clusters(records):
    clusters = derive_topical_clusters(records["measurements"])
    assert set(clusters.values()) == {"qry_seed_001", "qry_seed_002"}


@pytest.mark.parametrize("engine", ["openai", "perplexity"])
def test_matching_produces_cross_cluster_pairs(records, engine):
    pairs = match_pairs(**records, engine=engine)
    assert pairs, f"no candidate pairs for engine={engine}"
    assert all(isinstance(p, Pair) for p in pairs)

    clusters = derive_topical_clusters(records["measurements"])
    used: set[str] = set()
    for p in pairs:
        # Spillover guard: the two pages are in different topical clusters.
        assert clusters[p.treatment_page] != clusters[p.control_page]
        # Comparable pre-period rate (the DoD's "sensible" pairs).
        assert abs(p.match_covars["abs_rate_gap"]) <= 0.15
        # Each page used at most once.
        assert p.treatment_page not in used and p.control_page not in used
        used.update([p.treatment_page, p.control_page])


def test_feature_pipeline_and_inheritance(records):
    frame = build_feature_frame(records["pages"], records["companies"])
    assert len(frame) == len(records["pages"])  # one row per page, no fan-out

    page_cols, company_cols = split_feature_kinds(frame)
    assert page_cols and company_cols
    assert all(c.startswith("page__") for c in page_cols)
    assert all(c.startswith("company__") for c in company_cols)

    # Pseudo-replication invariant: company features identical across a company's pages.
    report = assert_company_features_inherit(frame)
    assert report["ok"], report["violations"]


def test_matching_is_deterministic(records):
    a = match_pairs(**records, engine="openai")
    b = match_pairs(**records, engine="openai")
    key = lambda ps: [(p.treatment_page, p.control_page) for p in ps]
    assert key(a) == key(b)
