"""Phase-2 page-matching utilities: form candidate experiment pairs.

These pairs become the treatment/control pairs of the Phase-5 randomized
difference-in-differences experiment. The single most important rule here is the
**spillover guard: pair pages ACROSS different topical clusters, never within
one.** A page's topical cluster is the query group it is cite-tested against
(``measurement.query_id``). Two pages in the same cluster compete for the *same*
query, so if one is treated (edited to win the query) it can cannibalize the
citations of its own control — the control moves *with* the treatment and the
difference-in-differences estimate is biased toward zero (or worse). Matching
*on* topical similarity but pairing *across* clusters is therefore the mitigation:
the control is comparable on rate and content type yet cannot be cannibalized by
its partner because they answer different queries.

We never pool engines (~11% cross-engine overlap): :func:`match_pairs` takes one
engine and pulls per-page pre-period ``p_cited`` from
:func:`src.assembly.assemble_rows` for that engine only. Topical clusters are
derived from *all* measurements (``query_id`` is engine-independent).
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from .assembly import assemble_rows
from .contract import FitRow
from .domains import normalize_url

# Content-type signal: P3's ``page__listicle_vs_prose`` content feature (0=prose,
# 1=listicle). We deliberately use this over the page ``role`` field — ``role`` is
# *ownership* (customer/candidate/competitor), not content type. Values are bucketed
# at 0.5; keep matched fixtures away from the boundary (it is intentionally crisp,
# not fuzzy).
_CONTENT_TYPE_FEATURE = "page__listicle_vs_prose"
_CONTENT_TYPE_THRESHOLD = 0.5


class Pair(BaseModel):
    """One candidate experiment pair (treatment/control slots are provisional).

    ``treatment_page``/``control_page`` are just the two slots in deterministic
    order here; the actual coin-flip randomization happens in Phase 5. ``cluster_a``
    is ``treatment_page``'s primary topical cluster, ``cluster_b`` is
    ``control_page``'s — and they are always different (the spillover guard).
    """

    treatment_page: str
    control_page: str
    cluster_a: str
    cluster_b: str
    match_covars: dict[str, float | str] = Field(default_factory=dict)


def derive_topical_clusters(measurements: list[dict]) -> dict[str, str]:
    """Map normalized ``page_url`` -> primary topical cluster (a ``query_id``).

    The topical cluster is derived purely from the measurement->query grouping —
    there is no ``topical_cluster`` field in the contract. A page measured against
    several queries gets a deterministic **primary**: the sorted-first ``query_id``,
    so the mapping is stable across calls and process runs.
    """
    return {url: min(qids) for url, qids in _query_sets(measurements).items()}


def _query_sets(measurements: list[dict]) -> dict[str, set[str]]:
    """Normalized ``page_url`` -> the full set of ``query_id``s it is tested against."""
    out: dict[str, set[str]] = {}
    for m in measurements:
        page_url = m.get("page_url")
        query_id = m.get("query_id")
        if page_url is None or query_id is None:
            continue
        out.setdefault(normalize_url(page_url), set()).add(query_id)
    return out


def _content_type(row: FitRow) -> str | None:
    raw = row.features.get(_CONTENT_TYPE_FEATURE)
    if raw is None:
        return None
    return "listicle" if raw >= _CONTENT_TYPE_THRESHOLD else "prose"


def match_pairs(
    measurements: list[dict],
    pages: list[dict],
    companies: list[dict],
    *,
    engine: str,
    max_pairs: int | None = None,
    rate_tolerance: float = 0.15,
) -> list[Pair]:
    """Greedily pair pages into cross-cluster, similar-rate, similar-content pairs.

    A valid pair requires, for one ``engine``:
      * **disjoint topical clusters** — the two pages share NO query (spillover
        guard). We compare full query-sets, not just primary clusters, so a
        multi-query page can never sneak a shared query past the guard.
      * **similar pre-period citation rate** — ``|Δp_cited| <= rate_tolerance``.
      * **same content type** when both content-type signals are present (a missing
        signal does not block — it is simply unknown, not a mismatch).

    Same-company pairs are **deprioritized, not excluded**: a different-company
    partner always wins over a same-company one, but a same-company pair is allowed
    as a fallback rather than dropping the pair entirely (the cross-cluster guard is
    the load-bearing constraint; same company + different query is only a soft risk).

    Greedy nearest-rate matching over candidates sorted by ``page_url``; each page is
    used at most once; output is deterministic.
    """
    rows = assemble_rows(measurements, pages, companies, engine=engine)
    query_sets = _query_sets(measurements)
    primary = {url: min(qids) for url, qids in query_sets.items()}

    # Only pages with a known topical cluster can be guarded; sort for determinism.
    candidates = sorted(
        (r for r in rows if r.page_url in query_sets),
        key=lambda r: r.page_url,
    )

    used: set[str] = set()
    pairs: list[Pair] = []
    for a in candidates:
        if a.page_url in used:
            continue
        partner = _best_partner(a, candidates, used, query_sets, rate_tolerance)
        if partner is None:
            continue
        used.add(a.page_url)
        used.add(partner.page_url)
        pairs.append(_build_pair(a, partner, primary))
        if max_pairs is not None and len(pairs) >= max_pairs:
            break
    return pairs


def _best_partner(
    a: FitRow,
    candidates: list[FitRow],
    used: set[str],
    query_sets: dict[str, set[str]],
    rate_tolerance: float,
) -> FitRow | None:
    a_type = _content_type(a)
    best: tuple[int, float, str] | None = None
    best_row: FitRow | None = None
    for b in candidates:
        if b.page_url == a.page_url or b.page_url in used:
            continue
        # Spillover guard: clusters must be fully disjoint (no shared query).
        if query_sets[a.page_url] & query_sets[b.page_url]:
            continue
        rate_gap = abs(a.p_cited - b.p_cited)
        if rate_gap > rate_tolerance:
            continue
        b_type = _content_type(b)
        if a_type is not None and b_type is not None and a_type != b_type:
            continue
        same_company = int(a.company_domain == b.company_domain)
        # Prefer different company, then nearest rate, then url for determinism.
        key = (same_company, rate_gap, b.page_url)
        if best is None or key < best:
            best = key
            best_row = b
    return best_row


def _build_pair(a: FitRow, b: FitRow, primary: dict[str, str]) -> Pair:
    return Pair(
        treatment_page=a.page_url,
        control_page=b.page_url,
        cluster_a=primary[a.page_url],
        cluster_b=primary[b.page_url],
        match_covars={
            "treatment_p_cited": a.p_cited,
            "control_p_cited": b.p_cited,
            "abs_rate_gap": abs(a.p_cited - b.p_cited),
            "treatment_content_type": _content_type(a) or "unknown",
            "control_content_type": _content_type(b) or "unknown",
        },
    )
