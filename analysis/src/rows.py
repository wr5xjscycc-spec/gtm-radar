"""Row assembly — measurement ↔ page ↔ company join → page-level FitRows."""

from typing import Any
from src.models import FitJobRequest, FitRow

CONTENT_FEATURE_KEYS = [
    "schema_markup", "comparison_table", "word_count",
    "heading_structure", "freshness_days", "query_term_coverage",
    "direct_answer_first", "stats_density", "citation_density",
    "listicle_vs_prose",
]

OFFPAGE_FEATURE_KEYS = [
    "thirdparty_mentions", "reddit_presence", "g2_presence",
    "brand_search_volume", "wikipedia_presence", "review_site_presence",
]


def _bool_to_float(v: Any) -> float:
    return 1.0 if v else 0.0


def _safe_float(v: Any) -> float:
    if v is None:
        return 0.0
    return float(v)


def _extract_features(page: dict, company: dict) -> dict[str, float]:
    features: dict[str, float] = {}
    cf = page.get("content_features", {})
    for k in CONTENT_FEATURE_KEYS:
        val = cf.get(k, 0.0)
        if isinstance(val, bool):
            val = _bool_to_float(val)
        features[k] = float(val)
    offpage = company.get("offpage", {})
    for k in OFFPAGE_FEATURE_KEYS:
        val = offpage.get(k, 0.0)
        features[f"offpage.{k}"] = _safe_float(val)
    return features


def build_fit_requests(
    measurements: list[dict],
    pages: list[dict],
    companies: list[dict],
) -> list[FitJobRequest]:
    """Join measurements → pages → companies and group by (customer_id, category, engine).

    Returns one FitJobRequest per (customer_id, understanding.category, engine) group.
    """
    page_by_url: dict[str, dict] = {p["url"]: p for p in pages}
    company_by_domain: dict[str, dict] = {c["domain"]: c for c in companies}

    groups: dict[tuple[str, str, str], list[FitRow]] = {}

    for m in measurements:
        page_url = m["page_url"]
        page = page_by_url.get(page_url)
        if page is None:
            continue
        company_domain = page["company_domain"]
        company = company_by_domain.get(company_domain)
        if company is None:
            continue

        f = _extract_features(page, company)

        row = FitRow(
            page_url=page_url,
            cluster_id=company_domain,
            P_cited=m.get("P_cited"),
            features=f,
        )

        customer_id = m.get("workspaceId", "unknown")
        engine = m.get("engine", "unknown")
        category = company.get("understanding", {}).get(
            "category", "unknown"
        )
        key = (customer_id, category, engine)
        groups.setdefault(key, []).append(row)

    return [
        FitJobRequest(customer_id=cid, category=cat, engine=eng, rows=rows)
        for (cid, cat, eng), rows in groups.items()
    ]


def assemble_fit_rows_to_frame(rows: list[FitRow]):
    """Convert a list of FitRow into X (feature matrix) and y (target).

    Rows without P_cited are excluded from y but kept for X.
    Returns (X, y, feature_names, cluster_ids).
    """
    import pandas as pd

    records = []
    for r in rows:
        rec = dict(r.features)
        rec["_P_cited"] = r.P_cited
        rec["_cluster_id"] = r.cluster_id
        records.append(rec)

    df = pd.DataFrame(records)
    feature_names = [c for c in df.columns if not c.startswith("_")]
    cluster_ids = df["_cluster_id"].tolist()

    if df["_P_cited"].notna().any():
        y = df["_P_cited"].fillna(0.5).values
    else:
        y = None

    X = df[feature_names].fillna(0).values
    return X, y, feature_names, cluster_ids
