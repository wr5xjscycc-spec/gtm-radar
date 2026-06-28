"""Phase-2 feature pipeline: join page (content) + company (off-page/firmographic)
features on normalized domain into one feature vector per page.

The unit is the **page**; the cluster is the **company** (``company_domain``).
Company-level features (off-page + firmographics) are **inherited across every
page of a company** — they are identical on each of that company's rows. That
duplication adds NO information: their effective N is the number of *companies*
(~20–40), not the number of page rows (pseudo-replication, the #2 non-negotiable
intelligence fact). Carrying them per page is a layout convenience for the model,
not extra evidence; the model must treat ``company__*`` coefficients with the
suspicion of that tiny effective N. :func:`assert_company_features_inherit`
verifies the invariant the builder enforces by construction.

Namespacing matches :mod:`src.assembly` exactly (``page__`` / ``company__``,
booleans→0/1, non-numeric values dropped) so the two feature representations stay
consistent — we reuse that module's merge helpers rather than re-deriving them and
risking silent drift.
"""

from __future__ import annotations

import warnings
from typing import Any

import pandas as pd

# Reuse the single source of truth for the merge convention (same prefixes,
# bool→float, non-numeric dropped). Within-lane import; does not modify assembly.
from .assembly import _COMPANY_PREFIX, _PAGE_PREFIX, _as_dict, _numeric_features
from .domains import normalize_domain, normalize_url


def _company_features(company: dict[str, Any]) -> dict[str, float]:
    """Numeric ``company__*`` block for one company (computed once, then inherited).

    Off-page + firmographic numerics/booleans pass through the shared helper;
    ``tech_stack`` is a list (dropped by that helper) so we derive a numeric
    ``company__tech_stack_count`` from it instead of losing the signal.
    """
    features: dict[str, float] = {}
    for block in ("firmographics", "offpage"):
        features.update(_numeric_features(_as_dict(company.get(block)), _COMPANY_PREFIX))

    tech_stack = _as_dict(company).get("firmographics")
    stack = tech_stack.get("tech_stack") if isinstance(tech_stack, dict) else None
    if isinstance(stack, (list, tuple, set)):
        features[f"{_COMPANY_PREFIX}tech_stack_count"] = float(len(stack))
    return features


def build_feature_frame(pages: list[dict], companies: list[dict]) -> pd.DataFrame:
    """One row per page: ``page_url`` + ``company_domain`` + ``page__*`` / ``company__*``.

    Joins each page to its company on the **normalized domain** (the join key here,
    via :mod:`src.domains`) so a messy ``company_domain`` like ``https://WWW.X.com/``
    still resolves to ``x.com``. Company features are looked up per normalized
    domain and broadcast onto every page of that company — guaranteeing one row per
    page *and* the inheritance invariant by construction (a ``pd.merge`` would
    fan-out page rows if two company records shared a normalized domain).

    Pages whose company is missing are **dropped**; their normalized URLs are
    recorded on ``frame.attrs["dropped_pages"]`` and a warning is emitted.
    """
    company_lookup: dict[str, dict[str, float]] = {}
    for company in companies:
        domain = normalize_domain(company.get("domain", ""))
        if domain:
            company_lookup[domain] = _company_features(company)

    records: list[dict[str, Any]] = []
    dropped: list[str] = []
    for page in pages:
        domain = normalize_domain(page.get("company_domain", ""))
        page_url = normalize_url(page.get("url", ""))
        if domain not in company_lookup:
            dropped.append(page_url)
            continue
        row: dict[str, Any] = {"page_url": page_url, "company_domain": domain}
        row.update(_numeric_features(_as_dict(page.get("content_features")), _PAGE_PREFIX))
        row.update(company_lookup[domain])
        records.append(row)

    if dropped:
        warnings.warn(
            f"build_feature_frame dropped {len(dropped)} page(s) with no matching company",
            stacklevel=2,
        )

    frame = pd.DataFrame.from_records(records)
    frame.attrs["dropped_pages"] = dropped
    return frame


def split_feature_kinds(frame: pd.DataFrame) -> tuple[list[str], list[str]]:
    """Partition feature columns by prefix → ``(page_level, company_level)``.

    Lets the model know which features carry the company's tiny effective N
    (``company__*``) versus per-page evidence (``page__*``). Identity columns
    (``page_url`` / ``company_domain``) are not features and are excluded.
    """
    page_cols = [c for c in frame.columns if c.startswith(_PAGE_PREFIX)]
    company_cols = [c for c in frame.columns if c.startswith(_COMPANY_PREFIX)]
    return page_cols, company_cols


def assert_company_features_inherit(frame: pd.DataFrame) -> dict[str, Any]:
    """Verify every ``company__*`` value is constant across a company's pages.

    This is the pseudo-replication invariant: company-level features are inherited
    identically across that company's page rows. Returns
    ``{"ok": bool, "violations": [...]}`` (does not raise) so callers/tests can
    inspect. An all-NaN company block counts as inherited (``dropna=False``).
    """
    _, company_cols = split_feature_kinds(frame)
    violations: list[dict[str, Any]] = []

    if company_cols and not frame.empty:
        for domain, group in frame.groupby("company_domain"):
            for col in company_cols:
                if group[col].nunique(dropna=False) > 1:
                    violations.append(
                        {
                            "company_domain": domain,
                            "feature": col,
                            "values": sorted(group[col].dropna().unique().tolist()),
                        }
                    )

    return {"ok": not violations, "violations": violations}
