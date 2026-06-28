"""Domain / URL normalization — P4-local replica of P1's canonical helper.

CONTRACT: outputs must match ``convex/lib/domain.ts`` byte-for-byte. Every join
in this lane keys on the normalized domain/URL, and a mismatch is the #1
silent-failure mode (the CONTRACT.md warning). See that module's docstring for
full behavioral spec.

This replaces the pre-P1 placeholder that only stripped ``www`` and lowercased
the path. The P4-version now:
  - Reduces to eTLD+1 via the same multi-label suffix list (MULTI_LABEL_SUFFIXES).
  - Strips userinfo, port, trailing dots, scheme, and ``www``.
  - For ``normalize_url``: forces ``https://``, preserves PATH CASE, strips
    trailing slash, drops fragment + tracking params, and sorts remaining params.
"""

from __future__ import annotations

import re

MULTI_LABEL_SUFFIXES: frozenset[str] = frozenset({
    "co.uk", "org.uk", "gov.uk", "ac.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk",
    "com.au", "net.au", "org.au", "edu.au", "gov.au", "id.au",
    "co.nz", "net.nz", "org.nz", "govt.nz",
    "co.jp", "or.jp", "ne.jp", "go.jp", "ac.jp",
    "co.in", "net.in", "org.in", "gen.in", "firm.in", "ind.in",
    "co.za", "org.za", "net.za", "gov.za",
    "com.br", "net.br", "org.br", "gov.br",
    "com.mx", "com.sg", "com.hk", "com.tr", "com.cn", "com.tw",
    "co.kr", "or.kr",
})

_TRACKING_PARAMS: list[str] = [
    "utm_*", "gclid", "fbclid", "msclkid", "mc_eid", "igshid", "_hsenc", "_hsmi",
    "mkt_tok", "yclid", "_ga", "ref_src",
]


def _is_tracking_param(key: str) -> bool:
    k = key.lower()
    for pat in _TRACKING_PARAMS:
        if pat.endswith("*"):
            if k.startswith(pat[:-1]):
                return True
        elif k == pat:
            return True
    return False


def _clean_host(value: str) -> str:
    """Extract a lowercased host from a bare host OR a full URL.

    Strips scheme, userinfo, path/query/fragment, port, and a trailing dot.
    Keeps subdomains (incl. ``www``). Returns "" for empty/garbage input.
    """
    if not value:
        return ""
    s = value.strip().lower()
    if not s:
        return ""
    # Strip scheme (http://, https://, or leading //).
    s = re.sub(r"^[a-z][a-z0-9+.-]*://", "", s)
    s = re.sub(r"^//", "", s)
    # Authority ends at the first path/query/fragment delimiter.
    s = re.split(r"[/?#]", s, maxsplit=1)[0]
    # Strip userinfo (user:pass@host).
    at = s.rfind("@")
    if at != -1:
        s = s[at + 1:]
    # Strip port.
    s = s.split(":", 1)[0]
    # Strip trailing dots (fully-qualified form).
    s = re.sub(r"\.+$", "", s)
    return s


def _strip_www(host: str) -> str:
    """Remove a single leading ``www.`` label."""
    return re.sub(r"^www\.", "", host)


def _registrable_domain(host: str) -> str:
    """Reduce a host to its registrable domain (eTLD+1).

    ``blog.acme.co.uk`` -> ``acme.co.uk``; ``acme.com`` -> ``acme.com``.
    Hosts with no dot (e.g. ``localhost``) or IP-like hosts are returned as-is.
    """
    if not host:
        return ""
    labels = host.split(".")
    if len(labels) <= 2:
        return host
    last_two = ".".join(labels[-2:])
    take = 3 if last_two in MULTI_LABEL_SUFFIXES else 2
    return ".".join(labels[-take:])


def normalize_domain(value: str) -> str:
    """Normalize any domain-or-URL input to its registrable domain key (eTLD+1).

    ``https://www.Acme.com/pricing?x=1`` and ``acme.com`` both -> ``acme.com``.
    ``docs.acme.com`` -> ``acme.com``. Returns ``""`` for empty/garbage input.
    """
    if not value:
        return ""
    host = _strip_www(_clean_host(value))
    return _registrable_domain(host)


def normalize_url(value: str) -> str:
    """Normalize a URL to the canonical page key.

    Forces ``https://``, strips ``www``, keeps other subdomains and the path,
    preserves path case, drops fragment + tracking params, sorts remaining
    params. Returns ``""`` for empty/garbage input.
    """
    if not value:
        return ""
    raw = value.strip()
    if not raw:
        return ""

    host = _strip_www(_clean_host(raw))
    if not host:
        return ""

    # Path / query / fragment: everything after the authority, preserved from
    # the ORIGINAL input (case-preserved, not lowered).
    rest = re.sub(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", "", raw)
    rest = re.sub(r"^//", "", rest)
    auth_end = len(rest)
    for i, ch in enumerate(rest):
        if ch in "/?#":
            auth_end = i
            break
    rest = rest[auth_end:] if auth_end < len(rest) else ""

    # Drop fragment.
    hash_idx = rest.find("#")
    if hash_idx != -1:
        rest = rest[:hash_idx]

    # Split path and query.
    path = rest
    query = ""
    q_idx = rest.find("?")
    if q_idx != -1:
        path = rest[:q_idx]
        query = rest[q_idx + 1:]

    # Path: strip trailing slash(es) (root path collapses to "").
    if path == "/" or path == "":
        path = ""
    else:
        path = path.rstrip("/")

    # Query: drop tracking params, sort the rest.
    query_str = ""
    if query:
        kept = []
        for p in query.split("&"):
            p = p.strip()
            if not p:
                continue
            eq = p.find("=")
            key = p[:eq] if eq != -1 else p
            if not _is_tracking_param(key):
                kept.append(p)
        kept.sort()
        if kept:
            query_str = "?" + "&".join(kept)

    return f"https://{host}{path}{query_str}"


def same_domain(a: str, b: str) -> bool:
    """True if the two inputs resolve to the same registrable-domain key."""
    return normalize_domain(a) == normalize_domain(b)
