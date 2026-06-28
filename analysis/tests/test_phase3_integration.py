"""Phase-3 integration: both category fixtures -> per-(category,engine) tables.

Unit tests build records inline; this drives `rows.build_modeling_tables` over the
two real fixture categories (`ai-sales-tools` + `crm-software`) to prove the
labeling, the per-category/per-engine grouping, effective-N, and case-control
exclusion all agree on real-shaped data.

Phase-3 DoD: clean per-category, per-engine row tables with effective-N recorded,
ready to fit.
"""

from __future__ import annotations

import json
from pathlib import Path

from src.rows import ModelingTable, build_modeling_tables

FIXTURES = Path(__file__).parent / "fixtures"


def _load(name: str) -> list[dict]:
    return json.loads((FIXTURES / name).read_text())


def _all_records() -> dict[str, list[dict]]:
    # Combine the original (ai-sales-tools) and crm-software fixture sets the way
    # Phase 3 actually consumes them.
    return {
        "measurements": _load("measurement.json") + _load("measurement_crm.json"),
        "pages": _load("page.json") + _load("page_crm.json"),
        "companies": _load("company.json") + _load("company_crm.json"),
    }


def test_tables_keyed_per_category_and_engine():
    tables = build_modeling_tables(**_all_records())
    keys = set(tables)
    assert keys == {
        ("ai-sales-tools", "openai"),
        ("ai-sales-tools", "perplexity"),
        ("crm-software", "openai"),
        ("crm-software", "perplexity"),
    }


def test_each_table_is_clean_and_fit_ready():
    tables = build_modeling_tables(**_all_records())
    for (category, engine), table in tables.items():
        assert isinstance(table, ModelingTable)
        assert table.category == category and table.engine == engine
        assert table.rows, f"empty table for {category}/{engine}"
        # Effective N = distinct companies, never more than the 3 per category.
        assert 1 <= table.n_companies <= 3
        assert table.n_rows == len(table.rows)
        assert table.n_rows >= table.n_companies
        # Only case-control labels survive — nothing unlabeled leaks through.
        assert all(r.label in {"winner", "loser"} for r in table.rows)
        # Both classes present so a classifier has signal.
        labels = {r.label for r in table.rows}
        assert labels == {"winner", "loser"}, f"{category}/{engine}: {labels}"


def test_not_considered_pages_excluded():
    """`vortex.example/changelog` is appeared=False everywhere -> never a row."""
    tables = build_modeling_tables(**_all_records())
    for table in tables.values():
        assert all("changelog" not in r.page_url for r in table.rows)


def test_effective_n_below_row_count_somewhere():
    """At least one table has a company contributing >1 page (pseudo-replication)."""
    tables = build_modeling_tables(**_all_records())
    assert any(t.n_companies < t.n_rows for t in tables.values())
