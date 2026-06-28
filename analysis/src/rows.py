"""Phase-3 winner/loser row construction: per-category, per-engine modeling tables.

Takes raw ``measurement`` + ``page`` + ``company`` records and produces clean tables
keyed by ``(category, engine)`` ready for the Phase-4 Bayesian fit. The unit is the
**page**, the cluster is the **company** (``company_domain``), the outcome is
**P(cited)** (a rate, not a binary), and rows are labeled by the case-control rule
from :mod:`src.labeling` (winner / loser; not-considered pages are excluded).

Non-negotiables encoded here (P4 Phase 3):
- **Never pool engines** (~11% cross-engine overlap): we assemble + label per engine.
- **Effective N = distinct companies**, not row count (pseudo-replication) — reported
  as ``n_companies`` per table.
- Page-level (``page__``) and company-level (``company__``) features stay namespaced
  and distinguishable (carried through from :func:`src.assembly.assemble_rows`).

Category comes from each page's company ``understanding.category``. Labeling joins a
``FitRow`` back to its measurement(s): ``FitRow`` carries P(cited) but not
``appeared``/``cited``, so labels are computed directly from the raw measurements
(keyed on normalized ``page_url``) and joined to rows.
"""

from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

from .assembly import assemble_rows
from .domains import normalize_domain, normalize_url
from .labeling import case_control_label, ci_weight


class RowRecord(BaseModel):
    """One labeled, weighted modeling row. ``p_cited`` (the rate) is kept alongside
    the case-control ``label`` — the outcome the model fits is the rate, not the
    binary label."""

    page_url: str
    company_domain: str = Field(..., description="cluster id; effective-N unit")
    p_cited: float = Field(..., ge=0.0, le=1.0)
    label: Literal["winner", "loser"]
    weight: float = Field(..., description="certainty weight from CI width (see ci_weight)")
    features: dict[str, float] = Field(default_factory=dict)


class ModelingTable(BaseModel):
    """One per-category, per-engine modeling table (never pools engines)."""

    category: str
    engine: str
    rows: list[RowRecord]
    n_companies: int = Field(..., description="effective N — distinct companies, NOT row count")
    n_rows: int


def _category_by_company(companies: list[dict]) -> dict[str, str]:
    """Map normalized company domain -> ``understanding.category``."""
    out: dict[str, str] = {}
    for company in companies:
        domain = normalize_domain(company.get("domain", ""))
        understanding = company.get("understanding")
        understanding = understanding if isinstance(understanding, dict) else {}
        category = understanding.get("category")
        if domain and category:
            out[domain] = category
    return out


def _labels_by_page(measurements: list[dict], engine: str) -> dict[str, Optional[str]]:
    """Roll measurements up to one case-control label per page for ``engine``.

    A page has many measurements (one per query). Page-level rollup: a page that
    wins on *any* query is a winner; a page that never wins but was *considered*
    (appeared) on at least one query is a loser; a page never considered is None
    (excluded). This is exactly ``case_control_label(any(appeared), any(cited))``,
    keeping it consistent with the single-measurement rule.
    """
    appeared_any: dict[str, bool] = {}
    cited_any: dict[str, bool] = {}
    for m in measurements:
        if m.get("engine") != engine:
            continue
        url = normalize_url(m.get("page_url", ""))
        appeared_any[url] = appeared_any.get(url, False) or bool(m.get("appeared"))
        cited_any[url] = cited_any.get(url, False) or bool(m.get("cited"))
    return {
        url: case_control_label(appeared_any[url], cited_any.get(url, False))
        for url in appeared_any
    }


def build_modeling_tables(
    measurements: list[dict],
    pages: list[dict],
    companies: list[dict],
    *,
    engines: tuple[str, ...] = ("openai", "perplexity"),
) -> dict[tuple[str, str], ModelingTable]:
    """Build ``(category, engine) -> ModelingTable`` from raw records.

    Per engine (never pooled): assemble page-level rows, attach the case-control
    label + CI-derived weight, drop rows whose label is None (not in the considered
    pool) and rows whose company has no category, then group by (category, engine).
    """
    category_by_company = _category_by_company(companies)
    grouped: dict[tuple[str, str], list[RowRecord]] = {}

    for engine in engines:
        rows = assemble_rows(measurements, pages, companies, engine=engine)
        labels = _labels_by_page(measurements, engine)
        for row in rows:
            label = labels.get(row.page_url)
            if label is None:  # not-considered (appeared=False) -> excluded, not a loser
                continue
            category = category_by_company.get(row.company_domain)
            if category is None:  # no category to slice on -> intentionally skipped
                continue
            record = RowRecord(
                page_url=row.page_url,
                company_domain=row.company_domain,
                p_cited=row.p_cited,
                label=label,
                weight=ci_weight(row.ci_width),
                features=row.features,
            )
            grouped.setdefault((category, engine), []).append(record)

    tables: dict[tuple[str, str], ModelingTable] = {}
    for (category, engine), records in grouped.items():
        tables[(category, engine)] = ModelingTable(
            category=category,
            engine=engine,
            rows=records,
            n_companies=len({r.company_domain for r in records}),
            n_rows=len(records),
        )
    return tables


def table_summary(tables: dict[tuple[str, str], ModelingTable]) -> dict[str, Any]:
    """Compact shape report: per-table ``n_rows`` / ``n_companies`` keyed by 'category/engine'."""
    return {
        f"{cat}/{eng}": {"n_rows": t.n_rows, "n_companies": t.n_companies}
        for (cat, eng), t in tables.items()
    }
