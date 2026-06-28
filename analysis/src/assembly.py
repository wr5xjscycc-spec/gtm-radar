"""Phase-1 row assembly: raw Convex records -> page-level modeling rows.

The unit is the **page**; the cluster is the **company** (``company_domain``).
Carrying the cluster id on every row from the start is non-negotiable — effective
N is the number of companies, not rows (pseudo-replication), and retrofitting the
cluster id later is painful (P4 Phase 1/3 gotchas).

Engines are never pooled (~11% cross-engine overlap): :func:`assemble_rows` takes
exactly one engine and filters measurements to it.

Joins key on normalized domain/URL via :mod:`src.domains` (a P4-local replica of
P1's canonical helper — see that module's note).
"""

from __future__ import annotations

import math
from typing import Any

import pandas as pd

from .contract import FitRequest, FitRow
from .domains import normalize_domain, normalize_url

# Outcome binarization / aggregation are intentionally simple here; the real
# P_cited handling and case-control labels arrive with P2·3 / P4·3.
_PAGE_PREFIX = "page__"
_COMPANY_PREFIX = "company__"


def _finite_or_none(value: Any) -> float | None:
    if value is None:
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _numeric_features(source: dict[str, Any], prefix: str) -> dict[str, float]:
    """Keep only numeric/boolean feature values, namespaced by ``prefix``.

    ``bool`` is a subclass of ``int`` so ``float(True) == 1.0`` falls out for free.
    Strings/lists/None are dropped — the model only consumes floats.
    """
    out: dict[str, float] = {}
    for name, raw in source.items():
        if isinstance(raw, bool) or isinstance(raw, (int, float)):
            f = float(raw)
            if math.isfinite(f):
                out[f"{prefix}{name}"] = f
    return out


def _as_dict(value: Any) -> dict[str, Any]:
    # A missing nested block comes back from pandas as NaN (a float, truthy) — guard
    # by type, not ``or {}``, so we never call .items() on a non-dict.
    return value if isinstance(value, dict) else {}


def _merged_features(page_row: dict[str, Any], company_row: dict[str, Any]) -> dict[str, float]:
    features: dict[str, float] = {}
    features.update(_numeric_features(_as_dict(page_row.get("content_features")), _PAGE_PREFIX))
    # Company-level numeric signals live nested under firmographics + offpage. They
    # are inherited across this company's pages -> tiny effective N (pseudo-replication);
    # the company__ namespace lets the later model treat them with that suspicion.
    for block in ("firmographics", "offpage"):
        features.update(_numeric_features(_as_dict(company_row.get(block)), _COMPANY_PREFIX))
    return features


def assemble_rows(
    measurements: list[dict],
    pages: list[dict],
    companies: list[dict],
    *,
    engine: str,
) -> list[FitRow]:
    """Join measurement -> page -> company into page-level :class:`FitRow` rows.

    One row per page (measurements are aggregated by page across queries: mean
    P_cited / ci bounds), filtered to a single ``engine``. ``label`` is ``None`` —
    case-control winner/loser labels arrive in P2·3 / P4·3.
    """
    if not measurements:
        return []

    df_m = pd.DataFrame(measurements)
    df_m = df_m[df_m["engine"] == engine]
    if df_m.empty:
        return []

    # P_cited may arrive snake- or Pascal-cased depending on the aggregate source.
    p_col = "p_cited" if "p_cited" in df_m.columns else "P_cited"
    df_m["_url"] = df_m["page_url"].map(normalize_url)

    agg: dict[str, str] = {p_col: "mean"}
    for col in ("ci_low", "ci_high"):
        if col in df_m.columns:
            agg[col] = "mean"
    df_m = df_m.groupby("_url", as_index=False).agg(agg)

    df_p = pd.DataFrame(pages)
    df_p["_url"] = df_p["url"].map(normalize_url)
    df_p["_domain"] = df_p["company_domain"].map(normalize_domain)

    df_c = pd.DataFrame(companies)
    df_c["_domain"] = df_c["domain"].map(normalize_domain)

    joined = df_m.merge(df_p, on="_url", how="inner", suffixes=("_m", "_p"))
    joined = joined.merge(df_c, on="_domain", how="inner", suffixes=("_p", "_c"))

    rows: list[FitRow] = []
    for rec in joined.to_dict(orient="records"):
        p_cited = _finite_or_none(rec.get(p_col))
        if p_cited is None:
            continue
        p_cited = min(1.0, max(0.0, p_cited))

        ci_width = None
        ci_low, ci_high = _finite_or_none(rec.get("ci_low")), _finite_or_none(rec.get("ci_high"))
        if ci_low is not None and ci_high is not None:
            ci_width = max(0.0, ci_high - ci_low)

        rows.append(
            FitRow(
                page_url=rec["_url"],
                company_domain=rec["_domain"],  # cluster id == normalized company domain
                p_cited=p_cited,
                ci_width=ci_width,
                label=None,
                features=_merged_features(rec, rec),
            )
        )
    return rows


def build_fit_request(
    measurements: list[dict],
    pages: list[dict],
    companies: list[dict],
    *,
    customer_id: str,
    category: str,
    engine: str,
    prior_version: str = "phase1-baseline-v0",
) -> FitRequest:
    """Assemble rows and wrap them in a :class:`FitRequest` for one (category, engine)."""
    rows = assemble_rows(measurements, pages, companies, engine=engine)
    return FitRequest(
        customer_id=customer_id,
        category=category,
        engine=engine,
        prior_version=prior_version,
        rows=rows,
    )


def assembly_summary(rows: list[FitRow]) -> dict:
    """Pipeline shape: row count and **effective N** (distinct companies)."""
    return {
        "n_rows": len(rows),
        "n_companies": len({row.company_domain for row in rows}),
    }
