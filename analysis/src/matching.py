"""Page-matching utilities — cross-cluster candidate pairs for experiments.

Matches pages by pre-period citation rate (P_cited) and content features,
pairing ACROSS different topical clusters (spillover guard: a treatment
should not cannibalise its own control by competing for the same query).
"""

from typing import Optional
from sklearn.neighbors import NearestNeighbors
from sklearn.preprocessing import StandardScaler
import numpy as np

from src.models import PageMatchInput, MatchPair

CONTENT_MATCH_KEYS = [
    "schema_markup", "comparison_table", "direct_answer_first",
    "listicle_vs_prose", "stats_density", "citation_density",
    "word_count", "heading_structure", "freshness_days",
    "query_term_coverage",
]


def _match_vector(page: PageMatchInput) -> np.ndarray:
    vals = [page.P_cited or 0.0]
    for k in CONTENT_MATCH_KEYS:
        vals.append(page.content_features.get(k, 0.0))
    return np.array(vals, dtype=float)


def find_candidate_pairs(
    pages: list[PageMatchInput],
    max_pairs: int = 10,
    min_distance: float = 0.0,
) -> list[MatchPair]:
    """Build candidate (treatment, control) pairs across topical clusters.

    For each page, finds the nearest neighbour in a *different* topical
    cluster.  Returns at most *max_pairs* pairs, sorted by ascending
    distance (best matches first).  A single page appears in at most one pair.

    Parameters
    ----------
    pages : list of PageMatchInput
        Candidate pages with topical cluster and P_cited.
    max_pairs : int
        Maximum number of pairs to return.
    min_distance : float
        Minimum match distance threshold (pairs closer than this are
        considered too similar and skipped — avoids near-duplicates).
    """
    if len(pages) < 2:
        return []

    ids = [p.page_url for p in pages]
    clusters = [p.topical_cluster for p in pages]
    X = np.array([_match_vector(p) for p in pages])

    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    nn = NearestNeighbors(n_neighbors=min(len(pages), 5), metric="euclidean")
    nn.fit(X_scaled)
    distances, indices = nn.kneighbors(X_scaled)

    used: set[int] = set()
    candidates: list[tuple[float, int, int]] = []  # (distance, i, j)

    for i in range(len(pages)):
        if i in used:
            continue
        for j_idx, j in enumerate(indices[i]):
            if j in used or i == j:
                continue
            if clusters[i] == clusters[j]:
                continue
            d = float(distances[i][j_idx])
            if d < min_distance:
                continue
            candidates.append((d, i, j))
            break

    candidates.sort(key=lambda x: x[0])
    pairs: list[MatchPair] = []
    paired: set[int] = set()

    for d, i, j in candidates:
        if i in paired or j in paired:
            continue
        if len(pairs) >= max_pairs:
            break

        p_a = _match_vector(pages[i])
        p_b = _match_vector(pages[j])
        p_cited_diff = abs(float(p_a[0] - p_b[0]))
        content_cosim = float(
            np.dot(p_a[1:], p_b[1:])
            / (np.linalg.norm(p_a[1:]) * np.linalg.norm(p_b[1:]) + 1e-10)
        )

        pairs.append(
            MatchPair(
                page_treatment=ids[i],
                page_control=ids[j],
                topical_cluster_treatment=clusters[i],
                topical_cluster_control=clusters[j],
                distance=d,
                match_covars={
                    "P_cited_diff": p_cited_diff,
                    "content_cosine_sim": content_cosim,
                    "n_neighbours_checked": float(len(indices[i])),
                },
            )
        )
        paired.add(i)
        paired.add(j)

    return pairs


def build_match_inputs_from_fit_rows(
    rows: list,
    topical_clusters: Optional[dict[str, str]] = None,
) -> list[PageMatchInput]:
    """Build PageMatchInput list from FitRow-like objects.

    Parameters
    ----------
    rows : list of FitRow
        Page-level rows with page_url, cluster_id, P_cited, features.
    topical_clusters : dict of page_url → topical_cluster, optional
        Override cluster assignment.  If omitted, cluster_id is used as
        the topical cluster.
    """
    inputs: list[PageMatchInput] = []
    for r in rows:
        tc = topical_clusters.get(r.page_url, r.cluster_id) if topical_clusters else r.cluster_id
        cf = {k: v for k, v in r.features.items() if k in CONTENT_MATCH_KEYS}
        inputs.append(
            PageMatchInput(
                page_url=r.page_url,
                cluster_id=r.cluster_id,
                topical_cluster=tc,
                P_cited=r.P_cited,
                content_features=cf,
            )
        )
    return inputs
