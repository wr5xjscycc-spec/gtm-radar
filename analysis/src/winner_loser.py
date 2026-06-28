"""Winner/loser row construction — measurement P_cited + labels → modelable rows.

The unit is the **page**, the cluster is the **company**, the outcome is
**P_cited (a rate, not a binary)**.

Key design decisions:
- Page-level and company-level features are kept in separate dicts so the
  model knows which features have tiny effective N (company features inheriting
  per-page look like N rows but are really N companies).
- Every row carries a CI-derived weight: narrower CI = more certainty.
- Rows are grouped per (customer, category, engine) — never pool engines.
- n_companies (distinct cluster_ids) is recorded per group as effective N.
"""

import math
from typing import Optional
from src.models import WeightedFitRow, CategoryEngineTable
from src.rows import CONTENT_FEATURE_KEYS, OFFPAGE_FEATURE_KEYS

EPS = 1e-8


def _ci_weight(ci_low: float, ci_high: float) -> float:
    """Weight inversely proportional to CI width.

    Narrower CI = more certain measurement = higher weight.
    When CI is degenerate (width=0) the weight is set to a large but
    finite value to avoid infinities.
    """
    width = ci_high - ci_low
    if width <= 0 or math.isnan(width):
        return 1000.0
    return 1.0 / width


def _extract_page_features(page: dict) -> dict[str, float]:
    cf = page.get("content_features", {})
    feats: dict[str, float] = {}
    for k in CONTENT_FEATURE_KEYS:
        val = cf.get(k, 0.0)
        if isinstance(val, bool):
            val = 1.0 if val else 0.0
        feats[k] = float(val)
    return feats


def _extract_company_features(company: dict) -> dict[str, float]:
    offpage = company.get("offpage", {})
    feats: dict[str, float] = {}
    for k in OFFPAGE_FEATURE_KEYS:
        val = offpage.get(k, 0.0)
        if val is None:
            val = 0.0
        feats[f"offpage.{k}"] = float(val)
    return feats


def build_modeling_tables(
    measurements: list[dict],
    pages: list[dict],
    companies: list[dict],
) -> list[CategoryEngineTable]:
    """Join measurements → pages → companies and build per-(cat,engine) tables.

    Returns one CategoryEngineTable per (customer_id, category, engine) group
    with n_companies (effective N) and n_rows recorded.
    """
    page_by_url: dict[str, dict] = {p["url"]: p for p in pages}
    company_by_domain: dict[str, dict] = {c["domain"]: c for c in companies}

    groups: dict[tuple[str, str, str], list[WeightedFitRow]] = {}

    for m in measurements:
        page_url = m["page_url"]
        page = page_by_url.get(page_url)
        if page is None:
            continue
        company_domain = page["company_domain"]
        company = company_by_domain.get(company_domain)
        if company is None:
            continue

        p_cited = m.get("P_cited", 0.0) or 0.0
        ci_low = m.get("ci_low", 0.0) or 0.0
        ci_high = m.get("ci_high", 0.0) or 0.0
        weight = _ci_weight(ci_low, ci_high)

        row = WeightedFitRow(
            page_url=page_url,
            cluster_id=company_domain,
            is_winner=p_cited > 0.0,
            P_cited=p_cited,
            ci_low=ci_low,
            ci_high=ci_high,
            weight=weight,
            page_features=_extract_page_features(page),
            company_features=_extract_company_features(company),
        )

        customer_id = m.get("workspaceId", "unknown")
        engine = m.get("engine", "unknown")
        category = company.get("understanding", {}).get("category", "unknown")
        key = (customer_id, category, engine)
        groups.setdefault(key, []).append(row)

    tables: list[CategoryEngineTable] = []
    for (cid, cat, eng), rows in groups.items():
        cluster_ids = {r.cluster_id for r in rows}
        tables.append(
            CategoryEngineTable(
                customer_id=cid,
                category=cat,
                engine=eng,
                rows=rows,
                n_companies=len(cluster_ids),
                n_rows=len(rows),
            )
        )

    return tables


def build_modeling_tables_from_synthetic(
    pages: list[dict],
    companies: list[dict],
    measurements: Optional[list[dict]] = None,
    *,
    default_workspace: str = "ws_synthetic",
    default_engine: str = "openai",
) -> list[CategoryEngineTable]:
    """Build modeling tables from synthetic / test data without full measurements.

    Creates one WeightedFitRow per page with P_cited=0.5, degenerate CI,
    and uniform weight.
    """
    company_by_domain: dict[str, dict] = {c["domain"]: c for c in companies}
    rows_by_key: dict[tuple[str, str, str], list[WeightedFitRow]] = {}

    for p in pages:
        company_domain = p.get("company_domain", "unknown")
        company = company_by_domain.get(company_domain)
        if company is None:
            continue

        customer_id = company.get("workspaceId", default_workspace)
        category = company.get("understanding", {}).get("category", "unknown")

        p_cited = 0.5
        ci_low = 0.25
        ci_high = 0.75

        row = WeightedFitRow(
            page_url=p["url"],
            cluster_id=company_domain,
            is_winner=True,
            P_cited=p_cited,
            ci_low=ci_low,
            ci_high=ci_high,
            weight=_ci_weight(ci_low, ci_high),
            page_features=_extract_page_features(p),
            company_features=_extract_company_features(company),
        )

        key = (customer_id, category, default_engine)
        rows_by_key.setdefault(key, []).append(row)

    tables = []
    for (cid, cat, eng), rows in rows_by_key.items():
        cluster_ids = {r.cluster_id for r in rows}
        tables.append(
            CategoryEngineTable(
                customer_id=cid,
                category=cat,
                engine=eng,
                rows=rows,
                n_companies=len(cluster_ids),
                n_rows=len(rows),
            )
        )
    return tables
