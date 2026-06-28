"""Phase-1 integration: the seed fixtures flow through the real assembly pipeline.

This is the cross-component check — the unit tests build records inline, but this
one loads the actual `analysis/tests/fixtures/*.json` (the stand-in P2/P3 records)
and runs them through `assemble_rows -> build_fit_request -> fit_baseline`,
proving the fixture shapes and the pipeline agree.

Phase-1 DoD: "real-shaped rows flow into a baseline fit and back as a model_fit."
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.assembly import assemble_rows, assembly_summary, build_fit_request
from src.baseline import fit_baseline
from src.contract import FitRequest, ModelFit

FIXTURES = Path(__file__).parent / "fixtures"


def _load(name: str) -> list[dict]:
    return json.loads((FIXTURES / name).read_text())


@pytest.fixture
def raw_records() -> dict[str, list[dict]]:
    return {
        "measurements": _load("measurement.json"),
        "pages": _load("page.json"),
        "companies": _load("company.json"),
    }


def test_fixtures_are_referentially_consistent(raw_records):
    """Every measurement points at a real page; every page at a real company."""
    company_domains = {c["domain"] for c in raw_records["companies"]}
    page_urls = {p["url"] for p in raw_records["pages"]}
    for page in raw_records["pages"]:
        assert page["company_domain"] in company_domains
    for m in raw_records["measurements"]:
        assert m["page_url"] in page_urls


@pytest.mark.parametrize("engine", ["openai", "perplexity"])
def test_assemble_then_baseline_roundtrip(raw_records, engine):
    rows = assemble_rows(**raw_records, engine=engine)
    assert rows, f"no rows assembled for engine={engine}"

    # Every row carries its company cluster id and per-engine isolation holds.
    assert all(r.company_domain for r in rows)
    summary = assembly_summary(rows)
    assert summary["n_companies"] == 3  # acme, globex, initech
    assert summary["n_rows"] >= summary["n_companies"]  # >=2 pages/company => pseudo-replication

    req = build_fit_request(
        **raw_records,
        customer_id="ws_seed_001",
        category="ai-sales-tools",
        engine=engine,
    )
    assert isinstance(req, FitRequest)
    assert req.n_companies() == 3

    metrics, fit = fit_baseline(req)
    # A valid model_fit comes back out (DoD), JSON-round-trippable for Convex.
    assert isinstance(fit, ModelFit)
    assert fit.engine == engine
    assert fit.n_companies == 3
    assert {c.feature for c in fit.coefficients}  # at least one feature modeled
    assert json.loads(fit.model_dump_json())  # no NaN/Inf leaks to the wire
    assert metrics.n_rows == fit.n_rows


def test_engines_not_pooled(raw_records):
    """openai and perplexity assemble independently — never merged into one set."""
    oa = assemble_rows(**raw_records, engine="openai")
    px = assemble_rows(**raw_records, engine="perplexity")
    assert len(oa) > 0 and len(px) > 0
    # Same pages measured on both engines, but P(cited) differs per engine, so the
    # assembled outcomes must not be identical across engines.
    oa_by_url = {r.page_url: r.p_cited for r in oa}
    px_by_url = {r.page_url: r.p_cited for r in px}
    shared = set(oa_by_url) & set(px_by_url)
    assert shared, "expected overlapping pages across engines in the fixture"
    assert any(oa_by_url[u] != px_by_url[u] for u in shared)
